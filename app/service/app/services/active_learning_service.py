import h5py
import numpy as np
import json
import logging
from typing import Dict, List, Optional, Tuple
import os
import base64
from io import BytesIO
from datetime import datetime
from PIL import Image, ImageDraw, ImageFont
from app.utils import resolve_path
from app.services.tasks_service import get_cell_review_tile_data
from app.services.seg_service import SegmentationHandler

logger = logging.getLogger(__name__)

_reclassified_cells = {}


def _handle_special_class_candidates(params: Dict, reclassified_for_this_class: List, slide_path: str) -> Dict:
    try:
        items = []
        existing_cell_ids = set()  # Track to avoid duplicates
        
        # Load H5 file to get basic data for reclassified cells
        h5_path = slide_path + '.h5' if not slide_path.endswith('.h5') else slide_path
        
        with h5py.File(h5_path, 'r') as hf:
            # Find morphology data
            seg_group = None
            if 'nuclei_segmentation' in hf:
                seg_group = hf['nuclei_segmentation']
            elif 'SegmentationNode' in hf:
                seg_group = hf['SegmentationNode']
            elif 'morphology' in hf:
                seg_group = hf['morphology']
            
            if seg_group is None or 'centroids' not in seg_group:
                logger.error(f"[AL] No morphology data found for special class")
                return {"success": True, "data": {"total": 0, "hist": [0]*20, "items": []}}
            
            centroids = seg_group['centroids'][:]
            contours = seg_group.get('contours', None)
            
            # Process each reclassified cell
            for reclassified_cell in reclassified_for_this_class:
                try:
                    cell_id = int(reclassified_cell["cell_id"])
                    cell_id_str = str(cell_id)
                    
                    # Skip if already processed (avoid duplicates)
                    if cell_id_str in existing_cell_ids:
                        logger.warning(f"[AL] Skipping duplicate special class cell {cell_id_str}")
                        continue
                    existing_cell_ids.add(cell_id_str)
                    
                    # Get cell data from H5 file
                    if cell_id >= len(centroids):
                        logger.warning(f"[AL] Cell {cell_id} index out of range for centroids")
                        continue
                        
                    centroid = centroids[cell_id]
                    
                    # Generate image for reclassified cell
                    try:
                        tile_data = get_cell_review_tile_data({
                            "slide_id": params["slide_id"],
                            "cell_id": cell_id,
                            "centroid": {
                                "x": float(centroid[0]),
                                "y": float(centroid[1])
                            },
                            "window_size_px": 128,
                            "target_fov_um": 20.0,  # Standard FOV for cell review
                            "padding_ratio": 0.1,
                            "return_contour": True
                        })
                        
                        if tile_data.get("success", False):
                            crop_data = tile_data.get("data", {})
                            image_b64 = crop_data.get("image")
                            bounds = crop_data.get("bounds", {"x": 0, "y": 0, "w": 128, "h": 128})
                            bbox = crop_data.get("bbox", {"x": 54, "y": 54, "w": 20, "h": 20})
                            contour_from_api = crop_data.get("contour", [])
                        else:
                            logger.warning(f"[AL] Failed to get image for reclassified cell {cell_id}: {tile_data.get('error', 'unknown')}")
                            image_b64 = _generate_error_placeholder_image(f"Cell {cell_id}\nImage Error")
                            bounds = {"x": 0, "y": 0, "w": 128, "h": 128}
                            bbox = {"x": 54, "y": 54, "w": 20, "h": 20}
                            contour_from_api = []
                            
                    except Exception as img_error:
                        logger.warning(f"[AL] Failed to generate image for special class cell {cell_id}: {img_error}")
                        image_b64 = _generate_error_placeholder_image(f"Reclassified\nCell {cell_id}")
                        bounds = {"x": 0, "y": 0, "w": 128, "h": 128}
                        bbox = {"x": 54, "y": 54, "w": 20, "h": 20}
                        contour_from_api = []
                    
                    # Extract contour from H5 data if available and API didn't provide it
                    contour_from_h5 = []
                    if not contour_from_api and contours is not None and cell_id < len(contours):
                        try:
                            cell_contour = contours[cell_id]
                            if cell_contour.size > 0 and cell_contour.ndim == 2 and cell_contour.shape[1] == 2:
                                contour_from_h5 = [{"x": float(pt[0]), "y": float(pt[1])} for pt in cell_contour]
                        except Exception as contour_error:
                            logger.warning(f"[AL] Error processing contour for special class cell {cell_id}: {contour_error}")
                    
                    # Use API contour if available, otherwise H5 contour
                    final_contour = contour_from_api if contour_from_api else contour_from_h5
                    
                    # Create candidate item for special class
                    candidate_item = {
                        "cell_id": str(cell_id),
                        "prob": reclassified_cell["prob"],  # Keep original probability for reference
                        "centroid": {"x": float(centroid[0]), "y": float(centroid[1])},
                        "label": None,  # No label for special classes
                        "reclassified": True,
                        "original_class": reclassified_cell["original_class"],
                        "crop": {
                            "image": image_b64,
                            "bbox": bbox,
                            "bounds": bounds,
                            "contour": final_contour
                        }
                    }
                    items.append(candidate_item)
                    
                except Exception as e:
                    logger.warning(f"[AL] Error processing special class cell {reclassified_cell['cell_id']}: {e}")
                    continue
        
        # Return results for special class
        total_count = len(items)
        
        return {
            "success": True,
            "data": {
                "total": total_count,
                "hist": [0] * 20,  # No histogram for special classes
                "items": items
            }
        }
        
    except Exception as e:
        logger.error(f"[AL] Error handling special class: {str(e)}")
        return {"success": False, "error": f"Error handling special class: {str(e)}"}




