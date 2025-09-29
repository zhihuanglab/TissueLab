import copy
import json
import os
import threading
from typing import Dict, List, Optional, Tuple

from app.config.path_config import SERVICE_ROOT_DIR


class FeedbackService:
    """Preference store for workflow implementation choices backed by Firestore."""

    def __init__(self, collection_name: str = "workflow_preferences"):
        self._collection_name = collection_name
        self._lock = threading.Lock()
        self._cache: Dict[str, Dict] = {}
        self._storage_dir = os.path.join(SERVICE_ROOT_DIR, "storage", collection_name)
        os.makedirs(self._storage_dir, exist_ok=True)

    @staticmethod
    def _empty_data() -> Dict:
        return {"categories": {}, "contexts": {}}

    def _doc_id(self, user_id: Optional[str]) -> str:
        if not user_id:
            return "global"
        return f"user:{user_id}"

    def _doc_path(self, user_id: Optional[str]) -> str:
        doc_name = self._doc_id(user_id)
        safe = doc_name.replace("/", "_")
        return os.path.join(self._storage_dir, f"{safe}.json")

    def _load_data(self, user_id: Optional[str]) -> Dict:
        doc_key = self._doc_id(user_id)
        with self._lock:
            cached = self._cache.get(doc_key)
            if cached is not None:
                return copy.deepcopy(cached)

        path = self._doc_path(user_id)
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                    if not isinstance(data, dict):
                        data = self._empty_data()
            except Exception:
                data = self._empty_data()
        else:
            data = self._empty_data()

        data.setdefault("categories", {})
        data.setdefault("contexts", {})

        with self._lock:
            self._cache[doc_key] = copy.deepcopy(data)
        return copy.deepcopy(data)

    def _save_data(self, user_id: Optional[str], data: Dict) -> None:
        data.setdefault("categories", {})
        data.setdefault("contexts", {})
        path = self._doc_path(user_id)
        tmp_path = f"{path}.tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
            os.replace(tmp_path, path)
        except Exception:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except Exception:
                pass
        with self._lock:
            self._cache[self._doc_id(user_id)] = copy.deepcopy(data)

    @staticmethod
    def _context_key_from_path(h5_path: Optional[str]) -> Optional[str]:
        try:
            if not h5_path:
                return None
            base = h5_path.replace("\\", "/").split("/")[-1]
            if not base:
                return None
            return base.rsplit(".", 1)[0] if "." in base else base
        except Exception:
            return None

    @staticmethod
    def _get_bucket_for_context(data: Dict, ctx: Optional[str]) -> Dict:
        if not ctx:
            return data.setdefault("categories", {})
        contexts = data.setdefault("contexts", {})
        return contexts.setdefault(ctx, {})

    def _apply_feedback(
        self,
        data: Dict,
        nodes: List[Dict[str, str]],
        delta: int,
        ctx_key: Optional[str],
        user_label: str,
    ) -> Dict:
        for n in nodes:
            try:
                model = str(n.get("model", "")).strip()
                impl = str(n.get("impl", "")).strip()
                if not model or not impl:
                    continue
                model_map = data.setdefault("categories", {}).setdefault(model, {})
                entry = model_map.setdefault(impl, {"score": 0, "up": 0, "down": 0})
                entry["score"] = int(entry.get("score", 0)) + delta
                if delta > 0:
                    entry["up"] = int(entry.get("up", 0)) + 1
                else:
                    entry["down"] = int(entry.get("down", 0)) + 1
                if ctx_key:
                    ctx_bucket = self._get_bucket_for_context(data, ctx_key)
                    ctx_map = ctx_bucket.setdefault(model, {})
                    ctx_entry = ctx_map.setdefault(impl, {"score": 0, "up": 0, "down": 0})
                    ctx_entry["score"] = int(ctx_entry.get("score", 0)) + delta
                    if delta > 0:
                        ctx_entry["up"] = int(ctx_entry.get("up", 0)) + 1
                    else:
                        ctx_entry["down"] = int(ctx_entry.get("down", 0)) + 1
            except Exception:
                continue
        return data

    def record_feedback(
        self,
        nodes: List[Dict[str, str]],
        rating: str,
        h5_path: Optional[str] = None,
        context: Optional[Dict] = None,
        user_id: Optional[str] = None,
    ) -> Dict:
        if not isinstance(nodes, list):
            return {"success": False, "error": "nodes must be a list"}
        delta = 1 if str(rating).lower() == "up" else -1
        ctx_key = self._context_key_from_path(h5_path)
        data = self._load_data(user_id)
        data = self._apply_feedback(data, nodes, delta, ctx_key, self._doc_id(user_id))
        self._save_data(user_id, data)

        if user_id:
            global_data = self._load_data(None)
            global_data = self._apply_feedback(global_data, nodes, delta, ctx_key, "global")
            self._save_data(None, global_data)
        return {"success": True}

    def get_preferences(self, user_id: Optional[str] = None) -> Dict:
        return self._load_data(user_id)

    def get_sorted_impls(
        self,
        category: str,
        user_id: Optional[str] = None,
        include_global: bool = True,
    ) -> List[Tuple[str, Dict]]:
        data = self._load_data(user_id)
        cat = data.get("categories", {}).get(category, {})
        items = list(cat.items())
        if not items and include_global and user_id:
            fallback = self._load_data(None)
            items = list(fallback.get("categories", {}).get(category, {}).items())
        items.sort(key=lambda kv: (int(kv[1].get("score", 0)), int(kv[1].get("up", 0))), reverse=True)
        return items

    def format_preferences_for_prompt(self, user_id: Optional[str] = None) -> str:
        lines: List[str] = []
        data = self._load_data(user_id)
        categories = list(data.get("categories", {}).keys())
        if not categories and user_id:
            data = self._load_data(None)
            categories = list(data.get("categories", {}).keys())
        for cat in categories:
            sorted_impls = self.get_sorted_impls(cat, user_id=user_id)
            if not sorted_impls:
                continue
            top_name, top_stats = sorted_impls[0]
            if int(top_stats.get("score", 0)) <= 0:
                continue
            lines.append(f"For {cat}, prefer {top_name} (score {int(top_stats.get('score', 0))}).")
        return "\n".join(lines)

    def _sorted_items(self, bucket: Dict[str, Dict]) -> List[Tuple[str, Dict]]:
        items = list(bucket.items())
        items.sort(key=lambda kv: (int(kv[1].get("score", 0)), int(kv[1].get("up", 0))), reverse=True)
        return items

    def get_preference_summary(
        self,
        categories: List[str],
        context_key: Optional[str] = None,
        limit: int = 3,
        user_id: Optional[str] = None,
        include_global: bool = True,
    ) -> Dict[str, Dict[str, List[Dict[str, int]]]]:
        user_data = self._load_data(user_id)
        global_data = self._load_data(None) if include_global else self._empty_data()
        ctx_bucket = self._get_bucket_for_context(user_data, context_key) if context_key else {}

        summary: Dict[str, Dict[str, List[Dict[str, int]]]] = {}
        for cat in categories:
            user_entries = user_data.get("categories", {}).get(cat, {})
            global_entries = global_data.get("categories", {}).get(cat, {}) if include_global else {}
            ctx_entries = ctx_bucket.get(cat, {}) if isinstance(ctx_bucket, dict) else {}

            def _pack(primary: Dict[str, Dict], fallback: Dict[str, Dict], positive: bool) -> List[Dict[str, int]]:
                target = primary if primary else fallback
                if not target:
                    return []
                sorted_items = self._sorted_items(target)
                if positive:
                    filtered = [item for item in sorted_items if int(item[1].get("score", 0)) > 0]
                else:
                    filtered = [item for item in sorted_items if int(item[1].get("score", 0)) < 0]
                    filtered.sort(key=lambda kv: (int(kv[1].get("score", 0)), -int(kv[1].get("down", 0))))
                if limit:
                    filtered = filtered[:limit]
                return [
                    {
                        "impl": name,
                        "score": int(stats.get("score", 0)),
                        "up": int(stats.get("up", 0)),
                        "down": int(stats.get("down", 0)),
                    }
                    for name, stats in filtered
                ]

            summary[cat] = {
                "global_likes": _pack(user_entries, global_entries, True),
                "global_dislikes": _pack(user_entries, global_entries, False),
                "context_likes": _pack(ctx_entries, {}, True),
                "context_dislikes": _pack(ctx_entries, {}, False),
                "shared_likes": _pack(global_entries, {}, True) if user_entries else [],
                "shared_dislikes": _pack(global_entries, {}, False) if user_entries else [],
            }
        return summary

    def build_feedback_prompt(
        self,
        categories: List[str],
        context_key: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> str:
        summary = self.get_preference_summary(categories, context_key=context_key, user_id=user_id)
        lines: List[str] = []
        for cat in categories:
            data = summary.get(cat, {})
            if not data:
                continue
            lines.append(f"Category: {cat}")
            likes = data.get("context_likes") or data.get("global_likes") or data.get("shared_likes") or []
            dislikes = data.get("context_dislikes") or []
            if likes:
                liked_desc = ", ".join(
                    f"{item['impl']} (score {item['score']}, up {item['up']}, down {item['down']})"
                    for item in likes
                )
                lines.append(f"  Preferred: {liked_desc}")
            global_dislikes = data.get("global_dislikes") or data.get("shared_dislikes")
            dislikes = dislikes or global_dislikes
            if dislikes:
                disliked_desc = ", ".join(
                    f"{item['impl']} (score {item['score']}, up {item['up']}, down {item['down']})"
                    for item in dislikes
                )
                lines.append(f"  Avoid: {disliked_desc}")
        return "\n".join(lines).strip()


_feedback_service: Optional[FeedbackService] = None


def get_feedback_service() -> FeedbackService:
    global _feedback_service
    if _feedback_service is None:
        _feedback_service = FeedbackService()
    return _feedback_service
