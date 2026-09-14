"""Configuration loading: the service root's .env.local is honoured (desktop installs)."""
import os
import subprocess
import sys
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parents[2] / "app" / "service"


def _settings_value(tmp_root: Path, key: str, extra_env=None) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("OPENAI_", "LLM_", "TL_"))}
    env.update({"ENV": "test", "TL_SERVICE_ROOT": str(tmp_root), "AUTO_ACTIVATE_TASKNODES": "false"})
    env.update(extra_env or {})
    out = subprocess.run(
        [sys.executable, "-c", f"import os; from app.core.settings import settings; print('VALUE=' + os.getenv({key!r}, ''))"],
        cwd=SERVICE_DIR, env=env, capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, out.stderr[-500:]
    values = [line[len("VALUE="):] for line in out.stdout.splitlines() if line.startswith("VALUE=")]
    assert values, out.stdout[-300:]
    return values[-1]


def test_service_root_env_local_is_loaded(tmp_path):
    (tmp_path / ".env.local").write_text("OPENAI_API_KEY=from-service-root\nLLM_MODEL=root-model\n")
    assert _settings_value(tmp_path, "OPENAI_API_KEY") == "from-service-root"
    assert _settings_value(tmp_path, "LLM_MODEL") == "root-model"


def test_real_environment_wins_over_env_files(tmp_path):
    (tmp_path / ".env.local").write_text("LLM_MODEL=root-model\n")
    assert _settings_value(tmp_path, "LLM_MODEL", {"LLM_MODEL": "from-env"}) == "from-env"


def test_missing_env_local_is_fine(tmp_path):
    assert _settings_value(tmp_path, "OPENAI_API_KEY") == ""


def test_packaged_service_logs_under_the_service_root_not_its_bundle(monkeypatch, tmp_path):
    """In the frozen build this module lives inside the code-signed .app.

    Logging next to it invalidates the signature — macOS then refuses to launch
    the app — so a frozen service must follow --service-root instead.
    """
    import sys

    from app.core.logger import _resolve_log_dir

    monkeypatch.delenv("LOG_DIR_OVERRIDE", raising=False)
    monkeypatch.setenv("TL_SERVICE_ROOT", str(tmp_path))

    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert _resolve_log_dir() == str(tmp_path / "storage" / "logs")

    # A source checkout still logs next to the code, sharing nothing with Ctrl-Service.
    monkeypatch.delattr(sys, "frozen", raising=False)
    assert _resolve_log_dir() != str(tmp_path / "storage" / "logs")