def _load_reclassifications_from_h5(h5_path: str) -> Dict:
    try:
        
        if not os.path.exists(h5_path):
            logger.debug(f"[AL Load] H5 file not found: {h5_path}")
            return {}
        
        reclassified_data = {}
        
        # Use seg_service.py's pattern for loading manual annotations
        with h5py.File(h5_path, 'r') as h5_file:
            # Follow seg_service.py's _apply_manual_nuclei_annotations pattern
            if 'user_annotation' not in h5_file or 'nuclei_annotations' not in h5_file['user_annotation']:
                logger.debug(f"[AL Load] No user_annotation/nuclei_annotations found in H5 file: {h5_path}")
                return {}

            try:
                # Use same loading pattern as seg_service.py
                raw_bytes = h5_file['user_annotation/nuclei_annotations'][()]
                manual_annotations = json.loads(raw_bytes.decode("utf-8"))
            except Exception as e:
                logger.warning(f"[AL Load] Failed to load or parse manual annotations: {e}")
                return {}
                
            if not manual_annotations:
                logger.debug(f"[AL Load] Manual annotations are empty")
                return {}
            
            # Convert back to _reclassified_cells format, filtering for reclassifications only
            for cell_id, annotation_data in manual_annotations.items():
                # Only load reclassification annotations (skip manual annotations)
                if annotation_data.get("annotation_type") == "reclassification":
                    reclassified_data[cell_id] = {
                        "original_class": annotation_data.get("original_class"),
                        "new_class": annotation_data.get("cell_class"),  # zoo-main uses "cell_class"
                        "prob": annotation_data.get("probability", 0.0),
                        "timestamp": annotation_data.get("timestamp"),
                        # Maintain original_original_class for multi-step reclassification tracking
                        "original_original_class": annotation_data.get("original_class")
                    }
            
            if reclassified_data:
                pass
            
        return reclassified_data
        
    except Exception as e:
        logger.error(f"[AL Load] Error loading reclassifications from H5: {str(e)}")
        return {}


def _generate_error_placeholder_image(error_text: str = "Image Error") -> str:
    try:
        # Create a 128x128 gray placeholder image
        img = Image.new('RGB', (128, 128), color='#f0f0f0')
        draw = ImageDraw.Draw(img)
        
        # Add a subtle border
        draw.rectangle([0, 0, 127, 127], outline='#cccccc', width=1)
        
        # Add error text (try to use a basic font, fallback to default)
        try:
            font = ImageFont.load_default()
        except:
            font = None
            
        # Split text into lines and center them
        lines = error_text.split('\n')
        total_height = len(lines) * 12  # Approximate line height
        start_y = (128 - total_height) // 2
        
        for i, line in enumerate(lines):
            # Calculate text position to center it
            bbox = draw.textbbox((0, 0), line, font=font)
            text_width = bbox[2] - bbox[0]
            text_x = (128 - text_width) // 2
            text_y = start_y + i * 12
            
            # Draw text in dark gray
            draw.text((text_x, text_y), line, fill='#666666', font=font)
        
        # Convert to base64
        buffered = BytesIO()
        img.save(buffered, format="JPEG", quality=85)
        img_base64 = base64.b64encode(buffered.getvalue()).decode('utf-8')
        return f"data:image/jpeg;base64,{img_base64}"
        
    except Exception as e:
        logger.error(f"Error generating placeholder image: {e}")
        # Return a minimal base64 image as fallback
        return "data:image/svg+xml;base64," + base64.b64encode(
            b'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#f0f0f0"/></svg>'
        ).decode('utf-8')

