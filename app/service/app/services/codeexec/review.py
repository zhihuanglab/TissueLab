"""LLM safety review — the second (best-effort) layer.

Asks a model whether the code tries to touch anything outside the user's own
data / outputs, shell out, hit the network, or otherwise escape the per-user
sandbox. Best-effort by design: if no LLM is configured, or the call fails, it
fails OPEN (allows) — because the AST guard and the Docker sandbox are the hard
layers; this one only adds semantic intent-detection on top.
"""

import json
import os
from typing import Tuple

from app.core.logger import logger

_REVIEW_MODEL = os.getenv("CODEEXEC_REVIEW_MODEL", "gpt-4o-mini")
# OFF by default. The Docker sandbox's read-only mounts are the hard boundary that
# physically prevents touching other users' files, and the AST guard blocks
# shell/network/escape. The LLM review is an unreliable soft layer that false-blocks
# normal file/path operations, so it is opt-in (CODEEXEC_REVIEW=1) only.
_REVIEW_ENABLED = os.getenv("CODEEXEC_REVIEW", "0") == "1"

_SYSTEM = (
    "You are a LENIENT safety reviewer for a HARDENED per-user analysis sandbox. "
    "The code already runs inside a locked-down container: NO network, the filesystem "
    "is READ-ONLY except the user's own output folder, and there are strict memory/CPU "
    "limits. So the sandbox itself ALREADY makes it impossible to modify or delete other "
    "users' files, reach the network, or escape — you do not need to enforce any of that. "
    "Because of this, you must NOT flag ordinary data-analysis code. In particular, the "
    "following are ALWAYS SAFE: reading any data; writing to the output folder; and ALL "
    "path operations (os.path.abspath / join / dirname / basename, pathlib, os.listdir, "
    "os.makedirs, reading or writing files, computing absolute paths). The sandbox — not "
    "you — decides where writes actually land. "
    "ONLY mark code UNSAFE if it is BLATANTLY malicious and not explained by analysis: e.g. "
    "a deliberate fork bomb / infinite resource-exhaustion loop, crypto mining, or an "
    "obvious attempt to exploit the Python interpreter to break out of the container. "
    "When in any doubt, mark it SAFE. "
    'Reply ONLY as JSON: {"safe": true|false, "reason": "<one short sentence>"}.'
)


def review_code(code: str) -> Tuple[bool, str]:
    """Return (allowed, reason). Fails open when the LLM is unavailable."""
    if not _REVIEW_ENABLED:
        return True, "LLM review disabled (CODEEXEC_REVIEW != 1)"
    # os.environ, not settings: Preferences may set the key after startup.
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return True, "LLM review skipped (no OPENAI_API_KEY)"
    try:
        from openai import OpenAI

        client = OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model=_REVIEW_MODEL,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": f"```python\n{code}\n```"},
            ],
        )
        data = json.loads(resp.choices[0].message.content or "{}")
        safe = bool(data.get("safe", True))
        reason = str(data.get("reason", "")).strip() or ("ok" if safe else "flagged")
        return safe, reason
    except Exception as e:
        # Best-effort: don't block execution on a review outage — guard + sandbox cover us.
        logger.warning(f"[codeexec] LLM review unavailable, allowing: {e}")
        return True, f"LLM review unavailable: {e}"
