"""
Reflection Agent

Agent for reflecting on and evaluating cell classification using LLM vision models.
"""

import base64
import os
import re
import json
from typing import Dict, Any, List, Optional, Tuple
from collections import Counter
from openai import OpenAI

try:
    import zarr
    import numpy as np
    from sklearn.neighbors import NearestNeighbors
    from sklearn.cluster import KMeans
    from sklearn.metrics.pairwise import cosine_distances
    ZARR_AVAILABLE = True
except ImportError:
    ZARR_AVAILABLE = False
    zarr = None
    np = None
    NearestNeighbors = None
    KMeans = None
    cosine_distances = None

# try to import tqdm for progress bar
try:
    from tqdm import tqdm
    TQDM_AVAILABLE = True
except ImportError:
    TQDM_AVAILABLE = False
    # create a simple progress bar alternative
    def tqdm(iterable, desc=None, total=None):
        if desc:
            print(f"{desc}...")
        return iterable

# PROMPTS_DIR is in the sibling 'prompts' directory of this module.
PROMPTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prompts")


def _read_text(path: str) -> str:
    """Read text file with UTF-8 encoding"""
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


class ReflectionAgent:
    """Agent for reflecting on and evaluating cell classification using LLM"""
    
    def __init__(self, model: str = "chatgpt-4o-latest"):
        """
        Initialize the reflection agent.
        
        Args:
            model: OpenAI model to use for vision tasks (default: "chatgpt-4o-latest")
        """
        self.client = OpenAI()
        self.model = model
        
        # Load prompt template
        prompt_path = os.path.join(PROMPTS_DIR, "reflection_prompt.txt")
        self.prompt_template = _read_text(prompt_path) if os.path.exists(prompt_path) else None
    
    def batch_reflection(
        self,
        folder_path: str,
        available_classes: List[str],
        current_class: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Batch verify cell classifications from a folder of images using LLM vision.
        Scans folder for images matching pattern {cell_id}_{class_name}.jpeg
        and reflects each image's classification.
        
        Args:
            folder_path: Path to folder containing cell images
            available_classes: List of all available classes (including Negative control)
            current_class: Optional filter - only verify images with this class name
        
        Returns:
            {
                "results": List[Dict] - List of reflection results for each image
                "summary": Dict - Summary statistics
            }
        """
        if not os.path.exists(folder_path):
            raise FileNotFoundError(f"Folder not found: {folder_path}")
        
        if not os.path.isdir(folder_path):
            raise ValueError(f"Path is not a directory: {folder_path}")
        
        # Scan folder for image files matching pattern {cell_id}_{class_name}.jpeg
        # Group images by cell_id to find pairs of different sizes
        cell_images = {}  # {cell_id: {"class_name": str, "images": [filepaths]}}
        
        for filename in os.listdir(folder_path):
            if filename.lower().endswith(('.jpeg', '.jpg', '.png')):
                # Parse filename: {cell_id}_{class_name}.jpeg or {cell_id}_{class_name}_{suffix}.jpeg
                name_without_ext = os.path.splitext(filename)[0]
                parts = name_without_ext.split('_', 1)
                if len(parts) == 2:
                    cell_id, rest = parts
                    # Extract class_name (before any size suffix like _detail, _context, _small, _large, _256, _512)
                    class_name_parts = rest.rsplit('_', 1)
                    if len(class_name_parts) == 2:
                        suffix = class_name_parts[1].lower()
                        # Check if suffix is a size identifier (numeric like 256, 512, or descriptive like detail, context)
                        if suffix in ['detail', 'context', 'small', 'large', 'close', 'wide'] or suffix.isdigit():
                            class_name = class_name_parts[0]
                        else:
                            class_name = rest
                    else:
                        class_name = rest
                    
                    # Replace underscores in class_name back to spaces
                    class_name = class_name.replace('_', ' ')
                    
                    # Filter by current_class if provided
                    if current_class is None or class_name == current_class:
                        if cell_id not in cell_images:
                            cell_images[cell_id] = {
                                "class_name": class_name,
                                "images": []
                            }
                        cell_images[cell_id]["images"].append(os.path.join(folder_path, filename))
        
        if not cell_images:
            return {
                "results": [],
                "summary": {
                    "total": 0,
                    "reflected": 0,
                    "correct": 0,
                    "incorrect": 0
                }
            }
        
        # Verify each cell (with potentially multiple images)
        results = []
        for cell_id, cell_info in cell_images.items():
            try:
                # Sort images to ensure consistent ordering (detail/close first, then context/wide)
                images = sorted(cell_info["images"])
                
                # Use first two images if available (detail and context)
                image_paths = images[:2] if len(images) >= 2 else images
                
                result = self.verify_classification(
                    image_paths=image_paths,
                    current_class=cell_info["class_name"],
                    available_classes=available_classes
                )
                result["cell_id"] = cell_id
                result["filenames"] = [os.path.basename(p) for p in image_paths]
                results.append(result)
            except Exception as e:
                results.append({
                    "cell_id": cell_id,
                    "filenames": [os.path.basename(p) for p in cell_info["images"]] if cell_info["images"] else [],
                    "error": str(e),
                    "is_correct": False
                })
        
        # Calculate summary
        reflected = len([r for r in results if "error" not in r])
        correct = len([r for r in results if r.get("is_correct", False)])
        incorrect = reflected - correct
        
        return {
            "results": results,
            "summary": {
                "total": len(cell_images),
                "reflected": reflected,
                "correct": correct,
                "incorrect": incorrect
            }
        }
    
    def verify_classification(
        self,
        image_paths: List[str],
        current_class: str,
        available_classes: List[str]
    ) -> Dict[str, Any]:
        """
        Verify if cell classification is correct using LLM vision model.
        Can accept one or two images (detail and context views).
        
        Args:
            image_paths: List of paths to cell image files (1-2 images: detail and context)
            current_class: Current classification
            available_classes: List of all available classes (including Negative control)
        
        Returns:
            {
                "is_correct": bool - whether classification is correct
                "correct_class": str - correct classification (if is_correct is False)
                "confidence": str - confidence level (high/medium/low)
                "reasoning": str - reasoning for the judgment
            }
        
        Raises:
            FileNotFoundError: If image file does not exist
            Exception: For other errors during reflection
        """
        # Normalize input: accept single path or list
        if isinstance(image_paths, str):
            image_paths = [image_paths]
        
        if not image_paths:
            raise ValueError("At least one image path is required")
        
        # Check if image files exist
        for image_path in image_paths:
            if not os.path.exists(image_path):
                raise FileNotFoundError(f"Image file not found: {image_path}")
        
        # Debug: print current class
        image_names = [os.path.basename(p) for p in image_paths]
        print(f"[reflection] Current class: {current_class}, Images: {image_names}")
        
        # Read images and convert to base64
        image_contents = []
        for image_path in image_paths:
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
                
                image_contents.append({
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{mime_type};base64,{image_base64}"
                    }
                })
        
        # Build prompt
        available_classes_str = ", ".join(available_classes)
        
        if len(image_contents) == 2:
            image_description = "You are provided with TWO images of the same cell:\n- First image: Close-up/detail view showing cell morphology and fine details\n- Second image: Wider context view showing the cell's surrounding tissue environment\n\nIMPORTANT: Analyze BOTH images together. Use the detail view to examine cell morphology and the context view to understand the tissue environment and cell-cell interactions."
        else:
            image_description = "IMPORTANT: Focus on analyzing the cell highlighted by the yellow contour/outline in the image. The yellow border marks the specific cell that needs to be classified."
        
        # Use prompt template from file
        if not self.prompt_template:
            raise ValueError("Prompt template file not found. Please ensure reflection_prompt.txt exists in app/services/prompts/")
        
        prompt = self.prompt_template.format(
            current_class=current_class,
            available_classes_str=available_classes_str,
            image_description=image_description
        )
        
        # Call OpenAI Vision API with one or two images
        content = [{"type": "text", "text": prompt}] + image_contents
        
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {
                    "role": "user",
                    "content": content
                }
            ],
            temperature=0.3,  # Lower temperature for more stable results
            max_tokens=500
        )
        
        # Parse response
        response_text = response.choices[0].message.content
        
        # Try to extract JSON from response
        json_match = re.search(r'\{[^{}]*\}', response_text, re.DOTALL)
        if json_match:
            try:
                result = json.loads(json_match.group())
                # Validate result
                if "is_correct" not in result:
                    result["is_correct"] = True  # Default to keeping original if uncertain
                
                # Check if LLM explicitly indicates inability to analyze (only check in reasoning or explicit statements)
                response_lower = response_text.lower()
                reasoning_lower = result.get("reasoning", "").lower()
                # Only trigger if there's an explicit statement of inability, not just words like "uncertain" in normal analysis
                explicit_unable_phrases = [
                    "i am unable to analyze",
                    "i cannot analyze", 
                    "unable to analyze this",
                    "cannot analyze this",
                    "cannot determine from this image",
                    "image quality too poor to analyze",
                    "insufficient information to analyze"
                ]
                is_explicitly_unable = any(phrase in response_lower or phrase in reasoning_lower for phrase in explicit_unable_phrases)
                
                # If explicitly unable AND confidence is low, preserve original classification
                confidence_low = result.get("confidence", "").lower() == "low"
                if is_explicitly_unable and confidence_low:
                    result["is_correct"] = True
                    result["correct_class"] = current_class
                    result["confidence"] = "low"
                    # Only override reasoning if it's empty or doesn't explain the uncertainty
                    if not result.get("reasoning") or len(result.get("reasoning", "")) < 20:
                        result["reasoning"] = "Unable to analyze with certainty, preserving original classification"
                
                if not result.get("is_correct") and "correct_class" in result:
                    # Ensure correct_class is in available_classes
                    if result["correct_class"] not in available_classes:
                        # If not in list and confidence is high/medium, try to use "Negative control" if available
                        # Otherwise, preserve original classification
                        if result.get("confidence", "").lower() in ["high", "medium"] and "Negative control" in available_classes:
                            result["correct_class"] = "Negative control"
                            if not result.get("reasoning") or "not in available classes" not in result.get("reasoning", ""):
                                result["reasoning"] = (result.get("reasoning", "") + " Suggested class not in available classes, using Negative control.").strip()
                        else:
                            # Low confidence or Negative control not available - preserve original
                            result["is_correct"] = True
                            result["correct_class"] = current_class
                            result["confidence"] = "low"
                            if not result.get("reasoning") or "not in available classes" not in result.get("reasoning", ""):
                                result["reasoning"] = (result.get("reasoning", "") + " Suggested class not in available classes, preserving original classification.").strip()
                
                # Ensure confidence and reasoning fields exist
                if "confidence" not in result:
                    result["confidence"] = "medium"
                if "reasoning" not in result:
                    result["reasoning"] = response_text[:200] if response_text else "Unable to provide detailed reasoning"
                
                # Debug: print reasoning
                print(f"[reflection] Reasoning: {result.get('reasoning', 'N/A')}")
                print(f"[reflection] Result: is_correct={result.get('is_correct')}, correct_class={result.get('correct_class')}, confidence={result.get('confidence')}")
                
                return result
            except json.JSONDecodeError:
                # If parsing fails, try to extract information from text
                response_lower = response_text.lower()
                is_correct = "correct" in response_lower or "yes" in response_lower
                reasoning = response_text[:200] if response_text else "Unable to parse LLM response"
                print(f"[reflection] JSON parse failed. Reasoning: {reasoning}")
                return {
                    "is_correct": is_correct,
                    "correct_class": current_class,  # Use original when uncertain
                    "confidence": "medium",
                    "reasoning": reasoning
                }
        else:
            # If no JSON found, return based on text response
            response_lower = response_text.lower()
            is_correct = "correct" in response_lower
            reasoning = response_text[:200] if response_text else "Unable to parse LLM response"
            print(f"[reflection] No JSON found. Reasoning: {reasoning}")
            return {
                "is_correct": is_correct,
                "correct_class": current_class,  # Use original class
                "confidence": "medium",
                "reasoning": reasoning
            }
    
    def find_suspicious_cells(
        self,
        zarr_path: str,
        cell_ids: Optional[List[int]] = None,
        k_neighbors: int = 10,
        consistency_threshold: float = 0.7,
        use_probability: bool = True,
        probability_threshold: float = 0.6
    ) -> List[int]:
        """
        Find suspicious cells (reflection on active learning)
        
        Core idea: in the embedding space, similar cells should have similar classifications.
        If a cell's nearest neighbors are mostly class_A, but XGBoost predicts it as class_B,
        it may be suspicious.
        
        Args:
            zarr_path: Zarr file path
            cell_ids: List of cell IDs to check, if None then check all cells
            k_neighbors: Number of neighbors to check (default 10)
            consistency_threshold: Consistency threshold, ratio of majority class in neighbors (default 0.7)
            use_probability: Whether to use XGBoost prediction probability (default True)
            probability_threshold: Prediction probability threshold, below which is considered uncertain (default 0.6)
        
        Returns:
            List[int] - List of suspicious cell IDs
        """
        if not ZARR_AVAILABLE:
            return []
        
        try:
            # 1. load data
            z = zarr.open(zarr_path, mode='r')
            
            # load embeddings
            if 'SegmentationNode' not in z or 'embedding' not in z['SegmentationNode']:
                return []
            embeddings = z['SegmentationNode/embedding'][:]
            
            # load XGBoost prediction results
            if 'ClassificationNode' not in z:
                return []
            cn = z['ClassificationNode']
            
            # predict class IDs
            if 'nuclei_class_id' not in cn:
                return []
            predicted_class_ids = cn['nuclei_class_id'][:]
            
            # predict probabilities
            predicted_probs = None
            if 'nuclei_class_probabilities' in cn:
                predicted_probs = cn['nuclei_class_probabilities'][:]
            
            # determine list of cells to check
            if cell_ids is None:
                cell_ids = list(range(len(embeddings)))
            
            # 2. build KNN index (build once, improve efficiency)
            print(f"[Suspicious Cell Detection] Building KNN index for {len(embeddings)} cells...")
            nn = NearestNeighbors(n_neighbors=k_neighbors + 1, metric='cosine', n_jobs=-1)
            nn.fit(embeddings)
            print(f"[Suspicious Cell Detection] KNN index built. Checking {len(cell_ids)} cells...")
            
            # 3. batch check all cells (use batch query to improve efficiency)
            suspicious_cells = []
            
            # batch process, each time process a batch of cells
            batch_size = 1000
            total_batches = (len(cell_ids) + batch_size - 1) // batch_size
            
            for batch_idx in tqdm(range(total_batches), desc="Checking cells", total=total_batches):
                start_idx = batch_idx * batch_size
                end_idx = min(start_idx + batch_size, len(cell_ids))
                batch_cell_ids = cell_ids[start_idx:end_idx]
                
                # batch query neighbors (more efficient)
                batch_embeddings = embeddings[batch_cell_ids]
                distances, indices = nn.kneighbors(batch_embeddings)
                
                for i, cell_id in enumerate(batch_cell_ids):
                    if cell_id < 0 or cell_id >= len(embeddings):
                        continue
                    
                    # get current cell's prediction
                    current_class_id = int(predicted_class_ids[cell_id])
                    current_prob = float(predicted_probs[cell_id][current_class_id]) if predicted_probs is not None else None
                    
                    # get neighbors from batch query results (already calculated)
                    neighbor_ids = indices[i][1:].tolist()  # exclude self
                
                # count class distribution of neighbors
                neighbor_class_ids = [int(predicted_class_ids[nid]) for nid in neighbor_ids]
                class_distribution = Counter(neighbor_class_ids)
                
                if not class_distribution:
                    continue
                
                # find majority class
                majority_class_id, majority_count = class_distribution.most_common(1)[0]
                consistency_score = majority_count / k_neighbors
                
                # check if suspicious
                is_suspicious = False
                
                # check 1: neighbor majority class differs from current prediction
                if majority_class_id != current_class_id:
                    if consistency_score >= consistency_threshold:
                        is_suspicious = True
                
                # check 2: combine XGBoost prediction probability
                if use_probability and predicted_probs is not None:
                    if current_prob is not None and current_prob < probability_threshold:
                        is_suspicious = True
                
                    if is_suspicious:
                        suspicious_cells.append(cell_id)
            
            print(f"[Suspicious Cell Detection] Found {len(suspicious_cells)} suspicious cells out of {len(cell_ids)} checked.")
            return suspicious_cells
            
        except Exception as e:
            print(f"[Suspicious Cell Detection] Error: {e}")
            return []
    
    def find_conflicting_cells(
        self,
        zarr_path: str,
        cell_ids: Optional[List[int]] = None,
        k_neighbors: int = 10,
        consistency_threshold: float = 0.7,
        check_user_annotation: bool = True,
        check_xgboost_prediction: bool = True
    ) -> List[int]:
        """
        Detect conflicting cells: user annotations differ from model predictions
        
        Check two cases:
        1. User annotations vs nearest neighbor majority class (neighbors majority)
        2. User annotations vs XGBoost predictions (if XGBoost predictions are consistent with neighbors, but user annotations differ)
        
        Args:
            zarr_path: Zarr file path
            cell_ids: List of cell IDs to check, if None then check all cells
            k_neighbors: Number of neighbors to check (default 10)
            consistency_threshold: Consistency threshold, ratio of majority class in neighbors (default 0.7)
            check_user_annotation: Whether to check user annotation conflicts (default True)
            check_xgboost_prediction: Whether to check XGBoost prediction conflicts (default True)
        
        Returns:
            List[int] - List of conflicting cell IDs
        """
        if not ZARR_AVAILABLE:
            return []
        
        try:
            # 1. load data
            z = zarr.open(zarr_path, mode='r')
            
            # load embeddings
            if 'SegmentationNode' not in z or 'embedding' not in z['SegmentationNode']:
                return []
            embeddings = z['SegmentationNode/embedding'][:]
            
            # load XGBoost prediction results
            if 'ClassificationNode' not in z:
                return []
            cn = z['ClassificationNode']
            
            # predict class IDs
            if 'nuclei_class_id' not in cn:
                return []
            predicted_class_ids = cn['nuclei_class_id'][:]
            
            # class names
            class_names = []
            if 'nuclei_class_name' in cn:
                class_names_data = cn['nuclei_class_name'][:]
                class_names = [
                    name.decode('utf-8') if isinstance(name, bytes) else str(name)
                    for name in class_names_data
                ]
            
            # load user annotations
            user_annotations = {}
            if check_user_annotation and 'user_annotation' in z:
                ua = z['user_annotation']
                if 'nuclei_annotations' in ua:
                    try:
                        raw_bytes = ua['nuclei_annotations'][()]
                        if raw_bytes:
                            annotations_str = raw_bytes.decode('utf-8') if isinstance(raw_bytes, bytes) else str(raw_bytes)
                            annotations_dict = json.loads(annotations_str)
                            # convert to {cell_id: class_name} format
                            for ann_key, ann_data in annotations_dict.items():
                                if isinstance(ann_data, dict):
                                    cell_id = ann_data.get('cell_ID')
                                    cell_class = ann_data.get('cell_class')
                                    if cell_id is not None and cell_class is not None:
                                        user_annotations[int(cell_id)] = str(cell_class)
                    except Exception as e:
                        print(f"[Conflict Detection] Warning: Could not load user annotations: {e}")
            
            # if no user annotations, return empty list
            if not user_annotations:
                return []
            
            # determine list of cells to check (only check cells with user annotations)
            if cell_ids is None:
                cell_ids = list(user_annotations.keys())
            else:
                # only check cells with user annotations
                cell_ids = [cid for cid in cell_ids if cid in user_annotations]
            
            if not cell_ids:
                return []
            
            # 2. build KNN index
            print(f"[Conflict Detection] Building KNN index for {len(embeddings)} cells...")
            nn = NearestNeighbors(n_neighbors=k_neighbors + 1, metric='cosine', n_jobs=-1)
            nn.fit(embeddings)
            print(f"[Conflict Detection] KNN index built. Checking {len(cell_ids)} annotated cells...")
            
            # 3. check conflicts (batch processing)
            conflicting_cells = []
            
            # batch process
            batch_size = 1000
            total_batches = (len(cell_ids) + batch_size - 1) // batch_size
            
            for batch_idx in tqdm(range(total_batches), desc="Checking conflicts", total=total_batches):
                start_idx = batch_idx * batch_size
                end_idx = min(start_idx + batch_size, len(cell_ids))
                batch_cell_ids = cell_ids[start_idx:end_idx]
                
                # batch query neighbors
                batch_embeddings = embeddings[batch_cell_ids]
                distances, indices = nn.kneighbors(batch_embeddings)
                
                for i, cell_id in enumerate(batch_cell_ids):
                    if cell_id < 0 or cell_id >= len(embeddings):
                        continue
                    
                    user_class = user_annotations[cell_id]
                    
                    # get neighbors from batch query results (already calculated)
                    neighbor_ids = indices[i][1:].tolist()  # exclude self
                
                # count class distribution of neighbors
                neighbor_class_ids = [int(predicted_class_ids[nid]) for nid in neighbor_ids]
                class_distribution = Counter(neighbor_class_ids)
                
                if not class_distribution:
                    continue
                
                # find majority class
                majority_class_id, majority_count = class_distribution.most_common(1)[0]
                majority_class = class_names[majority_class_id] if majority_class_id < len(class_names) else f"Class_{majority_class_id}"
                consistency_score = majority_count / k_neighbors
                
                # check conflicts
                has_conflict = False
                
                # check 1: user annotations vs nearest neighbor majority class
                if check_user_annotation:
                    if majority_class != user_class and consistency_score >= consistency_threshold:
                        has_conflict = True
                
                # check 2: user annotations vs XGBoost predictions (if XGBoost predictions are consistent with neighbors)
                if check_xgboost_prediction and not has_conflict:
                    xgboost_class_id = int(predicted_class_ids[cell_id])
                    xgboost_class = class_names[xgboost_class_id] if xgboost_class_id < len(class_names) else f"Class_{xgboost_class_id}"
                    
                    # if XGBoost predictions are consistent with neighbors majority, but user annotations differ
                    if xgboost_class == majority_class and xgboost_class != user_class:
                        if consistency_score >= consistency_threshold:
                            has_conflict = True
                
                    if has_conflict:
                        conflicting_cells.append(cell_id)
            
            print(f"[Conflict Detection] Found {len(conflicting_cells)} conflicting cells out of {len(cell_ids)} checked.")
            return conflicting_cells
            
        except Exception as e:
            print(f"[Conflict Detection] Error: {e}")
            return []
    
    def verify_suspicious_cell(
        self,
        zarr_path: str,
        cell_id: int,
        k_neighbors: int = 10,
        consistency_threshold: float = 0.7,
        use_probability: bool = True,
        probability_threshold: float = 0.6
    ) -> Dict[str, Any]:
        """
        Verify detailed information of suspicious cell (reflection on active learning)
        
        Core idea: in the embedding space, similar cells should have similar classifications.
        If a cell's nearest neighbors are mostly class_A, but XGBoost predicts it as class_B,
        it may be suspicious.
        
        Args:
            zarr_path: Zarr file path
            cell_id: Cell ID to check (index)
            k_neighbors: Number of neighbors to check (default 10)
            consistency_threshold: Consistency threshold, ratio of majority class in neighbors (default 0.7)
            use_probability: Whether to use XGBoost prediction probability (default True)
            probability_threshold: Prediction probability threshold, below which is considered uncertain (default 0.6)
        
        Returns:
            {
                "is_suspicious": bool - Whether suspicious
                "cell_id": int - cell ID
                "current_class": str - XGBoost prediction class
                "current_class_id": int - class ID
                "current_probability": float - prediction probability
                "neighbor_majority_class": str - majority class in neighbors
                "neighbor_majority_class_id": int - majority class ID
                "consistency_score": float - consistency score (ratio of majority class in neighbors)
                "neighbor_distribution": dict - neighbor class distribution {class_name: count}
                "neighbor_distribution_ratio": dict - neighbor class distribution ratio {class_name: ratio}
                "reasoning": str - reasoning
                "confidence": str - confidence (high/medium/low)
            }
        """
        if not ZARR_AVAILABLE:
            return {
                "error": "Required libraries (zarr, numpy, sklearn) not available",
                "is_suspicious": False
            }
        
        try:
            # 1. load data
            z = zarr.open(zarr_path, mode='r')
            
            # load embeddings
            if 'SegmentationNode' not in z or 'embedding' not in z['SegmentationNode']:
                return {
                    "error": "Embeddings not found in SegmentationNode/embedding",
                    "is_suspicious": False
                }
            embeddings = z['SegmentationNode/embedding'][:]
            
            # load XGBoost prediction results
            if 'ClassificationNode' not in z:
                return {
                    "error": "ClassificationNode not found",
                    "is_suspicious": False
                }
            cn = z['ClassificationNode']
            
            # predict class IDs
            if 'nuclei_class_id' not in cn:
                return {
                    "error": "nuclei_class_id not found in ClassificationNode",
                    "is_suspicious": False
                }
            predicted_class_ids = cn['nuclei_class_id'][:]
            
            # predict probabilities
            predicted_probs = None
            if 'nuclei_class_probabilities' in cn:
                predicted_probs = cn['nuclei_class_probabilities'][:]
            
            # class names
            class_names = []
            if 'nuclei_class_name' in cn:
                class_names_data = cn['nuclei_class_name'][:]
                class_names = [
                    name.decode('utf-8') if isinstance(name, bytes) else str(name)
                    for name in class_names_data
                ]
            
            # verify cell_id range
            if cell_id < 0 or cell_id >= len(embeddings):
                return {
                    "error": f"cell_id {cell_id} out of range (0-{len(embeddings)-1})",
                    "is_suspicious": False
                }
            
            # 2. get current cell information
            current_class_id = int(predicted_class_ids[cell_id])
            current_class = class_names[current_class_id] if current_class_id < len(class_names) else f"Class_{current_class_id}"
            current_prob = float(predicted_probs[cell_id][current_class_id]) if predicted_probs is not None else None
            
            # 3. build KNN index and find nearest neighbors
            # use cosine distance (suitable for high-dimensional embeddings)
            nn = NearestNeighbors(n_neighbors=k_neighbors + 1, metric='cosine', n_jobs=-1)
            nn.fit(embeddings)
            
            # find nearest neighbors (+1 because includes self)
            distances, indices = nn.kneighbors([embeddings[cell_id]])
            neighbor_ids = indices[0][1:].tolist()  # exclude self
            
            # 4. count class distribution of neighbors
            neighbor_class_ids = [int(predicted_class_ids[nid]) for nid in neighbor_ids]
            class_distribution = Counter(neighbor_class_ids)
            
            # find majority class
            if not class_distribution:
                return {
                    "error": "No neighbors found",
                    "is_suspicious": False
                }
            
            majority_class_id, majority_count = class_distribution.most_common(1)[0]
            majority_class = class_names[majority_class_id] if majority_class_id < len(class_names) else f"Class_{majority_class_id}"
            consistency_score = majority_count / k_neighbors
            
            # build neighbor class distribution (by class name)
            neighbor_distribution = {}
            neighbor_distribution_ratio = {}
            for class_id, count in class_distribution.items():
                class_name = class_names[class_id] if class_id < len(class_names) else f"Class_{class_id}"
                neighbor_distribution[class_name] = count
                neighbor_distribution_ratio[class_name] = count / k_neighbors
            
            # 5. check if suspicious
            is_suspicious = False
            reasoning_parts = []
            confidence = "medium"
            
            # check 1: neighbor majority class differs from current prediction
            if majority_class_id != current_class_id:
                if consistency_score >= consistency_threshold:
                    is_suspicious = True
                    reasoning_parts.append(
                        f"Neighbor majority ({majority_class}, {consistency_score:.1%}) "
                        f"differs from prediction ({current_class})"
                    )
                    if consistency_score >= 0.9:
                        confidence = "high"
                    elif consistency_score >= 0.8:
                        confidence = "medium"
                    else:
                        confidence = "low"
            
            # check 2: combine XGBoost prediction probability
            if use_probability and predicted_probs is not None:
                if current_prob is not None and current_prob < probability_threshold:
                    is_suspicious = True
                    reasoning_parts.append(
                        f"Low prediction probability ({current_prob:.2f} < {probability_threshold})"
                    )
                    if current_prob < 0.4:
                        confidence = "high"
                    elif current_prob < 0.5:
                        confidence = "medium"
                    else:
                        confidence = "low"
            
            # combine reasoning
            if not reasoning_parts:
                reasoning = "Classification appears consistent with nearest neighbors"
            else:
                reasoning = "; ".join(reasoning_parts)
            
            return {
                "is_suspicious": is_suspicious,
                "cell_id": cell_id,
                "current_class": current_class,
                "current_class_id": current_class_id,
                "current_probability": current_prob,
                "neighbor_majority_class": majority_class,
                "neighbor_majority_class_id": majority_class_id,
                "consistency_score": float(consistency_score),
                "neighbor_distribution": neighbor_distribution,
                "neighbor_distribution_ratio": neighbor_distribution_ratio,
                "reasoning": reasoning,
                "confidence": confidence
            }
            
        except Exception as e:
            return {
                "error": f"Error during reflection: {str(e)}",
                "is_suspicious": False
            }
    
    def suggest_samples(
        self,
        zarr_path: str,
        class_names: List[str],
        n_samples_per_cluster: int = 20,
        n_boundary_samples: int = 2
    ) -> Dict[str, Any]:
        """
        Suggest annotation samples by clustering embeddings.
        For each class, select representative samples (center + boundary) from the cluster.
        
        Args:
            zarr_path: Zarr file path
            class_names: List of class names (corresponds to number of clusters)
            n_samples_per_cluster: Number of samples to select per cluster (default 20)
            n_boundary_samples: Number of boundary samples per cluster (default 2, rest are center samples)
        
        Returns:
            {
                "class_names": List[str] - class names
                "n_clusters": int - number of clusters
                "n_samples_per_cluster": int - samples per cluster
                "clusters": {
                    cluster_id: {
                        "cluster_id": int,
                        "class_name": str,
                        "cell_ids": List[int],
                        "total_cells_in_cluster": int
                    }
                }
            }
        """
        if not ZARR_AVAILABLE or KMeans is None:
            return {
                "error": "Required libraries (zarr, numpy, sklearn) not available",
                "clusters": {}
            }
        
        try:
            # 1. load data
            z = zarr.open(zarr_path, mode='r')
            
            # load embeddings
            if 'SegmentationNode' not in z or 'embedding' not in z['SegmentationNode']:
                return {
                    "error": "Embeddings not found in SegmentationNode/embedding",
                    "clusters": {}
                }
            embeddings = z['SegmentationNode/embedding'][:]
            
            n_clusters = len(class_names)
            n_center_samples = n_samples_per_cluster - n_boundary_samples
            
            # 2. run KMeans clustering
            print(f"[Annotation Suggestion] Running KMeans clustering with {n_clusters} clusters...")
            kmeans = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
            cluster_labels = kmeans.fit_predict(embeddings)
            
            # count cells in each cluster
            cluster_counts = Counter(cluster_labels)
            print("[Annotation Suggestion] Cluster distribution:")
            for cluster_id in sorted(cluster_counts.keys()):
                print(f"  Cluster {cluster_id} ({class_names[cluster_id]}): {cluster_counts[cluster_id]} cells")
            
            # 3. select representative samples from each cluster
            print(f"[Annotation Suggestion] Selecting {n_samples_per_cluster} samples per cluster...")
            suggested_cells_by_cluster = {}
            
            for cluster_id in range(n_clusters):
                # find all cells in this cluster
                cluster_mask = cluster_labels == cluster_id
                cluster_cell_ids = np.where(cluster_mask)[0]
                
                if len(cluster_cell_ids) == 0:
                    print(f"  Cluster {cluster_id}: No cells found!")
                    continue
                
                # get cluster embeddings
                cluster_embeddings = embeddings[cluster_cell_ids]
                cluster_center = kmeans.cluster_centers_[cluster_id]
                
                # 1. select center samples (representative)
                nn = NearestNeighbors(n_neighbors=min(n_center_samples, len(cluster_cell_ids)), 
                                     metric='cosine')
                nn.fit(cluster_embeddings)
                distances, indices = nn.kneighbors([cluster_center])
                center_samples = cluster_cell_ids[indices[0][:n_center_samples]]
                
                # 2. select boundary samples (diversity)
                distances_to_center = cosine_distances(cluster_embeddings, [cluster_center]).flatten()
                far_indices = np.argsort(distances_to_center)[-n_boundary_samples:]
                boundary_samples = cluster_cell_ids[far_indices]
                
                # combine samples
                selected_samples = np.concatenate([center_samples, boundary_samples])
                suggested_cells_by_cluster[cluster_id] = selected_samples.tolist()
                
                print(f"  Cluster {cluster_id} ({class_names[cluster_id]}): Selected {len(selected_samples)} samples")
            
            # 4. build results
            results = {
                "class_names": class_names,
                "n_clusters": n_clusters,
                "n_samples_per_cluster": n_samples_per_cluster,
                "clusters": {}
            }
            
            for cluster_id, cell_ids in suggested_cells_by_cluster.items():
                results["clusters"][cluster_id] = {
                    "cluster_id": int(cluster_id),
                    "class_name": class_names[cluster_id],
                    "cell_ids": cell_ids,
                    "total_cells_in_cluster": int(cluster_counts[cluster_id])
                }
            
            print(f"[Annotation Suggestion] Generated suggestions for {n_clusters} clusters, {sum(len(ids) for ids in suggested_cells_by_cluster.values())} total samples")
            return results
            
        except Exception as e:
            print(f"[Annotation Suggestion] Error: {e}")
            return {
                "error": f"Error during annotation suggestion: {str(e)}",
                "clusters": {}
            }


# Singleton instance
_reflection_agent: Optional[ReflectionAgent] = None


def get_reflection_agent() -> ReflectionAgent:
    """Get or create the reflection agent instance"""
    global _reflection_agent
    if _reflection_agent is None:
        model = os.getenv("OPENAI_VISION_MODEL", "chatgpt-4o-latest")
        _reflection_agent = ReflectionAgent(model=model)
    return _reflection_agent