def get_candidates_data(params: Dict) -> Dict:
    try:
        slide_path = resolve_path(params["slide_id"])
        h5_path = slide_path + '.h5' if not slide_path.endswith('.h5') else slide_path
        
        # Auto-load reclassifications from H5 file using seg_service.py pattern
        if h5_path not in _reclassified_cells or not _reclassified_cells[h5_path]:
            loaded_reclassifications = _load_reclassifications_from_h5(h5_path)
            if loaded_reclassifications:
                _reclassified_cells[h5_path] = loaded_reclassifications
        
        if not os.path.exists(h5_path):
            return {"success": False, "error": f"H5 file not found: {h5_path}"}
        
        class_name = params.get("class_name")
        threshold = params.get("threshold", 0.5)
        sort_order = params.get("sort", "asc")  # "asc" = Low→High, "desc" = High→Low
        limit = params.get("limit", 80)
        offset = params.get("offset", 0)
        exclude_reclassified = params.get("exclude_reclassified", False)  # New parameter
        
        # Special classes that don't use probability-based filtering
        special_classes = {"Other", "Not Sure", "Incorrect Segmentation"}
        is_special_class = class_name in special_classes
        
        
        # Check for reclassified cells
        reclassified_for_this_class = []
        reclassified_from_this_class = set()  # Cells to exclude from this class
        
        if h5_path in _reclassified_cells:
            for cell_id, reclassify_data in _reclassified_cells[h5_path].items():
                if reclassify_data["new_class"] == class_name:
                    # This cell was reclassified TO this class
                    reclassified_for_this_class.append({
                        "cell_id": cell_id,
                        "prob": reclassify_data["prob"],
                        "reclassified": True,
                        "original_class": reclassify_data.get("original_original_class", reclassify_data["original_class"])  # Use true original class
                    })
                
                # Exclude cells that are currently reclassified FROM this class
                # This prevents cells from appearing in both their new class AND original class
                original_original_class = reclassify_data.get("original_original_class", reclassify_data["original_class"])
                if original_original_class == class_name and reclassify_data["new_class"] != class_name:
                    # This cell's TRUE original class is this class AND it's currently reclassified to a different class
                    # Exclude it from probability candidates to prevent duplicates
                    reclassified_from_this_class.add(cell_id)
        
        
        # Handle special classes differently - they only show reclassified cells
        if is_special_class:
            return _handle_special_class_candidates(params, reclassified_for_this_class, slide_path)
        
        with h5py.File(h5_path, 'r') as hf:
            
            # Try different H5 group structures for morphology data
            seg_group = None
            if 'nuclei_segmentation' in hf:
                seg_group = hf['nuclei_segmentation']
            elif 'SegmentationNode' in hf:
                seg_group = hf['SegmentationNode']
            elif 'morphology' in hf:
                seg_group = hf['morphology']  
            else:
                logger.error(f"[AL] No nuclei_segmentation, SegmentationNode, or morphology data found in H5 file: {h5_path}")
                return {"success": False, "error": "No nuclei_segmentation, SegmentationNode, or morphology data found in H5 file"}
                
            
            if 'centroids' not in seg_group:
                logger.error(f"[AL] No centroids found in morphology group")
                return {"success": False, "error": "No centroids data found in H5 file"}
                
            centroids = seg_group['centroids'][:]  # Shape: (N, 2) where N is number of cells
            contours = seg_group['contours'][:] if 'contours' in seg_group else None
            
            # Try to get classification results from ClassificationNode
            classification_group = None
            if 'ClassificationNode' in hf:
                classification_group = hf['ClassificationNode']
            else:
                logger.error(f"[AL] No ClassificationNode found - classification must be run first")
                return {"success": False, "error": "No ClassificationNode found - please run classification first"}
            
            # Read classification results
            classifications = classification_group['nuclei_class_id'][:] if 'nuclei_class_id' in classification_group else None
            class_names = None
            if 'nuclei_class_name' in classification_group:
                class_names = [name.decode() if isinstance(name, bytes) else name for name in classification_group['nuclei_class_name'][:]]
            
            if classifications is None or class_names is None:
                logger.error(f"[AL] Missing classification data")
                return {"success": False, "error": "Missing classification data - please run classification first"}
            
            # Read probabilities - check multiple sources and analyze what they contain
            probabilities = None
            prob_source = None
            
            if 'nuclei_class_probabilities' in classification_group:
                probabilities = classification_group['nuclei_class_probabilities'][:]
                prob_source = "ClassificationNode/nuclei_class_probabilities"
            elif 'probability' in seg_group:
                probabilities = seg_group['probability'][:]
                prob_source = "SegmentationNode/probability"
            else:
                logger.warning(f"[AL] No probability data found")
                return {"success": False, "error": "No probability data found - please run segmentation or classification"}
            
            
            # Filter by target class and apply threshold and sorting  
            candidate_data = {}
            if probabilities is not None and class_name and classifications is not None and class_names is not None:
                
                # Find target class index
                if class_name not in class_names:
                    logger.warning(f"[AL] Target class '{class_name}' not found in available classes: {class_names}")
                    return {"success": False, "error": f"Target class '{class_name}' not found in classification data"}
                
                target_class_idx = class_names.index(class_name)
                
                # Calculate max probabilities and uncertainty
                # probabilities shape can be:
                #  - (N_cells, N_classes): per-class probabilities
                #  - (N_cells,): single max probability per cell (fallback)
                if probabilities is not None:
                    if probabilities.ndim == 2:
                        max_probs = np.max(probabilities, axis=1)
                    elif probabilities.ndim == 1:
                        # Treat as already max probability per cell
                        max_probs = probabilities
                    else:
                        logger.error(f"[AL] Invalid probabilities shape: {probabilities.shape}, expected (N_cells, N_classes) or (N_cells,)")
                        return {"success": False, "error": f"Invalid probabilities shape: {probabilities.shape}"}
                    uncertainties = np.abs(max_probs - 0.5)
                
                # Find cells for active learning: predicted as target class OR reclassified to target class
                valid_candidates = []
                
                # Get IDs of cells that have been reclassified to this target class
                reclassified_cell_ids = set(int(cell["cell_id"]) for cell in reclassified_for_this_class)
                
                for idx in range(len(classifications)):
                    predicted_class = int(classifications[idx])
                    max_prob = float(max_probs[idx])
                    uncertainty = float(uncertainties[idx])
                    
                    # Include cells if: 1) predicted as target class, OR 2) reclassified to target class
                    # AND apply probability threshold filter
                    should_include = predicted_class == target_class_idx or idx in reclassified_cell_ids
                    
                    if should_include:
                        # Apply threshold: only include cells with max_prob >= threshold
                        if max_prob >= threshold:
                            valid_candidates.append((idx, max_prob, uncertainty))
                            pass
                        else:
                            logger.debug(f"[AL] Filtered out cell {idx} with max_prob {max_prob:.3f} < threshold {threshold}")
                
                # Sort by uncertainty (lowest uncertainty first = most uncertain cells)
                # uncertainty = |max_prob - 0.5|, where 0 = most uncertain, 0.5 = most certain
                # "asc" = Low→High uncertainty (most uncertain first), "desc" = High→Low uncertainty  
                reverse_sort = (sort_order == "desc")
                valid_candidates.sort(key=lambda x: x[2], reverse=reverse_sort)  # Sort by uncertainty (lower = more uncertain)
                
                predicted_count = sum(1 for idx, _, _ in valid_candidates if int(classifications[idx]) == target_class_idx)
                reclassified_count = sum(1 for idx, _, _ in valid_candidates if idx in reclassified_cell_ids)
                
                # Apply cell ID filtering if specified (for ROI support)
                if params.get("cell_ids"):
                    try:
                        # Parse comma-separated cell IDs
                        allowed_cell_ids = set(int(cid.strip()) for cid in params.get("cell_ids").split(",") if cid.strip())
                        
                        id_filtered_candidates = []
                        for idx, max_prob, uncertainty in valid_candidates:
                            if idx in allowed_cell_ids:
                                id_filtered_candidates.append((idx, max_prob, uncertainty))
                        valid_candidates = id_filtered_candidates
                        
                    except (ValueError, AttributeError) as e:
                        logger.error(f"[AL] Error parsing cell_ids parameter: {e}")
                else:
                    pass
                
                target_class_cells_max_probs = [max_probs[idx] for idx, _, _ in valid_candidates]
                if target_class_cells_max_probs:
                    target_class_histogram, _ = np.histogram(target_class_cells_max_probs, bins=20, range=(0.0, 1.0))
                    target_class_histogram = [int(x) for x in target_class_histogram.tolist()]
                else:
                    target_class_histogram = [0] * 20
                    logger.warning(f"[AL] No cells predicted as {class_name}, using empty histogram")
                
            else:
                logger.error(f"[AL] Missing required data for class-specific active learning")
                return {"success": False, "error": "Missing classification data - please run classification first"}
            
            # Store all valid candidates (not limited by page size yet)
            for cell_idx, max_prob, uncertainty in valid_candidates:
                candidate_data[str(cell_idx)] = {  # Use string key
                    'prob': float(max_prob),  # Store max probability
                    'uncertainty': float(uncertainty),  # Store uncertainty for reference
                    'centroid': {'x': float(centroids[cell_idx, 0]), 'y': float(centroids[cell_idx, 1])}
                }
        
        # Sort candidates by probability
        candidates_list = list(candidate_data.items())
        
        # First, prepare reclassified items (these will always appear first)
        reclassified_items = []
        existing_cell_ids = set()
        
        for reclassified_cell in reclassified_for_this_class:
            try:
                cell_id = int(reclassified_cell["cell_id"])
                cell_id_str = str(cell_id)
                
                # Skip if already processed (avoid duplicates)
                if cell_id_str in existing_cell_ids:
                    logger.warning(f"[AL] Skipping duplicate reclassified cell {cell_id_str}")
                    continue
                existing_cell_ids.add(cell_id_str)
                
                # Get cell data from H5 file for the reclassified cell
                if cell_id in range(len(centroids)):
                    centroid = centroids[cell_id]
                    
                    # Generate image for reclassified cell
                    try:
                        tile_data = get_cell_review_tile_data({
                            "slide_id": params["slide_id"],
                            "cell_id": cell_id,
                            "centroid": {
                                "x": float(centroid[0]),
                                "y": float(centroid[1])
                            },
                            "window_size_px": 128,
                            "target_fov_um": 20.0,  # Standard FOV for cell review
                            "padding_ratio": 0.1,
                            "return_contour": True
                        })
                        
                        if tile_data.get("success", False):
                            crop_data = tile_data.get("data", {})
                            image_b64 = crop_data.get("image")
                            bounds = crop_data.get("bounds", {"x": 0, "y": 0, "w": 128, "h": 128})
                            bbox = crop_data.get("bbox", {"x": 54, "y": 54, "w": 20, "h": 20})
                            contour_from_api = crop_data.get("contour", [])
                        else:
                            logger.warning(f"[AL] Failed to get image for reclassified cell {cell_id}: {tile_data.get('error', 'unknown')}")
                            image_b64 = _generate_error_placeholder_image(f"Cell {cell_id}\nImage Error")
                            bounds = {"x": 0, "y": 0, "w": 128, "h": 128}
                            bbox = {"x": 54, "y": 54, "w": 20, "h": 20}
                            contour_from_api = []
                            
                    except Exception as img_error:
                        logger.warning(f"[AL] Failed to generate image for reclassified cell {cell_id}: {img_error}")
                        image_b64 = _generate_error_placeholder_image(f"Reclassified\nCell {cell_id}")
                        bounds = {"x": 0, "y": 0, "w": 128, "h": 128}
                        bbox = {"x": 54, "y": 54, "w": 20, "h": 20}
                        contour_from_api = []
                    
                    # Extract contour from H5 data if available and API didn't provide it
                    contour_from_h5 = []
                    if not contour_from_api and contours is not None and cell_id < len(contours):
                        try:
                            cell_contour = contours[cell_id]
                            if cell_contour.size > 0 and cell_contour.ndim == 2 and cell_contour.shape[1] == 2:
                                contour_from_h5 = [{"x": float(pt[0]), "y": float(pt[1])} for pt in cell_contour]
                        except Exception as contour_error:
                            logger.warning(f"[AL] Error processing contour for reclassified cell {cell_id}: {contour_error}")
                    
                    # Use API contour if available, otherwise H5 contour
                    final_contour = contour_from_api if contour_from_api else contour_from_h5
                    
                    # Create candidate item for reclassified cell
                    reclassified_item = {
                        "cell_id": cell_id_str,
                        "prob": reclassified_cell["prob"],
                        "centroid": {"x": float(centroid[0]), "y": float(centroid[1])},
                        "label": None,  # No label yet for the new class
                        "reclassified": True,
                        "original_class": reclassified_cell["original_class"],
                        "crop": {
                            "image": image_b64,
                            "bbox": bbox,
                            "bounds": bounds,
                            "contour": final_contour
                        }
                    }
                    reclassified_items.append(reclassified_item)
                    
            except Exception as e:
                logger.warning(f"[AL] Error processing reclassified cell {reclassified_cell['cell_id']}: {e}")
                continue
        
        # Filter out reclassified cells from candidates_list
        filtered_candidates = []
        for cell_idx_str, cell_data in candidates_list:
            if cell_idx_str not in reclassified_from_this_class:
                filtered_candidates.append((cell_idx_str, cell_data))
        
        # Total count: regular candidates + reclassified TO this class (if not excluded)
        total_candidates = len(filtered_candidates) + (0 if exclude_reclassified else len(reclassified_items))
        
        # Create unified list: reclassified items FIRST, then regular candidates
        all_items_data = []
        
        # Add reclassified items first (always at the beginning, regardless of sort order)
        # But only if exclude_reclassified is False
        if not exclude_reclassified:
            for item in reclassified_items:
                all_items_data.append(('reclassified', item))
        
        # Add regular candidates (these will be sorted by probability)
        for cell_idx_str, cell_data in filtered_candidates:
            all_items_data.append(('regular', (cell_idx_str, cell_data)))
        
        # Apply pagination to the unified list
        start_idx = offset
        end_idx = min(offset + limit, len(all_items_data))
        page_items_data = all_items_data[start_idx:end_idx]
        
        
        # Use the target class histogram we generated above
        hist = target_class_histogram if 'target_class_histogram' in locals() else [0] * 20
        
        # Generate final items list
        items = []
        for item_type, item_data in page_items_data:
            if item_type == 'reclassified':
                # Already processed reclassified item
                items.append(item_data)
            else:
                # Process regular candidate
                cell_idx_str, cell_data = item_data
                cell_idx = int(cell_idx_str)
                
                # Get cell image
                try:
                    cell_image_data = get_cell_review_tile_data({
                        "slide_id": params["slide_id"],
                        "cell_id": cell_idx,
                        "centroid": {
                            "x": float(cell_data['centroid']['x']),
                            "y": float(cell_data['centroid']['y'])
                        },
                        "window_size_px": 128,
                        "target_fov_um": 20.0,  # Standard FOV for cell review
                        "padding_ratio": 0.1,   # Less padding to keep cell more centered
                        "return_contour": True
                    })
                    
                    if cell_image_data.get("success", False):
                        crop_data = cell_image_data.get("data", {})
                        image_b64 = crop_data.get("image")
                        bounds = crop_data.get("bounds", {"x": 0, "y": 0, "w": 128, "h": 128})
                        bbox = crop_data.get("bbox", {"x": 54, "y": 54, "w": 20, "h": 20})
                        contour = crop_data.get("contour", [])
                    else:
                        logger.warning(f"[AL] Failed to get image for cell {cell_idx}: {cell_image_data.get('error', 'unknown')}")
                        # Generate a placeholder image with error message
                        image_b64 = _generate_error_placeholder_image(f"Cell {cell_idx}\nImage Error")
                        bounds = {"x": 0, "y": 0, "w": 128, "h": 128}
                        bbox = {"x": 54, "y": 54, "w": 20, "h": 20}
                        contour = []
                        
                except Exception as img_error:
                    logger.error(f"[AL] Error generating image for cell {cell_idx}: {img_error}")
                    # Generate a placeholder image with error message
                    image_b64 = _generate_error_placeholder_image(f"Cell {cell_idx}\nGeneration Error")
                    bounds = {"x": 0, "y": 0, "w": 128, "h": 128}
                    bbox = {"x": 54, "y": 54, "w": 20, "h": 20}
                    contour = []
                
                candidate_item = {
                    "cell_id": cell_idx_str,  # Keep as string for JSON
                    "prob": float(cell_data['prob']),
                    "centroid": {
                        "x": float(cell_data['centroid']['x']),
                        "y": float(cell_data['centroid']['y'])
                    },
                    "crop": {
                        "image": image_b64,
                        "bounds": {
                            "x": int(bounds.get("x", 0)),
                            "y": int(bounds.get("y", 0)),
                            "w": int(bounds.get("w", 128)),
                            "h": int(bounds.get("h", 128))
                        },
                        "bbox": {
                            "x": int(bbox.get("x", 54)),
                            "y": int(bbox.get("y", 54)),
                            "w": int(bbox.get("w", 20)),
                            "h": int(bbox.get("h", 20))
                        },
                        "contour": contour if contour else []
                    }
                }
                items.append(candidate_item)
        
        return {
            "success": True,
            "data": {
                "total": int(total_candidates),
                "hist": hist,  # Use actual histogram data
                "items": items
            }
        }
            
    except Exception as e:
        logger.error(f"Error in get_candidates_data: {str(e)}")
        return {"success": False, "error": f"Error fetching candidates: {str(e)}"}

