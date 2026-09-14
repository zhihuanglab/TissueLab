"""Local profile/avatar, workflow history store and the agent knowledge base."""
import io
from datetime import datetime, timedelta, timezone

import pytest


def test_profile_round_trip(client, local_uid):
    r = client.post("/api/users/v1/init_me")
    assert r.status_code == 200 and r.json()["success"] is True

    r = client.post("/api/users/v1/update_profile", json={
        "preferred_name": "Dr. Local",
        "custom_title": "Pathologist",
        "organization": "Home lab",
    })
    assert r.status_code == 200 and r.json()["success"] is True

    me = client.post("/api/users/v1/me").json()
    assert me["preferred_name"] == "Dr. Local"
    assert me["custom_title"] == "Pathologist"
    assert me["organization"] == "Home lab"
    assert me["registered_at"] > 0


def test_avatar_upload_get_delete(client, local_uid):
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    r = client.post(f"/api/users/{local_uid}/avatar", files={"file": ("me.png", io.BytesIO(png), "image/png")})
    assert r.status_code == 200, r.text
    url = r.json()["avatar_url"]
    assert f"/api/users/{local_uid}/avatar" in url

    assert client.post("/api/users/v1/me").json()["avatar_url"]

    r = client.get(f"/api/users/{local_uid}/avatar")
    assert r.status_code == 200 and r.content == png

    r = client.delete(f"/api/users/{local_uid}/avatar")
    assert r.status_code == 200 and r.json()["removed"] is True
    assert client.post("/api/users/v1/me").json()["avatar_url"] is None

    # unsupported format is a 400 in the app envelope
    r = client.post(f"/api/users/{local_uid}/avatar", files={"file": ("me.exe", io.BytesIO(b"MZ"), "application/octet-stream")})
    assert r.status_code == 200 and r.json()["code"] == 400


def test_other_user_avatar_is_forbidden(client):
    r = client.get("/api/users/somebody/avatar")
    assert r.status_code == 200
    assert r.json()["code"] == 403


def test_workflow_history_api_round_trip(client):
    body = {
        "name": "run 1",
        "zarr_path": "users/local/slide.svs.zarr",
        "panels": [{"model": "NucleiSeg", "impl": "StarDist"}],
        "output_path": "users/local/out",
        "color": "#ff0000",
        "number": 1,
    }
    r = client.post("/api/workflow_history/v1/workflow_history", json=body)
    assert r.status_code == 200 and r.json()["code"] == 0
    entry_id = r.json()["data"]["id"]

    r = client.get("/api/workflow_history/v1/workflow_history")
    entries = r.json()["data"]["entries"]
    assert any(e["id"] == entry_id for e in entries)
    entry = next(e for e in entries if e["id"] == entry_id)
    assert entry["name"] == "run 1"
    assert isinstance(entry["created_at"], str)

    r = client.get(f"/api/workflow_history/v1/workflow_history/{entry_id}")
    assert r.json()["data"]["panels"][0]["impl"] == "StarDist"

    # upsert keeps created_at
    created = r.json()["data"]["created_at"]
    r = client.post("/api/workflow_history/v1/workflow_history", json={**body, "id": entry_id, "name": "renamed"})
    assert r.json()["data"]["id"] == entry_id
    r = client.get(f"/api/workflow_history/v1/workflow_history/{entry_id}").json()["data"]
    assert r["name"] == "renamed" and r["created_at"] == created

    r = client.delete(f"/api/workflow_history/v1/workflow_history/{entry_id}")
    assert r.json()["data"]["deleted"] == entry_id
    r = client.get(f"/api/workflow_history/v1/workflow_history/{entry_id}")
    assert r.json()["code"] == 404


def test_workflow_history_repo_orders_newest_first(tmp_path):
    from app.repos.schema.workflow_history import WorkflowHistoryEntry
    from app.repos.workflow_history_repo import WorkflowHistoryRepo

    repo = WorkflowHistoryRepo(base_dir=str(tmp_path))
    now = datetime.now(timezone.utc)
    for i in range(3):
        repo.save_entry("u", WorkflowHistoryEntry(
            id=f"e{i}", name=f"n{i}", created_at=now - timedelta(minutes=3 - i), updated_at=now,
            zarr_path="z", panels=[], output_path="o",
        ))
    ids = [e["id"] for e in repo.list_entries("u")]
    assert ids == ["e2", "e1", "e0"]
    assert [e["id"] for e in repo.list_entries("u", limit=1)] == ["e2"]
    assert repo.delete_entry("u", "e1") is True
    assert repo.delete_entry("u", "e1") is False
    # ids are sanitised to [A-Za-z0-9-_]; nothing can escape the user folder
    assert repo.get_entry("u", "../escape") is None
    assert not (tmp_path / "escape.json").exists()
    with pytest.raises(ValueError):
        repo.get_entry("u", "..")


def test_knowledge_store_upsert_find_delete(tmp_path):
    from app.repos.schema.knowledge import KnowledgeItem
    from app.services.agent.knowledge_store import KnowledgeStore

    store = KnowledgeStore(base_dir=str(tmp_path))
    item = KnowledgeItem(user_id="u", title="prefer StarDist", content="use StarDist for H&E",
                         original_query="segment nuclei", context_key="slide1", tags=["nuclei"])
    kid = store.upsert("u", item)
    assert kid
    assert store.find_by_query("u", "segment nuclei", "slide1").knowledge_id == kid
    assert store.find_by_query("u", "segment nuclei", None) is None
    assert store.find_by_query("u", "segment nuclei", "other") is None

    item.content = "updated"
    assert store.upsert("u", item) == kid
    listed = store.list_items("u")
    assert len(listed) == 1 and listed[0].content == "updated"

    assert store.delete("u", kid) is True
    assert store.list_items("u") == []
    assert store.list_items("nobody") == []


def test_agent_learns_corrections_through_the_local_store(tmp_path, monkeypatch):
    """WorkflowAgent._save_knowledge merges follow-up corrections without a database."""
    from app.services.agent import knowledge_store as ks
    from app.services.agent.workflow_agent import WorkflowAgent

    monkeypatch.setattr(ks, "_store", ks.KnowledgeStore(base_dir=str(tmp_path)))
    agent = WorkflowAgent.__new__(WorkflowAgent)
    agent._knowledge_cache = {}
    import threading
    agent._knowledge_lock = threading.Lock()

    kid = agent._save_knowledge("u", "t", "c1", original_query="q", context_key=None, tags=["a"])
    kid2 = agent._save_knowledge("u", "t2", "c2", original_query="q", context_key=None, tags=["b"])
    assert kid == kid2
    items = agent._load_user_knowledge("u")
    assert len(items) == 1
    assert "c1" in items[0].content and "[Follow-up Correction] c2" in items[0].content
    assert set(items[0].tags) == {"a", "b"}
    assert items[0].version == 2
    assert "USER PREFERENCES AND CORRECTIONS" in agent._format_knowledge_for_prompt(items)
