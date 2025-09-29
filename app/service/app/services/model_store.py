import json
import os
from typing import Dict, Any, Optional


class ModelStore:
    """
    Simple on-disk registry for task nodes (both built-in and custom) grouped by categories.

    Schema (JSON):
    {
      "category_map": { "CategoryName": ["NodeA", "NodeB"] },
      "nodes": {
        "NodeA": { "displayName": "...", "description": "...", "icon": "...", "factory": "CategoryName", "schema": {..} }
      }
    }
    """

    def __init__(self, registry_path: str):
        self.registry_path = registry_path
        self._data: Dict[str, Any] = {
            "category_map": {},
            "nodes": {},
            "category_display_names": {}
        }
        self._loaded = False

    def _ensure_dir(self):
        directory = os.path.dirname(self.registry_path)
        if directory and not os.path.exists(directory):
            os.makedirs(directory, exist_ok=True)

    def load(self) -> None:
        if self._loaded:
            return
        self._ensure_dir()
        if os.path.exists(self.registry_path):
            try:
                with open(self.registry_path, "r", encoding="utf-8") as f:
                    self._data = json.load(f)
                    if "category_map" not in self._data:
                        self._data["category_map"] = {}
                    if "nodes" not in self._data:
                        self._data["nodes"] = {}
                    if "category_display_names" not in self._data:
                        self._data["category_display_names"] = {}
            except Exception:
                # If corrupted, fall back to empty
                self._data = {"category_map": {}, "nodes": {}}
        self._loaded = True

    def save(self) -> None:
        self._ensure_dir()
        tmp_path = f"{self.registry_path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=2)
        os.replace(tmp_path, self.registry_path)

    def ensure_defaults(self) -> None:
        """Seed the store with built-in nodes so that built-ins also appear as plugins."""
        self.load()
        # Built-in categories and nodes
        defaults = {
            "TissueClassify": [
                ("MuskClassification", {
                    "displayName": "Patch Classification (MUSK)",
                    "description": "Patch-level (tile) tissue classification using MUSK embeddings; consumes and writes under 'MuskNode'.",
                    "icon": "/images/icons/patch_encoder_musk.png",
                    "h5_group": "MuskNode",
                    "inputs": "Patch embeddings [N,D] from MuskNode",
                    "outputs": "Per-patch class probabilities [N,C]",
                }),
                ("BiomedParseNode", {
                    "displayName": "BiomedParse",
                    "description": "Pixel-accurate region segmentation for explicit boundary analysis when boundary precision is explicitly required; otherwise prefer embedding-backed classification (e.g., MUSK).",
                    "icon": "/images/icons/tissue_segmentation_biomedparse.png",
                    "outputs": "Region polygons/masks",
                })
            ],
            "TissueSeg": [
                ("MuskEmbedding", {
                    "displayName": "Patch Embedding (MUSK)",
                    "description": "Generates patch embeddings for the whole slide used downstream by patch classification.",
                    "icon": "/images/icons/patch_encoder_musk.png",
                    "h5_group": "MuskNode",
                    "outputs": "Patch embeddings [N,D]",
                })
            ],
            "NucleiSeg": [
                ("SegmentationNode", {
                    "displayName": "Cell/Nuclei Segmentation",
                    "description": "Instance segmentation of nuclei/cells on WSI with per-nucleus polygons/centroids; prerequisite for per-cell metrics and classification.",
                    "icon": "/images/icons/nuclei_segmentation_stardist.png",
                    "outputs": "Per-nucleus contours and centroids",
                })
            ],
            "NucleiClassify": [
                ("ClassificationNode", {
                    "displayName": "Nuclei Classification (NuClass)",
                    "description": "Per-nucleus classifier assigning classes (e.g., tumor_cell, lymphocyte); consumes nuclei segmentation results.",
                    "icon": "/images/icons/nuclei_classification_tissuelab_nuclass.png",
                    "inputs": "Per-nucleus contours and centroids",
                    "outputs": "Per-nucleus class probabilities",
                })
            ],
            "Scripts": [
                ("Scripts", {
                    "displayName": "Code Calculation",
                    "description": "Custom Python analysis for counts/ratios/spatial queries; no visualization unless explicitly requested.",
                    "icon": "/images/icons/code_generator_tissuelab_code.png",
                })
            ],
        }

        # Display names for categories
        category_display = {
            "TissueClassify": "Tissue Classification",
            "TissueSeg": "Tissue Segmentation",
            "NucleiSeg": "Cell Segmentation + Embedding",
            "NucleiClassify": "Nuclei Classification",
            "Scripts": "Code Calculation"
        }

        changed = False
        for category, nodes in defaults.items():
            if category not in self._data["category_map"]:
                self._data["category_map"][category] = []
                changed = True
            # set display name
            dn = category_display.get(category)
            if dn and self._data["category_display_names"].get(category) != dn:
                self._data["category_display_names"][category] = dn
                changed = True
            for node_name, meta in nodes:
                if node_name not in self._data["nodes"]:
                    self._data["nodes"][node_name] = {
                        "displayName": meta.get("displayName", node_name),
                        "description": meta.get("description", ""),
                        "icon": meta.get("icon", ""),
                        "factory": category,
                        "schema": None,
                        "version": None,
                        "source": "builtin",
                        # Persist the canonical H5 group if provided by defaults
                        "h5_group": meta.get("h5_group", None),
                        # Optional I/O specs
                        "inputs": meta.get("inputs", None),
                        "outputs": meta.get("outputs", None),
                    }
                    changed = True
                if node_name not in self._data["category_map"][category]:
                    self._data["category_map"][category].append(node_name)
                    changed = True

        if changed:
            self.save()

    def register_node(self, node_name: str, factory: Optional[str], metadata: Optional[Dict[str, Any]] = None) -> None:
        """Register or update a node in a category."""
        self.load()
        # Only mutate category_map when a concrete factory is provided
        if factory:
            if factory not in self._data["category_map"]:
                self._data["category_map"][factory] = []
            if node_name not in self._data["category_map"][factory]:
                self._data["category_map"][factory].append(node_name)
        node_meta = self._data["nodes"].get(node_name, {})
        # Preserve existing values unless meaningful new values are provided
        display_name = (metadata.get("displayName") if metadata and metadata.get("displayName") else node_meta.get("displayName", node_name))
        # Only overwrite description when provided and non-empty
        if metadata and "description" in metadata and isinstance(metadata.get("description"), str) and metadata.get("description").strip() != "":
            description_val = metadata.get("description").strip()
        else:
            description_val = node_meta.get("description", "")
        icon_val = (metadata.get("icon") if metadata and metadata.get("icon") is not None else node_meta.get("icon", ""))
        schema_val = (metadata.get("schema") if metadata and "schema" in metadata else node_meta.get("schema", None))
        version_val = (metadata.get("version") if metadata and "version" in metadata else node_meta.get("version", None))
        # Do not default to "custom"; only set source when provided, else preserve existing or omit
        source_val = (metadata.get("source") if metadata and ("source" in metadata) else node_meta.get("source", None))
        # h5_group: keep existing unless explicitly provided
        h5_group_val = (metadata.get("h5_group") if metadata and metadata.get("h5_group") is not None else node_meta.get("h5_group", None))

        node_meta.update({
            "displayName": display_name,
            "description": description_val,
            "icon": icon_val,
            "schema": schema_val,
            "version": version_val,
            "factory": factory,
            "h5_group": h5_group_val,
        })
        # Only persist source when explicitly provided or previously present
        if source_val is not None:
            node_meta["source"] = source_val
        # Persist natural-language I/O hints when provided
        if metadata and isinstance(metadata, dict):
            if "inputs" in metadata and metadata.get("inputs") is not None:
                node_meta["inputs"] = metadata.get("inputs")
            if "outputs" in metadata and metadata.get("outputs") is not None:
                node_meta["outputs"] = metadata.get("outputs")
        # Persist optional runtime configuration to support one-click activation
        if metadata and isinstance(metadata, dict) and metadata.get("runtime"):
            runtime = metadata.get("runtime", {})
            existing_runtime = node_meta.get("runtime", {}) if isinstance(node_meta.get("runtime"), dict) else {}
            # Merge new runtime fields over existing
            merged_runtime = {
                **existing_runtime,
                **{k: v for k, v in runtime.items() if v is not None}
            }
            node_meta["runtime"] = merged_runtime
        self._data["nodes"][node_name] = node_meta
        self.save()

    def get_category_map(self) -> Dict[str, list]:
        self.load()
        return self._data.get("category_map", {})

    def get_nodes_extended(self) -> Dict[str, Any]:
        self.load()
        return self._data.get("nodes", {})

    def get_category_display_names(self) -> Dict[str, str]:
        self.load()
        return self._data.get("category_display_names", {})

    def delete_node(self, node_name: str) -> bool:
        """Remove a node from registry and from its category list. Returns True if removed."""
        self.load()
        existed = False
        # Remove from nodes
        if node_name in self._data.get("nodes", {}):
            del self._data["nodes"][node_name]
            existed = True
        # Remove from categories
        for cat, arr in list(self._data.get("category_map", {}).items()):
            if node_name in arr:
                try:
                    arr.remove(node_name)
                    existed = True
                except ValueError:
                    pass
        if existed:
            self.save()
        return existed


# Singleton instance used across the service layer
_default_registry_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "storage", "model_registry.json")
_default_registry_path = os.path.abspath(_default_registry_path)
model_store = ModelStore(_default_registry_path)
model_store.ensure_defaults()