def label_candidate_cell(params: Dict) -> Dict:
    try:
        slide_path = resolve_path(params["slide_id"])
        h5_path = slide_path + '.h5' if not slide_path.endswith('.h5') else slide_path
        
        if not os.path.exists(h5_path):
            return {"success": False, "error": f"H5 file not found: {h5_path}"}
        
        cell_id = params["cell_id"]
        class_name = params.get("class_name")
        label = params["label"]
        prob = params["prob"]
        
        
        if label == 0:
            pass
        else:
            pass
        
        return {"success": True, "is_original_manual": is_original_manual}
        
    except Exception as e:
        logger.error(f"Error in label_candidate_cell: {str(e)}")
        return {"success": False, "error": f"Error labeling candidate: {str(e)}"}


def reclassify_candidate_cell(handler: "SegmentationHandler", params: Dict) -> Dict:
    try:
        slide_path = resolve_path(params["slide_id"])
        h5_path = slide_path + '.h5' if not slide_path.endswith('.h5') else slide_path
        
        if not os.path.exists(h5_path):
            return {"success": False, "error": f"H5 file not found: {h5_path}"}
        
        cell_id = params["cell_id"]
        original_class = params["original_class"]
        new_class = params["new_class"]
        prob = params["prob"]
        
        # Determine if the original class is from manual annotation
        # Simple test logic: even cell_id = manual, odd = not manual
        is_original_manual = (int(cell_id) % 2 == 0)
        
        # Handle reclassification with proper cleanup
        h5_path = slide_path + '.h5' if not slide_path.endswith('.h5') else slide_path
        slide_key = h5_path  # Use h5 path as key for consistency
        
        if slide_key not in _reclassified_cells:
            _reclassified_cells[slide_key] = {}
        
        # Check if this cell was already reclassified
        existing_record = _reclassified_cells[slide_key].get(cell_id)
        
        if existing_record:
            # Cell was already reclassified before
            original_original_class = existing_record.get("original_original_class", existing_record["original_class"])
            
            # Check if moving back to the true original class
            if new_class == original_original_class:
                # Moving back to original class - completely remove from reclassified records
                del _reclassified_cells[slide_key][cell_id]
                
                # Update H5 file when returning to original class
                try:
                    update_result = save_reclassifications_via_existing_api({"slide_id": params["slide_id"]})
                    if update_result.get("success", False):
                        pass
                    else:
                        logger.warning(f"[AL] Failed to update H5 file: {update_result.get('error', 'unknown')}")
                except Exception as e:
                    logger.error(f"[AL] Error updating H5 file: {e}")
                    
            else:
                # Moving to a different new class - update record but keep original_original_class
                _reclassified_cells[slide_key][cell_id] = {
                    "original_class": original_class,  # The class it's moving FROM now
                    "new_class": new_class,            # The class it's moving TO now
                    "prob": prob,
                    "original_original_class": original_original_class,  # The true original class
                    "timestamp": datetime.now().isoformat(),
                    "is_original_manual": existing_record.get("is_original_manual", is_original_manual)  # Preserve original manual status
                }
        else:
            # First time reclassification
            if original_class == new_class:
                # Should not happen, but handle gracefully
                logger.warning(f"[AL] Attempting to reclassify cell {cell_id} to same class '{original_class}'")
                return {"success": True, "is_original_manual": is_original_manual}  # No-op
            
            _reclassified_cells[slide_key][cell_id] = {
                "original_class": original_class,
                "new_class": new_class,
                "prob": prob,
                "original_original_class": original_class,  # Track the true original class
                "timestamp": datetime.now().isoformat(),
                "is_original_manual": is_original_manual  # Track if original was manual
            }

        # Try to save reclassifications to H5 file but don't fail the operation if it doesn't work
        # The reclassifications are still stored in memory and will work for the current session
        try:
            save_result = save_reclassifications_via_existing_api({"slide_id": params["slide_id"]})
            if not save_result.get("success", False):
                error_msg = save_result.get('error', 'unknown error')
                logger.warning(f"[AL] Failed to save reclassifications to H5 (will work in memory): {error_msg}")
                # Don't return error - let it work in memory for current session
        except Exception as e:
            logger.warning(f"[AL] Error saving reclassifications to H5 (will work in memory): {e}")
            # Don't return error - let it work in memory for current session

        # Invalidate global counts cache to ensure fresh data is returned
        try:
            handler.ensure_file_loaded_in_cache(h5_path)
            handler.invalidate_global_counts_cache()
            print(f"[AL] Invalidated global counts cache for {h5_path}")
        except Exception as e:
            print(f"[AL] Failed to invalidate global counts cache: {e}")

        return {"success": True, "is_original_manual": is_original_manual}
        
    except Exception as e:
        logger.error(f"Error in reclassify_candidate_cell: {str(e)}")
        return {"success": False, "error": f"Error reclassifying candidate: {str(e)}"}


