import os
from typing import Dict, Any, Optional, List
import h5py, json
import numpy as np
from openai import OpenAI
from app.services.model_store import model_store

PROMPTS_DIR = os.path.join(os.path.dirname(__file__), "prompts")

def _read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _extract_response_text(response: Any) -> str:
    """
    Best-effort text extraction from Responses API result.
    Prefers response.output_text, falls back to concatenating text blocks.
    """
    try:
        text = getattr(response, "output_text", None)
        if text:
            return text
        blocks = getattr(response, "output", None)
        if isinstance(blocks, list) and blocks:
            parts = []
            for block in blocks:
                try:
                    contents = block.get("content", []) if isinstance(block, dict) else []
                    for c in contents:
                        if isinstance(c, dict) and c.get("type") == "output_text":
                            parts.append(c.get("text", ""))
                        elif isinstance(c, dict) and c.get("type") == "output_tool":
                            # ignore tools here
                            continue
                        elif isinstance(c, dict) and c.get("type") == "output_image":
                            continue
                except Exception:
                    continue
            if parts:
                return "".join(parts)
    except Exception:
        pass
    return ""


def process_node(name, obj):
    """
     Recursively process groups and datasets in the HDF5 file.
 
     :param name: The name of the current group or dataset.
     :param obj: The current HDF5 object (Group or Dataset).
     :return: A dictionary representing the structure of the current group or dataset.
     """
    if isinstance(obj, h5py.Group):
        return {
            "type": "Group",
            "name": name,
            "children": {
                key: process_node(key, item)
                for key, item in obj.items()
            }
        }
    elif isinstance(obj, h5py.Dataset):
        dataset_info = {
            "type": "Dataset",
            "name": name,
            "shape": obj.shape,
            "dtype": str(obj.dtype)
        }

        try:
            raw_data = obj[()]
            if isinstance(raw_data, bytes):
                try:
                    decoded_str = raw_data.decode('utf-8')
                    json_data = json.loads(decoded_str)

                    def get_structure(data):
                        if isinstance(data, dict):
                            total_length = len(data)
                            if total_length > 20:
                                # Take only first item as sample
                                first_key, first_value = next(
                                    iter(data.items()))
                                return {
                                    "sample": {
                                        first_key: get_structure(first_value)
                                    },
                                    "total_length": total_length,
                                    "value_type": type(first_value).__name__
                                }
                            return {
                                k: get_structure(v)
                                for k, v in data.items()
                            }
                        elif isinstance(data, list):

                            def get_array_shape(arr):
                                shape = [len(arr)]
                                if shape[0] > 0 and isinstance(arr[0], list):
                                    shape.extend(get_array_shape(arr[0]))
                                return shape

                            if len(data) > 0:
                                shape = get_array_shape(data)

                                def get_deepest_type(arr):
                                    if isinstance(arr, list) and len(arr) > 0:
                                        return get_deepest_type(arr[0])
                                    return type(arr).__name__

                                element_type = get_deepest_type(data)
                                return f"Array{shape} of {element_type}"
                            return "Empty Array"
                        else:
                            return f"Type: {type(data).__name__}"

                    dataset_info["structure"] = get_structure(json_data)
                except Exception:
                    dataset_info[
                        "content_type"] = "UTF-8 encoded string (not JSON)"
            elif isinstance(raw_data, (int, float)):
                dataset_info[
                    "content_type"] = f"Scalar {type(raw_data).__name__}"
            elif isinstance(raw_data, np.ndarray):
                dataset_info["content_type"] = f"Array of {raw_data.dtype}"

                if raw_data.ndim == 1 and len(raw_data) < 10:
                    # For short 1D arrays, include the actual values
                    # Handle special data types to ensure JSON serializability
                    try:
                        if np.issubdtype(raw_data.dtype, np.integer):
                            dataset_info["values"] = [int(x) for x in raw_data]
                        elif np.issubdtype(raw_data.dtype, np.floating):
                            dataset_info["values"] = [
                                float(x) for x in raw_data
                            ]
                        elif np.issubdtype(raw_data.dtype, np.bool_):
                            dataset_info["values"] = [
                                bool(x) for x in raw_data
                            ]
                        elif np.issubdtype(raw_data.dtype, np.character):
                            dataset_info["values"] = [str(x) for x in raw_data]
                        else:
                            # For complex types, convert to string representation
                            dataset_info["values"] = [str(x) for x in raw_data]
                    except Exception as e:
                        dataset_info[
                            "values_error"] = f"Could not serialize values: {str(e)}"
            else:
                dataset_info["content_type"] = str(type(raw_data).__name__)
        except Exception as e:
            dataset_info["content_type"] = f"Unknown (error: {str(e)})"

        return dataset_info

