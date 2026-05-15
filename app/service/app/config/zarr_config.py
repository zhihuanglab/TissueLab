"""
Zarr File Group Names Configuration

This module centralizes all Zarr group and dataset names used across the application.
"""

import zarr


# === Group Names ===
class ZarrGroups:
    """Top-level Zarr group names"""
    USER_ANNOTATION = 'user_annotation'
    CLASSIFICATION_NODE = 'ClassificationNode'
    NUCLEI_SEGMENTATION = 'nuclei_segmentation'
    SEGMENTATION_NODE = 'SegmentationNode'
    MORPHOLOGY = 'morphology'


# === Dataset Names ===
class ZarrDatasets:
    """Dataset names used in Zarr files"""
    # User annotation datasets
    NUCLEI_ANNOTATIONS = 'nuclei_annotations'
    RECLASSIFICATION_METADATA = 'reclassification_metadata'
    
    # Segmentation datasets
    CENTROIDS = 'centroids'
    CONTOURS = 'contours'
    PROBABILITY = 'probability'
    
    # Classification datasets
    NUCLEI_CLASS_ID = 'nuclei_class_id'
    NUCLEI_CLASS_NAME = 'nuclei_class_name'
    NUCLEI_CLASS_PROBABILITIES = 'nuclei_class_probabilities'
    USER_DATA = 'userData'
    NUCLEI_CLASSES = 'nuclei_classes'
    NUCLEI_COLORS = 'nuclei_colors'


# === Path Helpers ===
class ZarrPaths:
    """Common Zarr paths (for path-style access like zarr['path/to/data'])"""
    USER_ANNOTATION_NUCLEI_ANNOTATIONS = 'user_annotation/nuclei_annotations'
    USER_ANNOTATION_RECLASSIFICATION_METADATA = 'user_annotation/reclassification_metadata'


# === Helper Functions ===
def find_segmentation_group(zarr_file):
    """
    Find the first available segmentation group in the Zarr file.
    
    Args:
        zarr_file: An open zarr.Group object
        
    Returns:
        The segmentation group object, or None if not found
    """
    for group_name in [ZarrGroups.NUCLEI_SEGMENTATION, ZarrGroups.SEGMENTATION_NODE, ZarrGroups.MORPHOLOGY]:
        if group_name in zarr_file:
            return zarr_file[group_name]
    return None