def get_manual_counts_with_reclassifications(handler, base_data: Dict) -> Dict:
    """
    Get manual annotation counts including reclassifications.
    Reclassifications are considered manual annotations.

    Args:
        handler: SegmentationHandler instance
        base_data: Base manual annotation counts from get_all_nuclei_counts

    Returns:
        Dict with updated counts including reclassifications
    """
    try:
        h5_path = handler.get_current_file_path()

        # Start with base manual annotation counts
        class_counts = base_data.get('class_counts_by_id', {})
        class_names = base_data.get('dynamic_class_names', [])

        # Add reclassifications to counts
        if h5_path in _reclassified_cells:
            reclassified_data = _reclassified_cells[h5_path]

            # Create name to ID mapping
            name_to_id = {name: str(idx) for idx, name in enumerate(class_names)}

            # Count reclassifications per class
            reclassify_counts = {}
            for cell_id_str, reclassify_info in reclassified_data.items():
                new_class = reclassify_info.get("new_class")
                if new_class in name_to_id:
                    class_id = name_to_id[new_class]
                    reclassify_counts[class_id] = reclassify_counts.get(class_id, 0) + 1

            # Add reclassification counts to manual counts
            for class_id, count in reclassify_counts.items():
                class_counts[class_id] = class_counts.get(class_id, 0) + count

        return {
            'class_counts_by_id': class_counts,
            'dynamic_class_names': class_names
        }
    except Exception as e:
        logger.error(f"Error in get_manual_counts_with_reclassifications: {e}")
        return base_data


