"""
Workflow Agent for the local TissueLab service.

Adapted from the ctrl-service workflow agent. The training-data collection,
per-user Firestore knowledge base, and Tinker provider have all been
removed for the local build — only the OpenAI provider remains, and the
agent runs without user context.
"""

import os
from typing import Dict, Any, Optional, List, Tuple, Iterator
import json
import numpy as np
from openai import OpenAI
import copy
import threading
from datetime import datetime, timezone
from app.services.model_store import model_store
from app.services.providers import LLMProvider, OpenAIProvider
import aiohttp


class _NoOpTrainingCollector:
    """Stub replacement for the cloud training-data collector.

    Every collect_* method is a no-op so the rest of the agent code can stay
    structurally identical to the upstream version without touching Firestore.
    """

    def __getattr__(self, name: str):
        def _noop(*_args, **_kwargs):
            return None
        return _noop


# PROMPTS_DIR points at sibling `prompts/` (workflow_agent.py lives in
# app/services/agent/, prompts live in app/services/agent/prompts/).
PROMPTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prompts")
SCRIPTS_GCS_BASE_URL = "https://storage.googleapis.com/tissuelab-2025.firebasestorage.app/scripts"

def _read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _extract_code_from_markdown(raw_text: str) -> str:
    """
    Extract Python code from markdown code blocks.
    
    Looks for code blocks marked with ```python, ```py, or just ```.
    If multiple code blocks are found, returns the longest one (most likely the main code).
    If no code blocks are found, returns the original text (fallback for edge cases).
    
    Args:
        raw_text: Raw response text that may contain markdown code blocks
        
    Returns:
        Extracted Python code string
    """
    if not raw_text:
        return ""
    
    import re
    
    # Pattern to match markdown code blocks: ```python, ```py, or just ```
    # Uses non-greedy matching with DOTALL to capture multi-line code
    code_block_pattern = r'```(?:python|py)?\s*\n?(.*?)```'
    matches = re.findall(code_block_pattern, raw_text, re.DOTALL | re.IGNORECASE)
    
    if matches:
        # If multiple code blocks found, return the longest one (most likely the main code)
        code = max(matches, key=len).strip()
        return code
    
    # Fallback: if no code blocks found, return original text
    # This handles edge cases where LLM returns code without markdown fences
    return raw_text.strip()

