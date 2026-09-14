"""The idle sweeper frees a server's memory; on the desktop it just loses work.

One user looking at one slide is not the pressure the sweeper was written for,
and the ping that keeps a handler alive stops whenever the machine sleeps — so
any long enough pause dropped the workset and the next HTTP call answered
"No segmentation handler for this instance. Open a slide first."
"""
import time

import pytest

from app.services import seg_registry


class _Handler:
    zarr_file = None

    def release_export_pool(self):
        pass


@pytest.fixture
def registry():
    seg_registry.instance_annotation_handlers.clear()
    seg_registry._handler_last_access.clear()
    yield seg_registry
    seg_registry.instance_annotation_handlers.clear()
    seg_registry._handler_last_access.clear()


def _add_idle(registry, instance_id, idle_for):
    registry.instance_annotation_handlers[instance_id] = _Handler()
    registry._handler_last_access[instance_id] = time.monotonic() - idle_for


def test_a_zero_ttl_keeps_handlers_forever(registry):
    """What the desktop build configures."""
    _add_idle(registry, "viewer-1", idle_for=10 * 60 * 60)
    assert registry.sweep_idle_handlers(ttl_sec=0) == 0
    assert "viewer-1" in registry.instance_annotation_handlers


def test_a_positive_ttl_still_sweeps(registry):
    """A server deployment keeps the behaviour it was written for."""
    _add_idle(registry, "viewer-1", idle_for=700)
    assert registry.sweep_idle_handlers(ttl_sec=600) == 1
    assert "viewer-1" not in registry.instance_annotation_handlers


def test_a_recently_touched_handler_survives(registry):
    _add_idle(registry, "viewer-1", idle_for=700)
    registry.touch_annotation_handler("viewer-1")
    assert registry.sweep_idle_handlers(ttl_sec=600) == 0
    assert "viewer-1" in registry.instance_annotation_handlers


def test_desktop_env_disables_the_sweep():
    """ENV=desktop is what Electron passes the packaged service."""
    import os
    import subprocess
    import sys
    from pathlib import Path

    # Inherit the real environment and override only what is under test. A
    # hand-built env cannot start Python on Windows, where the interpreter
    # needs SystemRoot to initialise winsock.
    env = {**os.environ, "ENV": "desktop"}
    env.pop("HANDLER_IDLE_TTL_SEC", None)  # an explicit override would mask the default

    service = Path(__file__).resolve().parents[2] / "app" / "service"
    out = subprocess.run(
        [sys.executable, "-c",
         "from app.core.settings import settings; print(settings.HANDLER_IDLE_TTL_SEC)"],
        cwd=service, capture_output=True, text=True, env=env,
    )
    assert out.returncode == 0, out.stderr[-400:]
    assert float(out.stdout.strip().splitlines()[-1]) == 0.0