def save_reclassifications_via_existing_api(params: Dict) -> Dict:
    try:
        slide_path = resolve_path(params["slide_id"])
        h5_path = slide_path + '.h5' if not slide_path.endswith('.h5') else slide_path

        logger.info(f"[AL Save] Starting save_reclassifications for: {h5_path}")

        # Get current reclassifications for this slide
        reclassified_data = _reclassified_cells.get(h5_path, {})

        # If no reclassifications to save, return success
        if not reclassified_data:
            logger.info(f"[AL Save] No reclassifications to save for {h5_path}")
            return {
                "success": True,
                "file_path": h5_path,
                "count": 0,
                "new_count": 0,
                "message": "No reclassifications to save"
            }

        logger.info(f"[AL Save] Saving {len(reclassified_data)} reclassifications")

        # Count existing reclassifications in H5 file to determine new ones
        existing_count = 0
        try:
            existing_reclassifications = _load_reclassifications_from_h5(h5_path)
            existing_count = len(existing_reclassifications)
        except Exception as e:
            logger.warning(f"[AL Save] Could not load existing reclassifications: {e}")
            existing_count = 0

        # Check if H5 file exists
        if not os.path.exists(h5_path):
            logger.error(f"[AL Save] H5 file not found: {h5_path}")
            return {
                "success": False,
                "error": f"H5 file not found: {h5_path}",
                "file_path": None,
                "count": 0
            }
        
        # Use seg_service.py's proven H5 handling pattern for partial updates
        from datetime import datetime
        import time

        current_time = datetime.now().isoformat()

        # Try to open H5 file with retries in case it's temporarily locked
        max_retries = 3
        retry_delay = 0.5
        save_success = False
        last_error = None

        for attempt in range(max_retries):
            try:
                with h5py.File(h5_path, 'r+') as h5_file:
                    logger.info(f"[AL Save] Successfully opened H5 file on attempt {attempt + 1}")

                    # Use require_group like seg_service.py
                    user_annotation_group = h5_file.require_group('user_annotation')

                    # Step 1: Load existing annotations (following seg_service.py pattern)
                    existing_annotations = {}
                    if 'nuclei_annotations' in user_annotation_group:
                        try:
                            raw = user_annotation_group['nuclei_annotations'][()]
                            existing_annotations = json.loads(raw.decode('utf-8') if isinstance(raw, (bytes, bytearray)) else raw)
                        except Exception as e:
                            logger.warning(f"[AL Save] Failed to load existing annotations: {e}")
                            existing_annotations = {}

                    # Step 2: Remove old reclassification records, keep other annotations (like seg_service.py)
                    keys_to_remove = [k for k, ann in existing_annotations.items()
                                     if isinstance(ann, dict) and ann.get('annotation_type') == 'reclassification']

                    for k in keys_to_remove:
                        existing_annotations.pop(k, None)

                    # Step 3: Add current reclassifications
                    for cell_id, cell_data in reclassified_data.items():
                        existing_annotations[str(cell_id)] = {
                            "cell_class": cell_data.get("new_class"),
                            "probability": float(cell_data.get("prob", 0.0)),
                            "original_class": cell_data.get("original_class"),
                            "timestamp": current_time,
                            "annotation_type": "reclassification"
                        }

                    # Step 4: Save updated annotations (following seg_service.py pattern)
                    if 'nuclei_annotations' in user_annotation_group:
                        del user_annotation_group['nuclei_annotations']

                    user_annotation_group.create_dataset(
                        'nuclei_annotations',
                        data=json.dumps(existing_annotations).encode('utf-8')
                    )

                    # Save metadata
                    metadata = {
                        "total_reclassifications": len(reclassified_data),
                        "timestamp": current_time,
                        "format_version": "1.0",
                        "source": "tissuelab_active_learning"
                    }

                    if 'reclassification_metadata' in user_annotation_group:
                        del user_annotation_group['reclassification_metadata']

                    user_annotation_group.create_dataset(
                        'reclassification_metadata',
                        data=json.dumps(metadata).encode('utf-8'),
                        dtype=h5py.string_dtype(encoding='utf-8')
                    )

                    # Ensure data is written to disk (seg_service.py pattern)
                    h5_file.flush()
                    save_success = True
                    logger.info(f"[AL Save] Successfully saved reclassifications to H5")
                    break  # Success, exit retry loop

            except Exception as e:
                last_error = e
                logger.warning(f"[AL Save] Attempt {attempt + 1} failed: {e}")
                if attempt < max_retries - 1:
                    time.sleep(retry_delay)
                    retry_delay *= 2  # Exponential backoff

        if not save_success:
            logger.error(f"[AL Save] Failed to save after {max_retries} attempts. Last error: {last_error}")
            return {
                "success": False,
                "error": f"Failed to save to H5 file after {max_retries} attempts: {last_error}",
                "file_path": h5_path,
                "count": 0
            }
        
        # After successful write, try to refresh cache but don't fail if it doesn't work
        try:
            # Try to import and use cache refresh functions
            try:
                from app.services.seg_service import force_refresh_h5_cache, smart_preload_data
                force_refresh_h5_cache(h5_path)
                smart_preload_data(h5_path, force_reload=True)
                logger.info(f"[AL Save] Cache invalidated and refreshed for {h5_path}")
            except ImportError:
                logger.warning(f"[AL Save] Cache refresh functions not available, skipping cache refresh")
        except Exception as cache_err:
            logger.warning(f"[AL Save] Failed to refresh cache after saving reclassifications: {cache_err}")
            # Don't fail the whole operation just because cache refresh failed

        # Calculate new reclassifications count
        current_count = len(reclassified_data)
        new_count = max(0, current_count - existing_count)
        
        logger.info(f"[AL Save] Successfully saved {current_count} reclassifications ({new_count} new) using seg_service pattern: {h5_path}")
        
        return {
            "success": True,
            "file_path": h5_path,
            "count": current_count,
            "new_count": new_count,
            "message": f"Saved {new_count} new reclassifications (total: {current_count})"
        }
        
    except Exception as e:
        logger.error(f"[AL Save] Error saving reclassifications: {str(e)}")
        return {
            "success": False, 
            "error": f"Error saving reclassifications: {str(e)}",
            "file_path": None,
            "count": 0
        }