class WorkflowAgent:

    def __init__(self):
        # Legacy OpenAI client (for web search)
        self.client = OpenAI()
        
        # Initialize providers
        self._init_providers()
        
        # Model configuration (with provider routing)
        self.model_router = os.getenv("OPENAI_MODEL_ROUTER", "gpt-5.2")
        self.model_chat = os.getenv("CHAT_MODEL", "gpt-5.2")
        self.model_workflow = os.getenv("WORKFLOW_MODEL", "gpt-5.2")
        self.model_code = os.getenv("CODE_MODEL", "gpt-5.2")
        self.model_ranking = os.getenv("RANKING_MODEL", "gpt-5.2")
        
        # Load prompts
        self.prompt_workflow = _read_text(os.path.join(PROMPTS_DIR, "workflow_system_prompt.txt"))
        self.prompt_code = _read_text(os.path.join(PROMPTS_DIR, "code_system_prompt.txt"))
        selection_path = os.path.join(PROMPTS_DIR, "workflow_selection_prompt.txt")
        self.prompt_workflow_selection = _read_text(selection_path) if os.path.exists(selection_path) else (
            "You evaluate implementation candidates for a workflow step and select the best option."
        )
        chat_path = os.path.join(PROMPTS_DIR, "chat_system_prompt.txt")
        self.prompt_chat = _read_text(chat_path) if os.path.exists(chat_path) else (
            "You are TLAgent, or TissueLab Agent. You are a helpful assistant that guides clinicians in using our medical imaging analysis platform TissueLab. You can help answer user questions, create workflows, and analyze the results. Answer briefly and help users interact with our platform. If an active Zarr file is available, propose and run the minimal workflow without asking for uploads."
        )
        router_path = os.path.join(PROMPTS_DIR, "router_system_prompt.txt")
        self.prompt_router = _read_text(router_path) if os.path.exists(router_path) else None
        
        # Cache for scripts metadata (refreshed periodically)
        self._scripts_metadata_cache = None
        self._scripts_cache_timestamp = 0
        
        # Training collection disabled in the local build (no Firestore writes).
        self.training_collector = _NoOpTrainingCollector()
        self.enable_training_collection = False
    
    def _init_providers(self):
        """Initialize the OpenAI provider (Tinker dropped in local build)."""
        self.openai_provider = OpenAIProvider(self.client)
        self.router_provider_name = "openai"
        self.chat_provider_name = "openai"
        self.workflow_provider_name = "openai"
        self.code_provider_name = "openai"
        self.ranking_provider_name = "openai"

    def _get_provider(self, provider_name: str) -> LLMProvider:
        """Local build only supports OpenAI."""
        return self.openai_provider

    async def _fetch_scripts_metadata(self) -> List[Dict[str, Any]]:
        """
        Fetch scripts metadata from GCS.
        Returns list of script metadata dicts.
        Caches result for 1 hour to avoid excessive fetches.
        """
        import time
        
        # Check cache (1 hour TTL)
        current_time = time.time()
        if self._scripts_metadata_cache and (current_time - self._scripts_cache_timestamp) < 3600:
            return self._scripts_metadata_cache
        
        try:
            metadata_url = f"{SCRIPTS_GCS_BASE_URL}/metadata.json"
            async with aiohttp.ClientSession() as session:
                async with session.get(metadata_url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        scripts = data.get("scripts", [])
                        # Update cache
                        self._scripts_metadata_cache = scripts
                        self._scripts_cache_timestamp = current_time
                        print(f"[agent_service] Loaded {len(scripts)} scripts from GCS metadata")
                        return scripts
                    else:
                        print(f"[agent_service] Failed to fetch scripts metadata: HTTP {resp.status}")
                        return []
        except Exception as e:
            print(f"[agent_service] Error fetching scripts metadata: {e}")
            return []

    async def _fetch_script_from_gcs(self, script_id: str) -> Optional[str]:
        """
        Fetch a script's Python code from GCS.
        
        Args:
            script_id: The script ID (e.g., "depth_of_invasion")
            
        Returns:
            Python code as string, or None if fetch failed
        """
        try:
            script_url = f"{SCRIPTS_GCS_BASE_URL}/{script_id}.py"
            async with aiohttp.ClientSession() as session:
                async with session.get(script_url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    if resp.status == 200:
                        code = await resp.text()
                        print(f"[agent_service] Successfully fetched script: {script_id}")
                        return code
                    else:
                        print(f"[agent_service] Failed to fetch script {script_id}: HTTP {resp.status}")
                        return None
        except Exception as e:
            print(f"[agent_service] Error fetching script {script_id}: {e}")
            return None

    def _format_scripts_for_prompt(self, scripts: List[Dict[str, Any]]) -> str:
        """
        Format scripts metadata for inclusion in system prompt.
        
        Args:
            scripts: List of script metadata dicts
            
        Returns:
            Formatted string for prompt
        """
        if not scripts:
            return "No pre-written scripts available."
        
        lines = ["AVAILABLE PRE-WRITTEN SCRIPTS:", ""]
        for script in scripts:
            lines.append(f"ID: {script.get('id')}")
            lines.append(f"Name: {script.get('name')}")
            lines.append(f"Description: {script.get('description')}")
            keywords = script.get('keywords', [])
            if keywords:
                lines.append(f"Keywords: {', '.join(keywords)}")
            required = script.get('required_datasets', [])
            if required:
                lines.append(f"Required datasets: {', '.join(required)}")
            lines.append("")
        
        lines.append("You can use fetch_script(script_id) to retrieve a pre-written script when it matches the user's request.")
        lines.append("Only use fetch_script if the script clearly matches the task and required datasets are available.")
        lines.append("Otherwise, generate new code as usual.")
        lines.append("")
        
        return "\n".join(lines)

    def _fetch_guidelines(self, query_text: str, always_search: bool = False) -> str:
        """
        Attempt to fetch medical guideline info via OpenAI web_search_preview tool.
        Returns empty string on failure.
        
        Args:
            query_text: The query to search for
            always_search: If True, always return search results regardless of specificity
        """
        if not query_text:
            return ""
        try:
            # Adjust prompt based on always_search flag
            if always_search:
                search_prompt = (
                    f"Query: \"{query_text}\"\n\n"
                    "Search for relevant medical guidelines, criteria, or standards. "
                    "Return ONLY the most relevant findings in a few concise paragraphs. "
                    "Do not include follow-up questions or suggestions."
                )
            else:
                search_prompt = (
                    f"Query: \"{query_text}\"\n\n"
                    "Question: Is there any criteria for this query? by criteria, I mean AJCC, CAP, mayo guideline, WHO guideline, or AASLD, etc. such published, well accepted criteria\n\n"
                    "IMPORTANT: Only return \"YES\" if you find specific, published guidelines that directly answer the exact question asked. Do not include general grading systems or identification methods unless they specifically address the quantitative measurement requested.\n\n"
                    "Only return yes or no\n"
                    "If yes provide the exact criteria"
                )
            
            # New Responses API with web_search_preview tool
            response = self.client.responses.create(
                model=os.getenv("OPENAI_MODEL_SEARCH", "gpt-5.2"),
                tools=[{"type": "web_search"}],
                input=search_prompt,
            )
            # Best-effort extraction of text
            guideline_text = getattr(response, "output_text", None)
            if not guideline_text:
                # Fallback: try to compose from content blocks
                try:
                    guideline_text = "".join(
                        [
                            block.get("text", {}).get("value", "")
                            for block in getattr(response, "output", [])
                            if isinstance(block, dict)
                        ]
                    )
                except Exception:
                    guideline_text = ""
            return guideline_text or ""
        except Exception:
            return ""

    async def classify_intent(self, query: str, history: Optional[Any] = None) -> str:
        """
        Classify the intent of the prompt.
        Returns string labels: "1" (general chat), "2" (patch/code request), "3" (seg/cls workflow request).
        """
        system_prompt = self.prompt_router or (
            "You are a router. Output only one of: 1, 2, or 3.\n"
            "1 = general chat, Q&A, explanations, or conversational responses;\n"
            "2 = user requests code changes/patches/refactoring;\n"
            "3 = user explicitly requests medical image analysis, segmentation, classification, or workflow generation.\n"
        )
        try:
            # Build minimal message list with a short window of recent turns
            messages = [{"role": "system", "content": system_prompt}]
            if isinstance(history, list) and history:
                recent = history[-4:]
                for turn in recent:
                    role = turn.get("role")
                    content = turn.get("content")
                    if role in ("user", "assistant") and isinstance(content, str) and content.strip():
                        messages.append({"role": role, "content": content})
            # Current user query last
            messages.append({"role": "user", "content": query or ""})
            try:
                print(f"[router.history] count={len(history) if isinstance(history, list) else 0} used={len(messages)-1}")
            except Exception:
                pass
            
            # Use provider abstraction
            provider = self._get_provider(self.router_provider_name)
            json_schema = {
                "name": "route_label",
                "schema": {
                    "type": "object",
                    "properties": {
                        "label": {
                            "type": "string",
                            "enum": ["1", "2", "3"],
                            "description": "Routing label"
                        }
                    },
                    "required": ["label"],
                    "additionalProperties": False
                },
                "strict": True
            }
            
            response = provider.infer(
                messages=messages,
                model=self.model_router,
                json_schema=json_schema,
            )
            
            label = None
            try:
                parsed = json.loads(response.text or "{}")
                if isinstance(parsed, dict):
                    label = parsed.get("label")
            except Exception:
                pass
            if not label:
                label = response.text
            return (label or "1").strip()
        except Exception as e:
            print("Error in classify_intent():", e)
            # Safe default to general chat
            return "1"

    async def chat(self, prompt: str, history: Optional[Any] = None, data_context: Optional[Dict[str, Any]] = None, user_id: Optional[str] = None) -> str:
        """
        Simple chat with optional conversation history (using provider abstraction).
        History format (optional): list of { role: "user"|"assistant", content: str }
        """
        try:
            # Knowledge base / correction detection removed in local build.
            # Build data context string
            dc_text = ""
            try:
                if isinstance(data_context, dict):
                    zarr_path = data_context.get("zarr_path")
                    if zarr_path:
                        dc_text = f"Active Zarr: {zarr_path}"
            except Exception:
                dc_text = ""

            # Build capability catalog for chat
            try:
                nodes = model_store.get_nodes_extended()
                category_map = model_store.get_category_map()
                cap_lines = []
                for category, node_names in category_map.items():
                    cap_lines.append(f"Category: {category}")
                    for n in node_names:
                        meta = nodes.get(n, {})
                        dn = meta.get("displayName", n)
                        desc = meta.get("description", "")
                        inputs = meta.get("inputs")
                        outputs = meta.get("outputs")
                        io_bits = []
                        if isinstance(inputs, str) and inputs.strip():
                            io_bits.append(f"Consumes: {inputs.strip()}")
                        if isinstance(outputs, str) and outputs.strip():
                            io_bits.append(f"Produces: {outputs.strip()}")
                        suffix = ("; " + "; ".join(io_bits)) if io_bits else ""
                        if desc:
                            cap_lines.append(f"- impl={n}; displayName={dn}; description={desc}{suffix}")
                        else:
                            cap_lines.append(f"- impl={n}; displayName={dn}{suffix}")
                    cap_lines.append("")
                chat_capabilities_text = "\n".join(cap_lines).strip()
            except Exception:
                chat_capabilities_text = ""

            # User-knowledge base load skipped in local build.
            knowledge_text = ""

            sys_content = (
                self.prompt_chat
                .replace("__MODEL_CAPABILITIES__", chat_capabilities_text)
                .replace("__DATA_CONTEXT", "__DATA_CONTEXT")
            )
            if dc_text:
                sys_content = sys_content.replace("__DATA_CONTEXT__", dc_text)
            else:
                sys_content = sys_content.replace("__DATA_CONTEXT__", "")
            
            # Append knowledge if available
            if knowledge_text:
                sys_content += knowledge_text
            
            messages = [{"role": "system", "content": sys_content}]
            
            # Append prior turns if provided
            if isinstance(history, list):
                # Keep only the last ~10 messages to control token usage
                recent = history[-10:]
                for turn in recent:
                    role = turn.get("role")
                    content = turn.get("content")
                    if role in ("user", "assistant") and isinstance(content, str) and content.strip():
                        messages.append({"role": role, "content": content})
            
            # Current user prompt last
            messages.append({"role": "user", "content": prompt or ""})

            # Check if web search is enabled
            web_search_enabled = False
            if isinstance(data_context, dict) and data_context.get("web_search_enabled"):
                web_search_enabled = True

            # Fetch guidelines if web search is enabled
            if web_search_enabled:
                frontend_requested = isinstance(data_context, dict) and data_context.get("web_search_enabled")
                guidelines = self._fetch_guidelines(prompt, always_search=frontend_requested)
                if guidelines:
                    # Add guidelines to system message
                    messages[0]["content"] += f"\n\nMEDICAL GUIDELINES REFERENCE:\n{guidelines}"

            try:
                print(f"[chat.dc] {dc_text if dc_text else 'none'}")
                print(f"[chat.history] count={len(history) if isinstance(history, list) else 0}")
                print(f"[chat.web_search] enabled={web_search_enabled}")
                print(f"[chat.provider] {self.chat_provider_name}")
            except Exception:
                pass

            # Use provider abstraction
            provider = self._get_provider(self.chat_provider_name)
            response = provider.infer(
                messages=messages,
                model=self.model_chat,
            )
            
            response_text = response.text
            
            # Collect training data if enabled
            if self.enable_training_collection:
                try:
                    self.training_collector.collect_chat(
                        prompt=prompt,
                        response=response_text,
                        data_context=data_context,
                        history=history,
                    )
                except Exception as e:
                    try:
                        print(f"[agent_service] Failed to collect chat training data: {e}")
                    except:
                        pass
            
            return response_text
            
        except Exception as e:
            print("Error in chat():", e)
            raise

    async def summary_answer(self, question: str, answer: str) -> str:
        """
        Return natural language summary of the answer
        
        Parameters:
        - question: The original question
        - answer: The answer to summarize
        
        Returns:
        - A natural language summary of the answer
        """
        try:
            #combine the question and answer
            combined_prompt = f'''You are writing a direct, on-topic result for an end user.
Question: {question}
Answer (raw data/result): {answer}

Rules:
- Respond concisely (ideally 1 short sentence).
- Only include a saved-path clause if (and only if) the parsed JSON answer includes output_path (non-empty string) or output_dir/files (files non-empty). Do NOT infer from input paths; never use zarr_path or input file paths in the saved-path clause. If no such fields exist, do NOT add any saved-path text.
- Otherwise include only information necessary to answer the user's question; omit storage details, indices, class maps, and implementation notes.
- If the question asks for a percentage, reply with the percentage and optionally the counts in parentheses, e.g., "83.60% tumor (174,671/208,936)".
- If there is no answer, return exactly: No answer found, try again
- If there is an error, return exactly: Error: <error message>, please try again
'''
            return await self.chat(combined_prompt)
        except Exception as e:
            print("Error in summary_answer:", e)
            raise

    async def get_processing_steps(self, query: str, history: Optional[Any] = None, data_context: Optional[Dict[str, Any]] = None, user_id: Optional[str] = None) -> str:
        """
        Get processing steps for medical image analysis (using provider abstraction).
        """
        # Knowledge base / correction detection removed in local build.
        # Fetch guideline info (optional enrichment)
        web_search_enabled = False
        if os.getenv("ENABLE_GUIDELINE_SEARCH", "0") == "1":
            web_search_enabled = True
        if isinstance(data_context, dict) and data_context.get("web_search_enabled"):
            web_search_enabled = True
        
        if web_search_enabled:
            frontend_requested = isinstance(data_context, dict) and data_context.get("web_search_enabled")
            fetched = self._fetch_guidelines(query, always_search=frontend_requested)
            try:
                print(f"[workflow.web_search_response] {fetched}")
            except Exception:
                pass
        else:
            fetched = ""
        
        if fetched:
            if "NO - NO SPECIFIC" in fetched.upper():
                guideline_block = (
                    "\n\nMEDICAL GUIDELINES REFERENCE:\n" + fetched +
                    "\n\nNo specific published guidelines found for this exact measurement. Proceed with standard analysis methods."
                )
            else:
                guideline_block = (
                    "\n\nMEDICAL GUIDELINES REFERENCE:\n" + fetched +
                    "\n\nUse these guidelines as a reference to inform your analysis steps, but follow the standard analysis framework."
                )
        else:
            guideline_block = ""
        
        # Build capability map for model selection
        try:
            nodes = model_store.get_nodes_extended()
            category_map = model_store.get_category_map()
            cap_lines = []
            for category, node_names in category_map.items():
                cap_lines.append(f"Category: {category}")
                for n in node_names:
                    meta = nodes.get(n, {})
                    dn = meta.get("displayName", n)
                    desc = meta.get("description", "")
                    inputs = meta.get("inputs")
                    outputs = meta.get("outputs")
                    io_bits = []
                    if isinstance(inputs, str) and inputs.strip():
                        io_bits.append(f"Consumes: {inputs.strip()}")
                    if isinstance(outputs, str) and outputs.strip():
                        io_bits.append(f"Produces: {outputs.strip()}")
                    suffix = ("; " + "; ".join(io_bits)) if io_bits else ""
                    if desc:
                        cap_lines.append(f"- impl={n}; displayName={dn}; description={desc}{suffix}")
                    else:
                        cap_lines.append(f"- impl={n}; displayName={dn}{suffix}")
                if category == "TissueSeg":
                    cap_lines.append("Selection Guide: DEFAULT IMPL: MuskEmbedding — it is the production-default choice for H&E pathology TissueSeg and should be the first impl_candidate. Use VISTA only when the user explicitly requests interactive foundation-model segmentation, BiomedParseSegmentation only for radiology, and TotalSegmentatorSegmentation only for CT/MRI multi-organ tasks.")
                if category == "TissueClassify":
                    cap_lines.append("Selection Guide: Prefer MUSK for pathology questions; use BiomedParse only for radiology questions. Omit TissueClassify if no region/patch labeling is needed and the task is cell-only. ALWAYS precede TissueClassify with TissueSeg to provide required embeddings/features. Provide specific tissue class types with anatomical context when relevant to avoid ambiguous terms.")
                if category == "NucleiSeg":
                    cap_lines.append("Selection Guide: Required for cell-level metrics; no inputs; do not invent targets. DEFAULT IMPL: SegmentationNode (StarDist) — it is the validated, production-default choice for H&E pathology and should be the first impl_candidate. Only choose InstanSegNode when the user explicitly requests it or the slide is a non-H&E modality where StarDist is known to underperform.")
                if category == "NucleiClassify":
                    cap_lines.append("Selection Guide: Include only minimal necessary classes (e.g., ['tumor_cell','other']).")
                if category == "CodingAgent":
                    cap_lines.append("Selection Guide: Only return the requested calculation; no visualizations unless explicitly requested.")
                if category == "TaskSpecific":
                    cap_lines.append("Selection Guide: Use for specialized imaging modalities (e.g. X-ray) when available; standalone models that don't require preprocessing steps.")
                if category == "SpatialOmics":
                    cap_lines.append("Selection Guide: Use for spatial transcriptomics analysis; specialized clustering and domain identification.")
                cap_lines.append("")
            capabilities_text = "\n".join(cap_lines).strip()
        except Exception:
            capabilities_text = ""

        # Build data context block
        dc_text = ""
        try:
            if isinstance(data_context, dict):
                parts = []
                zarr_path = data_context.get("zarr_path")
                if zarr_path:
                    parts.append(f"Active Zarr: {zarr_path}")
                if data_context.get("slide_info"):
                    parts.append(f"Slide Info: {json.dumps(data_context.get('slide_info'))}")
                
                # Add initial workflow if available (for v2 adjustment)
                initial_workflow = data_context.get("initial_workflow")
                if initial_workflow:
                    try:
                        initial_wf_obj = json.loads(initial_workflow) if isinstance(initial_workflow, str) else initial_workflow
                        initial_steps = initial_wf_obj.get("steps", [])
                        if initial_steps:
                            parts.append(f"\nInitial Workflow (draft):")
                            for step in initial_steps:
                                model = step.get("model", "N/A")
                                impl = step.get("impl", "N/A")
                                parts.append(f"  Step {step.get('step', '?')}: {model} ({impl})")
                    except Exception:
                        pass
                
                # Add ROIs information if available (v2 format)
                rois_info = data_context.get("rois_info")
                if rois_info:
                    parts.append(f"\n{rois_info}")
                
                rois_images = data_context.get("rois_images")
                if rois_images:
                    parts.append(f"\nROIs Images: {len(rois_images)} image(s) provided for visual analysis")
                
                # Add ROI workflow hint if available
                roi_hint = data_context.get("roi_workflow_hint")
                if roi_hint:
                    parts.append(f"\n{roi_hint}")
                
                if parts:
                    dc_text = "\n".join(parts)
        except Exception:
            dc_text = ""

        # User-knowledge load skipped in local build.
        system_prompt = (
            self.prompt_workflow
            .replace("__GUIDELINE_INFO__", guideline_block)
            .replace("__MODEL_CAPABILITIES__", capabilities_text + ("\n\nPlanning note: Prefer chaining nodes where a step's Produces matches the next step's Consumes. If not stated, infer conservatively."))
            .replace("__DATA_CONTEXT__", dc_text)
        )


        try:
            # Build message list with optional chat history for context
            messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
            if isinstance(history, list):
                recent = history[-10:]
                for turn in recent:
                    role = turn.get("role")
                    content = turn.get("content")
                    if role in ("user", "assistant") and isinstance(content, str) and content.strip():
                        messages.append({"role": role, "content": content})
            
            # Build user message with images if available
            user_content = query or ""
            rois_images = data_context.get("rois_images") if isinstance(data_context, dict) else None
            
            if rois_images and isinstance(rois_images, list) and len(rois_images) > 0:
                # Build content array with text and images
                # Use chat.completions format for images (compatible with Responses API input format)
                content_parts = []
                
                # Add text content (use input_text for Responses API)
                if user_content:
                    content_parts.append({
                        "type": "input_text",
                        "text": user_content
                    })
                
                # Add images (base64 encoded strings) with ROI identification
                # Get ROI info to match images with ROI indices
                rois_info_text = data_context.get("rois_info", "") if isinstance(data_context, dict) else ""
                
                print(f"[workflow_agent] Sending {len(rois_images)} ROI images to LLM")
                for idx, img_base64 in enumerate(rois_images):
                    if isinstance(img_base64, str):
                        # Clean base64 string (remove data:image/... prefix if present)
                        clean_base64 = img_base64
                        mime_type = "image/png"  # default
                        if img_base64.startswith("data:image"):
                            # Extract base64 part after comma
                            clean_base64 = img_base64.split(",", 1)[1] if "," in img_base64 else img_base64
                            # Extract mime type
                            if "image/jpeg" in img_base64 or "image/jpg" in img_base64:
                                mime_type = "image/jpeg"
                            elif "image/png" in img_base64:
                                mime_type = "image/png"
                        
                        # Add text label before each image to identify which ROI it is (use input_text for Responses API)
                        roi_num = idx + 1
                        roi_label = f"\n[ROI {roi_num} Image - Refer to ROI {roi_num} information above for patch size calculation]"
                        print(f"[workflow_agent] Adding ROI {roi_num} image (base64 length: {len(clean_base64)})")
                        content_parts.append({
                            "type": "input_text",
                            "text": roi_label
                        })
                        
                        # Use image_url format (compatible with chat.completions API)
                        content_parts.append({
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{mime_type};base64,{clean_base64}"
                            }
                        })
                
                print(f"[workflow_agent] Total content parts: {len(content_parts)} (text parts + image parts)")
                print(f"[workflow_agent] ROIs info text length: {len(rois_info_text)} characters")
                messages.append({"role": "user", "content": content_parts})
            else:
                # No images, just text
                messages.append({"role": "user", "content": user_content})

            # Define JSON schema for workflow steps
            json_schema = {
                "name": "workflow_steps",
                "schema": {
                    "type": "object",
                    "properties": {
                        "steps": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "step": { "type": "integer", "description": "1-based order" },
                                    "model": { "type": "string", "description": "Model category" },
                                    "input": {
                                        "type": "array",
                                        "items": { "type": "string" },
                                        "description": "Targets/parameters"
                                    },
                                    "impl": { "type": "string", "description": "Concrete implementation/node" },
                                    "impl_candidates": {
                                        "type": "array",
                                        "items": { "type": "string" },
                                        "minItems": 1,
                                        "description": "Candidate pool ordered from best to worst"
                                    }
                                },
                                "required": ["step", "model", "input", "impl", "impl_candidates"],
                                "additionalProperties": False
                            }
                        },
                        "workflow_reason": {
                            "type": "string",
                            "description": "Explanation for workflow selection, especially when choosing between tissue-based vs nuclei-based workflows. Include consideration of ROI sizes, patch size calculations, and task requirements. Can be empty string if not needed."
                        }
                    },
                    "required": ["steps", "workflow_reason"],
                    "additionalProperties": False
                },
                "strict": True
            }

            # Use provider abstraction
            provider = self._get_provider(self.workflow_provider_name)
            response = provider.infer(
                messages=messages,
                model=self.model_workflow,
                json_schema=json_schema,
            )
            
            out = response.text or "{}"
            
            try:
                print(f"[workflow.dc] {dc_text if dc_text else 'none'}")
                print(f"[workflow.history] count={len(history) if isinstance(history, list) else 0}")
                print(f"[workflow.output_len] {len(out)}")
                print(f"[workflow.provider] {self.workflow_provider_name}")
                # Print first 500 chars of response for debugging
                if out and len(out) > 0:
                    preview = out[:500] if len(out) > 500 else out
                    print(f"[workflow.response_preview] {preview}")
                    if len(out) > 500:
                        print(f"[workflow.response_preview] ... (truncated, total {len(out)} chars)")
            except Exception:
                pass
            
            # Collect training data if enabled
            if self.enable_training_collection:
                try:
                    steps_obj = json.loads(out)
                    steps = steps_obj.get("steps", [])
                    if steps:
                        self.training_collector.collect_workflow_planning(
                            prompt=query,
                            steps=steps,
                            data_context=data_context,
                            history=history,
                            success=True,
                        )
                except Exception as e:
                    try:
                        print(f"[agent_service] Failed to collect workflow training data: {e}")
                    except:
                        pass
            
            return out
        except Exception as e:
            print("Error in get_processing_steps():", e)
            return "{}"
    
    async def select_impl_from_candidates(
        self,
        query: str,
        step: Dict[str, Any],
        candidates: List[Dict[str, Any]],
        feedback_text: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Use the selection prompt to choose an impl from a candidate list (using provider abstraction)."""
        if not candidates:
            return None

        payload = {
            "query": query,
            "step": {
                "step": step.get("step"),
                "model": step.get("model"),
                "input": step.get("input"),
                "impl": step.get("impl"),
            },
            "candidates": candidates,
            "user_feedback": feedback_text or "",
        }

        messages = [
            {"role": "system", "content": self.prompt_workflow_selection},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ]

        try:
            json_schema = {
                "name": "impl_selection",
                "schema": {
                    "type": "object",
                    "properties": {
                        "selected_impl": {"type": "string"},
                        "reason": {"type": "string"},
                        "ranking": {
                            "type": "array",
                            "items": {"type": "string"},
                            "minItems": 1
                        },
                    },
                    "required": ["selected_impl", "reason", "ranking"],
                    "additionalProperties": False,
                },
                "strict": True,
            }
            
            # Use provider abstraction
            provider = self._get_provider(self.ranking_provider_name)
            response = provider.infer(
                messages=messages,
                model=self.model_ranking,
                json_schema=json_schema,
            )
            
            out = response.text or "{}"
            result = json.loads(out)
            
            # Collect training data if enabled
            if self.enable_training_collection and result:
                try:
                    self.training_collector.collect_impl_ranking(
                        query=query,
                        step=step,
                        candidates=candidates,
                        selected_impl=result.get("selected_impl", ""),
                        ranking=result.get("ranking", []),
                        reason=result.get("reason", ""),
                    )
                except Exception as e:
                    try:
                        print(f"[agent_service] Failed to collect ranking training data: {e}")
                    except:
                        pass
            
            return result
        except Exception:
            return None


    async def prepare_script_prompts(
        self,
        script_task: str,
        zarr_structure: str = None,
        original_question: str = None,
        web_search_enabled: bool = False,
        use_scripts_library: bool = False,
    ) -> Tuple[str, str, List[Dict[str, Any]]]:
        """Build system/user prompts and optional fetch_script tools (same inputs as get_script)."""
        if use_scripts_library:
            scripts_metadata = await self._fetch_scripts_metadata()
            scripts_text = self._format_scripts_for_prompt(scripts_metadata)
        else:
            scripts_text = "(No script library for this run. Generate code from scratch.)"

        combined_for_search = f"Original Question: {original_question or script_task or ''}\n\nScript Task: {script_task or ''}"
        search_enabled = web_search_enabled or (os.getenv("ENABLE_GUIDELINE_SEARCH", "0") == "1")
        if search_enabled:
            frontend_requested = web_search_enabled
            fetched = self._fetch_guidelines(combined_for_search, always_search=frontend_requested)
        else:
            fetched = ""

        if fetched:
            if "NO - NO SPECIFIC" in fetched.upper():
                guideline_block = (
                    "\n\nMEDICAL GUIDELINES REFERENCE:\n" + fetched +
                    "\n\nNo specific published guidelines found for this exact measurement. Proceed with standard coding methods."
                )
            else:
                guideline_block = (
                    "\n\nMEDICAL GUIDELINES REFERENCE:\n" + fetched +
                    "\n\nUse these guidelines as a reference to inform your code implementation, but follow the standard coding framework."
                )
        else:
            guideline_block = ""

        system_prompt = (
            self.prompt_code
            .replace("__GUIDELINE_INFO__", guideline_block)
            .replace("__AVAILABLE_SCRIPTS__", scripts_text)
        )

        user_prompt = (
            f"Original Question: {original_question or script_task or ''}\n\n"
            f"Script Task: {script_task or ''}\n\n"
            f"Input JSON structure (data at json_path): {zarr_structure or ''}"
        )

        tools: List[Dict[str, Any]] = []
        if use_scripts_library:
            tools = [{
                "type": "function",
                "name": "fetch_script",
                "description": "Fetch a pre-written, tested script from the library. Use this when an existing script matches the user's request instead of generating new code.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "script_id": {
                            "type": "string",
                            "description": "The ID of the script to fetch (e.g., 'depth_of_invasion')"
                        },
                        "reason": {
                            "type": "string",
                            "description": "Brief explanation of why this script matches the user's request"
                        }
                    },
                    "required": ["script_id"],
                    "additionalProperties": False
                }
            }]

        return system_prompt, user_prompt, tools

    def iter_script_chat_stream(self, system_prompt: str, user_prompt: str) -> Iterator[str]:
        """
        Stream assistant text deltas via Chat Completions (OpenAI client).
        SSE path does not execute fetch_script tools; prompt still lists library scripts.
        """
        kwargs: Dict[str, Any] = {
            "model": self.model_code,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "stream": True,
        }
        effective_model = self.model_code or ""
        if "5.2" not in effective_model:
            kwargs["temperature"] = 1.0

        stream = self.client.chat.completions.create(**kwargs)
        for chunk in stream:
            try:
                choices = getattr(chunk, "choices", None) or []
                if not choices:
                    continue
                delta = getattr(choices[0], "delta", None)
                piece = getattr(delta, "content", None) if delta is not None else None
                if piece:
                    yield piece
            except Exception:
                continue

    async def get_script(self, script_task: str, zarr_structure: str = None, original_question: str = None, web_search_enabled: bool = False, use_scripts_library: bool = False) -> str:
        """
        Generate or fetch Python code that defines analyze_medical_image(path) (using provider abstraction).
        
        The LLM can either:
        1. Call fetch_script(script_id) tool to retrieve a pre-written script from GCS (when use_scripts_library=True)
        2. Generate new code directly (wrapped in markdown code blocks)
        
        Args:
            script_task: The task description for code generation
            zarr_structure: Input file structure (JSON string; e.g. for analyze_medical_image the input is a path to a JSON file)
            original_question: Original user question
            web_search_enabled: Whether to enable web search for guidelines
            use_scripts_library: If True, load GCS scripts metadata and expose fetch_script; default False（默认不读 knowledge/scripts）
        
        Returns:
            Python code as a string (extracted from markdown code blocks if present).
        """
        system_prompt, user_prompt, tools = await self.prepare_script_prompts(
            script_task=script_task,
            zarr_structure=zarr_structure,
            original_question=original_question,
            web_search_enabled=web_search_enabled,
            use_scripts_library=use_scripts_library,
        )

        try:
            # Use provider abstraction
            provider = self._get_provider(self.code_provider_name)
            response = provider.infer(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                model=self.model_code,
                tools=tools if tools else None,
            )
            
            # Check if LLM decided to use a tool
            generated_code = None
            if response.tool_calls:
                for tc in response.tool_calls:
                    if tc.name == "fetch_script":
                        script_id = tc.arguments.get("script_id")
                        print(f"[get_script] Using library script: {script_id}")
                        
                        # Fetch the script from GCS
                        fetched_code = await self._fetch_script_from_gcs(script_id)
                        if fetched_code:
                            generated_code = fetched_code
                            break
                        else:
                            print(f"[get_script] Failed to fetch '{script_id}', generating instead")
            
            # No tool call or fetch failed - extract generated code
            if not generated_code:
                raw_response = response.text or ""
                # Extract code from markdown code blocks
                generated_code = _extract_code_from_markdown(raw_response)
            
            # Collect training data if enabled
            if self.enable_training_collection and generated_code:
                try:
                    self.training_collector.collect_code_generation(
                        script_task=script_task,
                        original_question=original_question or script_task,
                        zarr_structure=zarr_structure,
                        generated_code=generated_code,
                    )
                except Exception as e:
                    try:
                        print(f"[agent_service] Failed to collect code training data: {e}")
                    except:
                        pass
            
            return generated_code
            
        except Exception as e:
            print("Error in get_script():", e)
            raise


# Singleton instance
_workflow_agent = None


def get_workflow_agent() -> WorkflowAgent:
    """
    Get singleton instance of WorkflowAgent
    """
    global _workflow_agent
    if _workflow_agent is None:
        _workflow_agent = WorkflowAgent()
    return _workflow_agent

