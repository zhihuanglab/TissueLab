import json
import os
from typing import Dict, Any, Optional
from app.core import logger

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

    # def load(self) -> None:
    #     if self._loaded:
    #         return
    #     self._ensure_dir()
    #     if os.path.exists(self.registry_path):
    #         try:
    #             with open(self.registry_path, "r", encoding="utf-8") as f:
    #                 self._data = json.load(f)
    #                 if "category_map" not in self._data:
    #                     self._data["category_map"] = {}
    #                 if "nodes" not in self._data:
    #                     self._data["nodes"] = {}
    #                 if "category_display_names" not in self._data:
    #                     self._data["category_display_names"] = {}
    #         except Exception:
    #             # If corrupted, fall back to empty
    #             self._data = {"category_map": {}, "nodes": {}}
    #     self._loaded = True

    def load(self) -> None:
        if self._loaded:
            return

        self._ensure_dir()

        data = {}
        if os.path.exists(self.registry_path):
            try:
                with open(self.registry_path, "r", encoding="utf-8") as f:
                    data = json.load(f) or {}
            except Exception:
                data = {}

        data = self.normalize_registry_dict(data)

        # ---- seed preset only if registry is empty ----
        if self.is_empty_registry(data):
            preset = self.load_preset_registry()
            preset = self.normalize_registry_dict(preset)

            self._data = preset
            self.save()
        else:
            self._data = data

        self._loaded = True




    def reload(self) -> None:
        """Force reload from disk, bypassing the _loaded cache flag.
        Call this when the registry file has been modified externally."""
        self._loaded = False
        self.load()

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
        defaults = {}

        # Display names for categories
        category_display = {
            "TissueClassify": "Tissue Classification",
            "TissueSeg": "Tissue Segmentation",
            "NucleiSeg": "Cell Segmentation + Embedding",
            "NucleiClassify": "Nuclei Classification",
            "CodingAgent": "Coding Agent",
            "Scripts": "Code Calculation",
            "Custom": "Custom Models"
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
                        # Persist the canonical Zarr group if provided by defaults
                        "zarr_group": meta.get("zarr_group", None),
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
        # zarr_group: keep existing unless explicitly provided
        zarr_group_val = (metadata.get("zarr_group") if metadata and metadata.get("zarr_group") is not None else node_meta.get("zarr_group", None))

        node_meta.update({
            "displayName": display_name,
            "description": description_val,
            "icon": icon_val,
            "schema": schema_val,
            "version": version_val,
            "factory": factory,
            "zarr_group": zarr_group_val,
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
            if "ui" in metadata and metadata.get("ui") is not None:
                node_meta["ui"] = metadata.get("ui")
        # Persist optional runtime configuration to support one-click activation
        if metadata and isinstance(metadata, dict) and metadata.get("runtime"):
            runtime = metadata.get("runtime", {})
            existing_runtime = node_meta.get("runtime", {}) if isinstance(node_meta.get("runtime"), dict) else {}
            # Merge new runtime fields over existing
            # Allow None values to clear existing fields, and empty strings to be saved
            merged_runtime = {**existing_runtime}
            for k, v in runtime.items():
                if v is None:
                    # If value is None, remove the key to clear existing value
                    merged_runtime.pop(k, None)
                else:
                    # Save the value (including empty strings)
                    merged_runtime[k] = v
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

    def save_panel_config(self, model_name: str, panel_config: Dict[str, Any]) -> bool:
        """Save panel configuration for a model"""
        try:
            self.load()
            if model_name in self._data.get("nodes", {}):
                # Update existing node with panel configuration using new format
                self._data["nodes"][model_name]["panel"] = panel_config.get("panel", [])
                # Ensure factory information is preserved
                if "factory" not in self._data["nodes"][model_name] or not self._data["nodes"][model_name]["factory"]:
                    # If factory is missing, try to determine it from category_map
                    for category, nodes in self._data.get("category_map", {}).items():
                        if model_name in nodes:
                            self._data["nodes"][model_name]["factory"] = category
                            break
                self.save()
                return True
            return False
        except Exception as e:
            print(f"Error saving panel config for {model_name}: {e}")
            return False

    def get_panel_config(self, model_name: str) -> Optional[Dict[str, Any]]:
        """Get panel configuration for a model"""
        try:
            self.load()
            node_data = self._data.get("nodes", {}).get(model_name, {})
            panel_data = node_data.get("panel")
            if panel_data is not None:
                return {
                    "title": node_data.get("displayName", model_name),
                    "panel": panel_data
                }
            return None
        except Exception as e:
            print(f"Error getting panel config for {model_name}: {e}")
            return None

    def get_all_panel_configs(self) -> Dict[str, Dict[str, Any]]:
        """Get all panel configurations with factory information"""
        try:
            self.load()
            panel_configs = {}
            for model_name, node_data in self._data.get("nodes", {}).items():
                if "panel" in node_data:
                    panel_configs[model_name] = {
                        "title": node_data.get("displayName", model_name),
                        "panel": node_data["panel"],
                        "factory": node_data.get("factory", "Custom")
                    }
            return panel_configs
        except Exception as e:
            print(f"Error getting all panel configs: {e}")
            return {}
        


    def load_preset_registry(self) -> dict:
        preset_path = _PRESET_REGISTRY_PATH
        if not os.path.exists(preset_path):
            return {"nodes": {}, "category_map": {}, "category_display_names": {}}
        try:
            with open(preset_path, "r", encoding="utf-8") as f:
                data = json.load(f) or {}
            data.setdefault("nodes", {})
            data.setdefault("category_map", {})
            data.setdefault("category_display_names", {})
            return data
        except Exception as e:
            logger.exception("[model_store] Error loading preset registry")
            return {"nodes": {}, "category_map": {}, "category_display_names": {}}

    def get_registry_or_preset(self) -> dict:
        """
        Return registry if non-empty, otherwise fallback to preset.
        """
        self.reload()
        return {
        "nodes": self.get_nodes_extended(),
        "category_map": self.get_category_map(),
        "category_display_names": self.get_category_display_names(),
        }
    

    def normalize_registry_dict(self, data: dict) -> dict:
        if not isinstance(data, dict):
            data = {}
        data.setdefault("nodes", {})
        data.setdefault("category_map", {})
        data.setdefault("category_display_names", {})
        if not isinstance(data["nodes"], dict):
            data["nodes"] = {}
        if not isinstance(data["category_map"], dict):
            data["category_map"] = {}
        if not isinstance(data["category_display_names"], dict):
            data["category_display_names"] = {}
        return data

    def is_empty_registry(self, data: dict) -> bool:
        
        nodes = data.get("nodes") or {}
        return isinstance(nodes, dict) and len(nodes) == 0


# Singleton instance used across the service layer.
# The preset ships with the code (app/service/storage/model_registry_preset.json);
# the live registry is per installation under TL_SERVICE_ROOT/storage.
from app.config.path_config import SERVICE_STORAGE_DIR as _SERVICE_STORAGE_DIR  # noqa: E402

_PRESET_REGISTRY_PATH = os.path.abspath(os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "..", "storage", "model_registry_preset.json"
))
_default_registry_path = os.path.join(_SERVICE_STORAGE_DIR, "model_registry.json")
model_store = ModelStore(_default_registry_path)
model_store.ensure_defaults()

