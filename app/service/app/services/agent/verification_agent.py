"""
Verification Agent

Agent for diagnosing issues in the workflow execution pipeline.
Determines whether problems are in workflow planning, model output, or coding stages.
"""

import os
import re
import json
from typing import Dict, Any, List, Optional
from openai import OpenAI

from app.services import llm_config

# PROMPTS_DIR is in parent directory (app/services/prompts)
PROMPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "prompts")


def _read_text(path: str) -> str:
    """Read text file with UTF-8 encoding"""
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


class VerificationAgent:
    """
    Agent for verifying and diagnosing workflow execution results.
    
    The workflow execution pipeline consists of three stages:
    1. Workflow Planning - generates processing steps
    2. Model Execution - runs models and produces outputs
    3. Code Generation & Analysis - generates and executes code to analyze results
    
    This agent diagnoses which stage has issues when results are incorrect or unsatisfactory.
    """
    
    def __init__(self, model: Optional[str] = None):
        """
        Initialize the verification agent.
        
        Args:
            model: OpenAI model to use for vision tasks (default: "gpt-5.2")
        """
        self.client = OpenAI()
        self.model = model or llm_config.model_for("OPENAI_VISION_MODEL")
        
        # Load prompt template
        prompt_path = os.path.join(PROMPTS_DIR, "verification_prompt.txt")
        self.prompt_template = _read_text(prompt_path) if os.path.exists(prompt_path) else None
    
    def diagnose_result(
        self,
        user_query: str,
        result_overlay_thumbnail_path: str,
        original_thumbnail_path: str,
        workflow_steps: Optional[List[Dict[str, Any]]] = None,
        generated_code: Optional[str] = None,
        code_execution_result: Optional[Any] = None,
        final_result: Optional[Any] = None,
        error_message: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Diagnose issues in workflow execution by analyzing the entire pipeline.
        
        Args:
            user_query: Original user query/question
            result_overlay_thumbnail_path: Path to thumbnail with result overlay
            original_thumbnail_path: Path to original image thumbnail
            workflow_steps: List of workflow steps generated in planning stage
            generated_code: Code generated in coding stage
            code_execution_result: Result from executing the generated code
            final_result: Final result returned to user
            error_message: Any error message encountered during execution
        
        Returns:
            {
                "issue_stage": str - "workflow_planning" | "model_prediction" | "coding" | "none"
                "confidence": str - "high" | "medium" | "low"
                "reasoning": str - Detailed explanation of the diagnosis
                "suggestions": List[str] - Suggestions for fixing the issue
                "stage_details": {
                    "workflow_planning": {
                        "has_issue": bool,
                        "issues": List[str]
                    },
                    "model_prediction": {
                        "has_issue": bool,
                        "issues": List[str]
                    },
                    "coding": {
                        "has_issue": bool,
                        "issues": List[str]
                    }
                }
            }
        """
        # Use prompt template if available
        if not self.prompt_template:
            raise ValueError("Prompt template file not found. Please ensure verification_prompt.txt exists in app/services/prompts/")
        
        prompt = self.prompt_template.format(
            user_query=user_query,
            workflow_steps=json.dumps(workflow_steps, indent=2) if workflow_steps else "None",
            generated_code=generated_code or "None",
            code_execution_result=str(code_execution_result) if code_execution_result is not None else "None",
            final_result=str(final_result) if final_result is not None else "None",
            error_message=error_message or "None"
        )
        
        # Prepare content for API call
        content = [{"type": "text", "text": prompt}]
        
        # Helper function to add image to content
        def add_image_to_content(image_path: str):
            if image_path and os.path.exists(image_path):
                import base64
            with open(image_path, "rb") as image_file:
                image_data = image_file.read()
                image_base64 = base64.b64encode(image_data).decode('utf-8')
                
                # Determine image MIME type
                image_ext = os.path.splitext(image_path)[1].lower()
                if image_ext in ['.jpg', '.jpeg']:
                    mime_type = 'image/jpeg'
                elif image_ext == '.png':
                    mime_type = 'image/png'
                else:
                    mime_type = 'image/jpeg'  # Default to jpeg
                
                    content.append({
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{mime_type};base64,{image_base64}"
                    }
                })
        
        # Add original thumbnail first, then result overlay thumbnail
        add_image_to_content(original_thumbnail_path)
        add_image_to_content(result_overlay_thumbnail_path)
        
        # Call OpenAI API
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {
                    "role": "user",
                    "content": content
                }
            ],
            temperature=0.3,
            max_tokens=1000
        )
        
        # Parse response
        response_text = response.choices[0].message.content
        
        # Try to extract JSON from response
        json_match = re.search(r'\{[^{}]*\}', response_text, re.DOTALL)
        if json_match:
            try:
                result = json.loads(json_match.group())
                # Validate result structure
                if "issue_stage" not in result:
                    result["issue_stage"] = "none"
                if "confidence" not in result:
                    result["confidence"] = "low"
                if "reasoning" not in result:
                    result["reasoning"] = response_text[:200] if response_text else "Unable to provide detailed reasoning"
                if "suggestions" not in result:
                    result["suggestions"] = []
                if "stage_details" not in result:
                    result["stage_details"] = {}
                
                return result
            except json.JSONDecodeError:
                # If parsing fails, return structured response based on text
                return {
                    "issue_stage": "none",
                    "confidence": "low",
                    "reasoning": response_text[:200] if response_text else "Unable to parse LLM response",
                    "suggestions": [],
                    "stage_details": {}
                }
        else:
            # If no JSON found, return based on text response
            return {
                "issue_stage": "none",
                "confidence": "low",
                "reasoning": response_text[:200] if response_text else "Unable to parse LLM response",
                "suggestions": [],
                "stage_details": {}
            }


# Singleton instance
_verification_agent: Optional[VerificationAgent] = None


def get_verification_agent() -> VerificationAgent:
    """Get or create the verification agent instance"""
    global _verification_agent
    if _verification_agent is None:
        model = llm_config.model_for("OPENAI_VISION_MODEL")
        _verification_agent = VerificationAgent(model=model)
    return _verification_agent

