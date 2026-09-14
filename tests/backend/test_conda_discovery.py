"""Finding conda without a shell.

The desktop build is launched from Finder/Dock, so it inherits a bare PATH and
none of the rc files `conda init` edits — and on macOS those are zsh's, which a
bash login shell never reads. These cover the search order that replaced it.
"""
import os
import stat

import pytest

from app.utils.workflow import register


@pytest.fixture(autouse=True)
def _forget_the_memo():
    """find_conda_executable caches its answer for the life of the process."""
    register._CONDA_EXE_MEMO.clear()
    yield
    register._CONDA_EXE_MEMO.clear()


def _fake_conda(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


def test_conda_exe_env_var_wins(monkeypatch, tmp_path):
    exe = _fake_conda(tmp_path / "bin" / "conda")
    monkeypatch.setenv("CONDA_EXE", exe)
    assert register.find_conda_executable() == exe


def test_a_stale_conda_exe_does_not_win(monkeypatch, tmp_path):
    """The variable can point at an env that has since been deleted."""
    monkeypatch.setenv("CONDA_EXE", str(tmp_path / "gone" / "conda"))
    monkeypatch.setattr(register.shutil, "which", lambda _: None)
    monkeypatch.setattr(register, "_conda_exe_candidates", list)
    monkeypatch.setattr(register, "_conda_exe_from_login_shell", lambda: None)
    assert register.find_conda_executable() is None


def test_falls_back_to_a_standard_install_location(monkeypatch, tmp_path):
    """The Finder case: no CONDA_EXE, nothing on PATH, conda in ~/miniforge3.

    A POSIX layout (``bin/conda``), so the platform is pinned rather than left
    to the host: on Windows the candidate list looks under ``Scripts`` and
    would never consider this file.
    """
    monkeypatch.setattr(register, "_is_windows", lambda: False)
    exe = _fake_conda(tmp_path / "miniforge3" / "bin" / "conda")
    monkeypatch.delenv("CONDA_EXE", raising=False)
    monkeypatch.setattr(register.shutil, "which", lambda _: None)
    monkeypatch.setattr(register.os.path, "expanduser", lambda p: str(tmp_path))
    assert register.find_conda_executable() == exe


def test_candidates_cover_the_common_install_roots(monkeypatch):
    monkeypatch.setattr(register.os.path, "expanduser", lambda p: "/home/x")
    monkeypatch.setattr(register, "_is_windows", lambda: False)
    candidates = register._conda_exe_candidates()
    # Assembled the way the implementation assembles them: the separator comes
    # from the host running the test, not from the platform being simulated.
    for base, name in (("/home/x", "miniforge3"), ("/home/x", "miniconda3"),
                       ("/home/x", "anaconda3"), ("/opt", "miniconda3"),
                       ("/usr/local", "anaconda3")):
        assert os.path.join(base, name, "bin", "conda") in candidates


def test_login_shell_is_the_last_resort(monkeypatch, tmp_path):
    """Covers a conda installed somewhere the candidate list cannot guess."""
    exe = _fake_conda(tmp_path / "opt" / "custom" / "conda")
    monkeypatch.delenv("CONDA_EXE", raising=False)
    monkeypatch.setattr(register.shutil, "which", lambda _: None)
    monkeypatch.setattr(register, "_conda_exe_candidates", list)
    monkeypatch.setattr(register, "_conda_exe_from_login_shell", lambda: exe)
    assert register.find_conda_executable() == exe


def test_no_conda_anywhere_is_reported_not_raised(monkeypatch):
    monkeypatch.delenv("CONDA_EXE", raising=False)
    monkeypatch.setattr(register.shutil, "which", lambda _: None)
    monkeypatch.setattr(register, "_conda_exe_candidates", list)
    monkeypatch.setattr(register, "_conda_exe_from_login_shell", lambda: None)
    assert register.find_conda_executable() is None
    assert register._run_conda(["env", "list"]) is None
    assert register.list_available_conda_envs() == {"status": "success", "envs": []}


def test_env_listing_survives_junk_from_conda(monkeypatch):
    class _Proc:
        returncode = 0
        stdout = "not json at all"

    monkeypatch.setattr(register, "_run_conda", lambda *a, **k: _Proc())
    assert register.list_available_conda_envs() == {"status": "success", "envs": []}


def test_env_names_come_from_the_prefixes(monkeypatch):
    class _Proc:
        returncode = 0
        stdout = '{"envs": ["/home/x/miniforge3", "/home/x/miniforge3/envs/tl"]}'

    monkeypatch.setattr(register, "_run_conda", lambda *a, **k: _Proc())
    assert register.list_available_conda_envs()["envs"] == ["miniforge3", "tl"]
    assert register._conda_env_path("tl") == "/home/x/miniforge3/envs/tl"
    assert register._conda_env_path("absent") is None


def test_windows_paths_are_split_on_either_separator():
    assert register._conda_env_name_of(r"C:\\Users\\x\\miniconda3\\envs\\tl") == "tl"
    assert register._conda_env_name_of("/home/x/miniforge3/envs/tl") == "tl"


def test_conda_runs_without_this_services_import_path(monkeypatch, tmp_path):
    """conda has its own python and its own packages.

    PYTHONPATH and the user site directory both bind ahead of an env's
    site-packages, so leaving them set points conda's interpreter at whatever
    launched this service.
    """
    seen = {}

    def _capture(cmd, **kwargs):
        seen.update(kwargs.get("env") or {})
        class _P:
            returncode = 0
            stdout = '{"envs": []}'
        return _P()

    monkeypatch.setenv("CONDA_EXE", _fake_conda(tmp_path / "conda"))
    monkeypatch.setenv("PYTHONPATH", "/frozen/lib")
    monkeypatch.setattr(register.subprocess, "run", _capture)
    register._run_conda(["env", "list", "--json"])
    assert "PYTHONPATH" not in seen
    assert seen.get("PYTHONNOUSERSITE") == "1"
