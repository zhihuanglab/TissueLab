"""OpenAI-compatible chat client with image input, configured like the service.

Key/model/base URL come from the environment or the service's ``.env.local``
(``app/service/.env.local``, or ``$TL_SERVICE_ROOT/.env.local`` for an
installed app): ``OPENAI_API_KEY``, ``OPENAI_BASE_URL``, ``CODE_MODEL`` /
``LLM_MODEL``. No import of the service package, so this also runs standalone.
"""
import base64
import io
import os
import sys
import time
from typing import Any, Dict, List, Optional

PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
SERVICE_DIR = os.path.abspath(os.path.join(PACKAGE_DIR, "..", "..", "..", ".."))  # app/service
DEFAULT_MODEL = "gpt-5.4"
MAX_IMAGE_SIDE = 1600


def service_env() -> Dict[str, str]:
    """KEY=VALUE pairs of the service .env.local; values already in os.environ win."""
    out: Dict[str, str] = {}
    candidates = []
    if os.getenv("TL_SERVICE_ROOT"):
        candidates.append(os.path.join(os.getenv("TL_SERVICE_ROOT"), ".env.local"))
    candidates.append(os.path.join(SERVICE_DIR, ".env.local"))
    for path in candidates:
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and v:
                    out.setdefault(k, v)
        break
    for k, v in out.items():
        os.environ.setdefault(k, v)
    return out


def default_model() -> str:
    service_env()
    return os.getenv("CODE_MODEL") or os.getenv("LLM_MODEL") or DEFAULT_MODEL


def is_reasoning_model(model: str) -> bool:
    m = (model or "").lower()
    return m.startswith("gpt-5") or m.startswith("o1") or m.startswith("o3") or m.startswith("o4")


def image_data_url(path: str, max_side: Optional[int] = MAX_IMAGE_SIDE) -> str:
    """PNG data URL. ``max_side`` downscales the long side; None sends the bytes as they are."""
    if max_side is None:
        with open(path, "rb") as f:
            raw = f.read()
        mime = "image/jpeg" if path.lower().endswith((".jpg", ".jpeg")) else "image/png"
        return f"data:{mime};base64," + base64.b64encode(raw).decode()
    from PIL import Image
    im = Image.open(path).convert("RGB")
    w, h = im.size
    f = max_side / max(w, h)
    if f < 1:
        im = im.resize((int(w * f), int(h * f)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


class LLM:
    """One chat call at a time; transient API errors are retried."""

    def __init__(self, model: Optional[str] = None, reasoning_effort: Optional[str] = None):
        service_env()
        from openai import OpenAI
        key = os.getenv("OPENAI_API_KEY", "")
        if not key:
            sys.exit("ERROR: OPENAI_API_KEY not set (environment or app/service/.env.local)")
        self.client = OpenAI(api_key=key, base_url=os.getenv("OPENAI_BASE_URL") or None)
        self.model = model or default_model()
        self.reasoning_effort = reasoning_effort
        self.calls = 0

    def chat(self, system: str, user: str, image_paths: Optional[List[str]] = None,
             max_tokens: int = 4000, image_max_side: Optional[int] = MAX_IMAGE_SIDE,
             images_first: bool = False) -> str:
        parts: List[Dict[str, Any]] = []
        img_parts = [{"type": "image_url", "image_url": {"url": image_data_url(p, image_max_side), "detail": "high"}}
                     for p in (image_paths or [])]
        text_part = {"type": "text", "text": user}
        parts = img_parts + [text_part] if images_first else [text_part] + img_parts
        kwargs: Dict[str, Any] = dict(model=self.model, max_completion_tokens=max_tokens,
                                      messages=[{"role": "system", "content": system},
                                                {"role": "user", "content": parts}])
        if self.reasoning_effort and is_reasoning_model(self.model):
            kwargs["reasoning_effort"] = self.reasoning_effort
        for attempt in range(4):
            try:
                self.calls += 1
                resp = self.client.chat.completions.create(**kwargs)
                return resp.choices[0].message.content or ""
            except Exception as e:
                msg = str(e).lower()
                if attempt < 3 and any(k in msg for k in ("rate_limit", "overloaded", "server_error", "timeout", "502", "503")):
                    time.sleep(20 * (attempt + 1))
                    continue
                raise