class AgentService:

    def __init__(self):
        self.client = OpenAI()
        # Allow model overrides via env; provide safe defaults
        # Defaults aligned with cloud implementation; override via env vars if needed
        self.model_router = os.getenv("OPENAI_MODEL_ROUTER", "gpt-5-nano")
        self.model_chat = os.getenv("OPENAI_MODEL_CHAT", "gpt-5-mini")
        self.model_workflow = os.getenv("OPENAI_MODEL_WORKFLOW", "gpt-5-mini")
        self.model_code = os.getenv("OPENAI_MODEL_CODE", "gpt-5-mini")
        # Load prompts
        self.prompt_workflow = _read_text(os.path.join(PROMPTS_DIR, "workflow_system_prompt.txt"))
        self.prompt_code = _read_text(os.path.join(PROMPTS_DIR, "code_system_prompt.txt"))
        selection_path = os.path.join(PROMPTS_DIR, "workflow_selection_prompt.txt")
        self.prompt_workflow_selection = _read_text(selection_path) if os.path.exists(selection_path) else (
            "You evaluate implementation candidates for a workflow step and select the best option."
        )
        chat_path = os.path.join(PROMPTS_DIR, "chat_system_prompt.txt")
        self.prompt_chat = _read_text(chat_path) if os.path.exists(chat_path) else (
            "You are TLAgent, or TissueLab Agent. You are a helpful assistant that guides clinicians in using our medical imaging analysis platform TissueLab. You can help answer user questions, create workflows, and analyze the results. Answer briefly and help users interact with our platform. If an active H5 is available, propose and run the minimal workflow without asking for uploads."
        )
        router_path = os.path.join(PROMPTS_DIR, "router_need_patch_prompt.txt")
        self.prompt_router = _read_text(router_path) if os.path.exists(router_path) else None

    def _fetch_guidelines(self, query_text: str) -> str:
        """
        Attempt to fetch medical guideline info via OpenAI web_search_preview tool.
        Returns empty string on failure.
        """
        if not query_text:
            return ""
        try:
            # New Responses API with web_search_preview tool
            response = self.client.responses.create(
                model=os.getenv("OPENAI_MODEL_SEARCH", "gpt-5-mini"),
                tools=[{"type": "web_search_preview"}],
                input=(
                    f"Query: \"{query_text}\"\n\n"
                    "Question: Is there any criteria for this query? by criteria, I mean AJCC, CAP, mayo guideline, WHO guideline, or AASLD, etc. such published, well accepted criteria\n\n"
                    "IMPORTANT: Only return \"YES\" if you find specific, published guidelines that directly answer the exact question asked. Do not include general grading systems or identification methods unless they specifically address the quantitative measurement requested.\n\n"
                    "Only return yes or no\n"
                    "If yes provide the exact criteria"
                ),
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
    async def need_patch(self, query: str, history: Optional[Any] = None) -> str:
        """
        Classify the intent of the prompt.
        Returns string labels: "1" (general chat), "2" (patch/code request), "3" (seg/cls workflow request).
        """
        system_prompt = self.prompt_router or (
            "You are a router. Output only one of: 1, 2, or 3.\n"
            "1 = general chat or Q&A not requiring workflow or code;\n"
            "2 = user requests code changes/patches/refactoring;\n"
            "3 = medical image analysis requiring segmentation/classification workflow."
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
            response = self.client.responses.create(
                model=self.model_router,
                reasoning={"effort": "minimal"},
                input=messages,
                text={
                    "format": {
                        "type": "json_schema",
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
                }
            )
            label = None
            try:
                parsed = json.loads(getattr(response, "output_text", "") or "")
                if isinstance(parsed, dict):
                    label = parsed.get("label")
            except Exception:
                pass
            if not label:
                label = _extract_response_text(response)
            return (label or "1").strip()
        except Exception as e:
            print("Error in need_patch():", e)
            # Safe default to general chat
            return "1"

    async def chat(self, prompt: str, history: Optional[Any] = None, data_context: Optional[Dict[str, Any]] = None) -> str:
        """
        Simple chat with optional conversation history.
        History format (optional): list of { role: "user"|"assistant", content: str }
        """
        try:
            # Build data context string (frontend or fallback)
            dc_text = ""
            try:
                if isinstance(data_context, dict) and data_context.get("h5_path"):
                    dc_text = f"Active H5: {data_context.get('h5_path')}"
            except Exception:
                dc_text = ""

            # Build capability catalog for chat (reuse workflow capability text)
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

            sys_content = (
                self.prompt_chat
                .replace("__MODEL_CAPABILITIES__", chat_capabilities_text)
                .replace("__DATA_CONTEXT", "__DATA_CONTEXT")
            )
            if dc_text:
                sys_content = sys_content.replace("__DATA_CONTEXT__", dc_text)
            else:
                sys_content = sys_content.replace("__DATA_CONTEXT__", "")
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

            try:
                print(f"[chat.dc] {dc_text if dc_text else 'none'}")
                print(f"[chat.history] count={len(history) if isinstance(history, list) else 0}")
            except Exception:
                pass

            response = self.client.responses.create(
                model=self.model_chat,
                reasoning={"effort": "minimal"},
                input=messages,
            )
            return _extract_response_text(response) or ""
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
- Only include a saved-path clause if (and only if) the parsed JSON answer includes output_path (non-empty string) or output_dir/files (files non-empty). Do NOT infer from input paths; never use h5_path or input file paths in the saved-path clause. If no such fields exist, do NOT add any saved-path text.
- Otherwise include only information necessary to answer the user's question; omit storage details, indices, class maps, and implementation notes.
- If the question asks for a percentage, reply with the percentage and optionally the counts in parentheses, e.g., "83.60% tumor (174,671/208,936)".
- If there is no answer, return exactly: No answer found, try again
- If there is an error, return exactly: Error: <error message>, please try again
'''
            return await self.chat(combined_prompt)
        except Exception as e:
            print("Error in summary_answer:", e)
            raise

    async def get_processing_steps(self, query: str, history: Optional[Any] = None, data_context: Optional[Dict[str, Any]] = None) -> str:
        """
        Get processing steps for medical image analysis by prompting OpenAI to return
        a Python-dict-like string that ast.literal_eval can parse in agent.py.
        """
        # Fetch guideline info (optional enrichment)
        if os.getenv("ENABLE_GUIDELINE_SEARCH", "0") == "1":
            fetched = self._fetch_guidelines(query)
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
                    # Present impl (machine name) separately from displayName; include natural-language I/O when present
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
                if category == "TissueClassify":
                    cap_lines.append("Selection Guide: Prefer MUSK for fast patch-level tissue typing/coarse heatmaps; use BiomedParse only when pixel-accurate region boundaries are explicitly required. Omit TissueClassify if no region/patch labeling is needed and the task is cell-only.")
                if category == "NucleiSeg":
                    cap_lines.append("Selection Guide: Required for cell-level metrics; no inputs; do not invent targets.")
                if category == "NucleiClassify":
                    cap_lines.append("Selection Guide: Include only minimal necessary classes (e.g., ['tumor_cell','other']).")
                if category == "Scripts":
                    cap_lines.append("Selection Guide: Only return the requested calculation; no visualizations unless explicitly requested.")
                cap_lines.append("")
            capabilities_text = "\n".join(cap_lines).strip()
        except Exception:
            capabilities_text = ""

        # Build data context block
        dc_text = ""
        try:
            if isinstance(data_context, dict):
                parts = []
                if data_context.get("h5_path"):
                    parts.append(f"Active H5: {data_context.get('h5_path')}")
                if data_context.get("slide_info"):
                    parts.append(f"Slide Info: {json.dumps(data_context.get('slide_info'))}")
                if parts:
                    dc_text = "\n".join(parts)
        except Exception:
            dc_text = ""

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
            messages.append({"role": "user", "content": query or ""})

            response = self.client.responses.create(
                model=self.model_workflow,
                reasoning={"effort": "minimal"},
                input=messages,
                text={
                    "format": {
                        "type": "json_schema",
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
                                }
                            },
                            "required": ["steps"],
                            "additionalProperties": False
                        },
                        "strict": True
                    }
                }
            )
            out = _extract_response_text(response) or "{}"
            try:
                print(f"[workflow.dc] {dc_text if dc_text else 'none'}")
                print(f"[workflow.history] count={len(history) if isinstance(history, list) else 0}")
                print(f"[workflow.output_len] {len(out)}")
            except Exception:
                pass
            return out
        except Exception as e:
            print("Error in get_processing_steps():", e)
            # Return an empty dict string so downstream parsing doesn't crash
            return "{}"


    async def select_impl_from_candidates(
        self,
        query: str,
        step: Dict[str, Any],
        candidates: List[Dict[str, Any]],
        feedback_text: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Use the selection prompt to choose an impl from a candidate list."""
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
            response = self.client.responses.create(
                model=self.model_workflow,
                reasoning={"effort": "minimal"},
                input=messages,
                text={
                    "format": {
                        "type": "json_schema",
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
                },
            )
            out = _extract_response_text(response) or "{}"
            return json.loads(out)
        except Exception:
            return None


    async def get_script(self, script_task: str, h5_structure: str = None, original_question: str = None) -> str:
        """
        Generate Python code that defines analyze_medical_image(path) and returns a results dict.
        The model must return ONLY code (no fences, no prose).
        """
        # Fetch guideline info (optional enrichment)
        combined_for_search = f"Original Question: {original_question or script_task or ''}\n\nScript Task: {script_task or ''}"
        if os.getenv("ENABLE_GUIDELINE_SEARCH", "0") == "1":
            fetched = self._fetch_guidelines(combined_for_search)
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
        )
        user_prompt = (
            f"Original Question: {original_question or script_task or ''}\n\n"
            f"Script Task: {script_task or ''}\n\n"
            f"H5 File Structure: {h5_structure or ''}"
        )

        try:
            response = self.client.responses.create(
                model=self.model_code,
                reasoning={"effort": "minimal"},
                input=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            )
            return _extract_response_text(response) or ""
        except Exception as e:
            print("Error in get_script():", e)
            raise


    async def get_h5_structure(self, H5_FILE_PATH):
        """
        Retrieve the structure of an HDF5 file and return it as a nested dictionary,
        including the names of groups and datasets.

        :param H5_FILE_PATH: Path to the HDF5 file. Defaults to the specified file path.
        :return: A nested dictionary representing the structure of the file,
                 including names of groups and datasets.
        """

        # Open the HDF5 file and retrieve its structure
        try:
            with h5py.File(H5_FILE_PATH, 'r') as h5_file:
                print(f"read h5 file {H5_FILE_PATH} successfully")
                return process_node("/", h5_file["/"])
        except Exception as e:
            raise RuntimeError(f"failed to get h5 structure: {str(e)}")


# Singleton instance
_agent_service = None


def get_agent_service() -> AgentService:
    """
    Get singleton instance of AgentService
    """
    global _agent_service
    if _agent_service is None:
        _agent_service = AgentService()
    return _agent_service

# # Example usage
# if __name__ == "__main__":
#     agent_service = AgentService()
#     result = agent_service.get_h5_structure()
#     print(result)
 
