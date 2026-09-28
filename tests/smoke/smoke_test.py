"""End-to-end smoke test for the open edition service.

Boots ``main.py`` on a free port against a temporary service root, copies a
slide into the local user's storage and walks the real HTTP/WebSocket surface
the renderer uses: profile, file manager, slide instance + tiles, thumbnails,
zarr structure, segmentation websocket, workflow history, agent (expects the
"not configured" envelope unless OPENAI_API_KEY is set), bundle catalog.

    python tests/smoke/smoke_test.py --slide path/to/CMU-1.svs [--keep] [--no-mock-llm]
    python tests/smoke/smoke_test.py --slide path/to/CMU-1.svs --exe app/service/dist/TissueLab_AI/TissueLab_AI.exe

Exit code 0 means every check passed.
"""
import argparse
import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVICE_DIR = os.path.join(REPO_ROOT, "app", "service")

passes = 0
fails = 0


def check(name, ok, detail=""):
    global passes, fails
    if ok:
        passes += 1
        print(f"  [PASS] {name}")
    else:
        fails += 1
        print(f"  [FAIL] {name} {detail}")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def http(method, url, *, json_body=None, data=None, headers=None, timeout=120):
    body = None
    hdrs = dict(headers or {})
    if json_body is not None:
        body = json.dumps(json_body).encode()
        hdrs["Content-Type"] = "application/json"
    elif data is not None:
        body = data
    req = urllib.request.Request(url, data=body, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            return resp.status, _maybe_json(raw, ctype), ctype
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw), e.headers.get("Content-Type", "")
        except ValueError:
            return e.code, raw, e.headers.get("Content-Type", "")


def _maybe_json(raw, ctype):
    """The app envelope is JSON even when no Content-Type is set; images stay bytes."""
    if "image" in ctype or "octet-stream" in ctype:
        return raw
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def wait_ready(base, proc, timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise SystemExit("service exited early")
        try:
            st, _, _ = http("GET", f"{base}/api/v1/openapi.json", timeout=5)
            if st == 200:
                return
        except Exception:
            pass
        time.sleep(0.5)
    raise SystemExit("service did not become ready")


async def ws_segment_bind(ws_url, slide_rel, instance_id):
    import websockets

    async with websockets.connect(ws_url, max_size=None) as ws:
        await ws.send(json.dumps({"type": "set_path", "path": slide_rel, "instance_id": instance_id}))
        reply = await asyncio.wait_for(ws.recv(), timeout=120)
        return reply if isinstance(reply, str) else f"<binary {len(reply)} bytes>"


async def ws_presence(ws_url):
    import websockets

    async with websockets.connect(ws_url, max_size=None) as ws:
        await ws.send(json.dumps({"type": "ping"}))
        try:
            await asyncio.wait_for(ws.recv(), timeout=3)
        except asyncio.TimeoutError:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slide", required=True, help="path to a whole-slide image (e.g. CMU-1.svs)")
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--exe", default=None,
                    help="frozen service executable (PyInstaller dist/TissueLab_AI/TissueLab_AI[.exe]); used instead of python main.py")
    ap.add_argument("--keep", action="store_true", help="keep the temporary service root")
    ap.add_argument("--no-mock-llm", action="store_true",
                    help="do not start the mock OpenAI-compatible server (agent checks then expect 'not configured')")
    args = ap.parse_args()

    mock_llm = None
    if not args.no_mock_llm and not os.environ.get("OPENAI_API_KEY"):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from mock_llm_server import MockLLMServer
        mock_llm = MockLLMServer().start()
        print(f"mock OpenAI-compatible server on {mock_llm.base_url} (Chat Completions only)")

    root = tempfile.mkdtemp(prefix="tissuelab-smoke-")
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    env = dict(os.environ)
    env.update({
        "ENV": "local",
        "TL_SERVICE_ROOT": root,
        "AUTO_ACTIVATE_TASKNODES": "false",
        "CODEEXEC_DOCKER": "0",
        "PYTHONIOENCODING": "utf-8",
    })
    if mock_llm is not None:
        env.update({
            "OPENAI_API_KEY": "dummy",
            "OPENAI_BASE_URL": mock_llm.base_url,
            "LLM_MODEL": "mock-llm",
        })
        env.pop("LLM_API", None)
    log_path = os.path.join(root, "smoke-service.log")
    log = open(log_path, "wb")
    if args.exe:
        # The desktop shell launches the frozen binary exactly like this.
        cmd = [os.path.abspath(args.exe), "--port", str(port), "--env", "desktop", "--service-root", root]
        cwd = os.path.dirname(os.path.abspath(args.exe))
    else:
        cmd = [args.python, "main.py", "--port", str(port), "--service-root", root]
        cwd = SERVICE_DIR
    print("launching:", " ".join(cmd))
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
    try:
        if args.exe:
            # The service does no inference: the DL stack belongs to task node envs.
            internal = os.path.join(os.path.dirname(os.path.abspath(args.exe)), "_internal")
            bundled = {d.lower() for d in os.listdir(internal)} if os.path.isdir(internal) else set()
            forbidden = sorted(b for b in bundled if b.split("-")[0] in {
                "torch", "torchvision", "torchaudio", "transformers", "tensorflow", "keras",
                "numba", "firebase_admin", "google"})
            check("frozen bundle has no inference / cloud stack", not forbidden, str(forbidden))
            size_mb = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(os.path.dirname(os.path.abspath(args.exe))) for f in fs) / 1e6
            check("frozen bundle size sane (< 1500 MB)", size_mb < 1500, f"{size_mb:.0f} MB")
            # the full libvips build (slide loaders), not the pyvips[binary] wheel.
            # Windows keeps the vips-dev bin layout beside _internal/; macOS ships
            # the prefix layout libvips needs for its modules, under _internal/lib/.
            if sys.platform == "darwin":
                vips_dir = os.path.join(internal, "lib")
                libs = ("libvips.42.dylib", "libopenslide.1.dylib", "libopenjp2.7.dylib", "libheif.1.dylib")
            else:
                vips_dir = internal
                libs = ("libvips-42.dll", "libopenslide-1.dll", "libopenjp2.dll", "libheif.dll")
            vips_bundled = {d.lower() for d in os.listdir(vips_dir)} if os.path.isdir(vips_dir) else set()
            for lib in libs:
                found = os.path.isfile(os.path.join(vips_dir, lib)) or os.path.isfile(os.path.join(internal, lib))
                check(f"frozen bundle ships {lib}", found)
            check("frozen bundle ships vips-modules-*", any(d.startswith("vips-modules-") for d in vips_bundled), str(sorted(vips_bundled)[:5]))
            check("frozen bundle has no pyvips_binary", not any(d.startswith("pyvips_binary") for d in bundled))
        wait_ready(base, proc)
        print(f"service up on {base} (root {root})")
        log.flush()
        with open(log_path, "r", encoding="utf-8", errors="replace") as fh:
            banner = fh.read()
        vips_line = next((line for line in banner.splitlines() if "libvips" in line), "")
        check("service reports full libvips loaders", "openslide=yes" in vips_line and "jp2k=yes" in vips_line, vips_line.strip()[:160])

        # --- identity / profile ---
        st, me, _ = http("POST", f"{base}/api/users/v1/me")
        check("users/me", st == 200 and me.get("user_id") == "local", str(me)[:200])
        uid = me.get("user_id", "local")
        st, body, _ = http("POST", f"{base}/api/users/v1/update_profile", json_body={"preferred_name": "Smoke"})
        check("users/update_profile", st == 200 and body.get("success"))
        st, me, _ = http("POST", f"{base}/api/users/v1/me")
        check("profile persisted", me.get("preferred_name") == "Smoke")

        # --- file manager ---
        st, cfg, _ = http("GET", f"{base}/api/fm/v1/config")
        check("fm/config", st == 200 and cfg.get("defaultPath") == f"users/{uid}", str(cfg)[:200])
        user_dir = os.path.join(root, "storage", "uploads", "users", uid)
        os.makedirs(user_dir, exist_ok=True)
        slide_name = os.path.basename(args.slide)
        shutil.copy2(args.slide, os.path.join(user_dir, slide_name))
        slide_rel = f"users/{uid}/{slide_name}"
        st, rows, _ = http("GET", f"{base}/api/fm/v1/files?path=users/{uid}")
        check("fm/files lists the slide", st == 200 and any(r.get("name") == slide_name for r in rows), str(rows)[:200])
        st, body, _ = http("POST", f"{base}/api/fm/v1/files/create", json_body={"path": f"users/{uid}/smoke-folder/"})
        check("fm/files/create", st == 200 and body.get("success"), str(body)[:200])
        st, body, _ = http("POST", f"{base}/api/fm/v1/files/rename", json_body={"path": f"users/{uid}/smoke-folder", "new_path": f"users/{uid}/smoke-renamed"})
        check("fm/files/rename", st == 200 and body.get("success"), str(body)[:200])
        st, body, _ = http("POST", f"{base}/api/fm/v1/files/delete", json_body={"items": [f"users/{uid}/smoke-renamed"]})
        check("fm/files/delete", st == 200 and body.get("success"), str(body)[:200])
        st, body, _ = http("POST", f"{base}/api/fm/v1/files/create", json_body={"path": "samples/nope/"})
        check("fm write to samples denied", st == 200 and body.get("code") == 403, str(body)[:200])
        st, body, _ = http("GET", f"{base}/api/fm/v1/files/access?path={slide_rel}")
        check("fm/files/access", st == 200 and body.get("readOnly") is False and body.get("shareMode") is None, str(body)[:200])

        # --- slide instance, properties, tiles ---
        st, inst, _ = http("POST", f"{base}/api/load/v1/create_instance", json_body={"file_path": slide_rel})
        instance_id = (inst.get("data") or {}).get("instance_id") or (inst.get("data") or {}).get("instanceId")
        check("load/create_instance", st == 200 and inst.get("code") == 0 and instance_id, str(inst)[:300])
        hdr = {"X-Instance-ID": instance_id or ""}
        st, up, _ = http("POST", f"{base}/api/load/v1/upload_path", json_body={"relative_path": slide_rel}, headers=hdr)
        check("load/upload_path", st == 200 and up.get("code") == 0, str(up)[:300])
        st, info, _ = http("GET", f"{base}/api/load/v1/load/{slide_name}/", headers=hdr)
        check("load/load/<slide>", st == 200 and info.get("code") == 0, str(info)[:300])
        st, props, _ = http("GET", f"{base}/api/load/v1/properties", headers=hdr)
        check("load/properties", st == 200 and props.get("code") == 0, str(props)[:300])
        st, tile, ctype = http("GET", f"{base}/api/load/v1/tile/0/0_0.jpeg?instance_id={instance_id}", headers=hdr)
        check("load/tile level 0", st == 200 and isinstance(tile, (bytes, bytearray)) and len(tile) > 100 and "image" in ctype, f"{st} {ctype}")
        st, denied, _ = http("GET", f"{base}/api/load/v1/tile/0/0_0.jpeg?instance_id=not-mine")
        check("tile with unknown instance denied", st == 200 and isinstance(denied, dict) and denied.get("code") in (403, 404, 500), str(denied)[:200])

        # --- thumbnails ---
        st, th, _ = http("POST", f"{base}/api/thumbnail/v1/thumbnails", json_body={"session_id": instance_id, "size": 128, "request_id": "smoke-1"}, headers=hdr)
        check("thumbnail submit", st == 200 and th.get("code") == 0, str(th)[:300])
        task_id = (th.get("data") or {}).get("task_id")
        done = False
        if task_id:
            for _ in range(60):
                st, ts, _ = http("GET", f"{base}/api/thumbnail/v1/status/{task_id}", headers=hdr)
                status = (ts.get("data") or {}).get("status") or ts.get("status")
                if status in ("completed", "failed", "error"):
                    done = status == "completed"
                    break
                time.sleep(0.5)
        check("thumbnail completed", done, str(task_id))

        # --- zarr sidecar + structure ---
        zarr_rel = slide_rel + ".zarr"
        st, structure, _ = http("GET", f"{base}/api/data/v1/structure?path=/", headers={"X-Zarr-Path": zarr_rel, **hdr})
        check("data/structure reachable", st == 200 and isinstance(structure, dict), str(structure)[:200])

        # --- segmentation / presence websockets ---
        try:
            reply = asyncio.run(ws_segment_bind(f"ws://127.0.0.1:{port}/ws/segment/?token=local&device_id=smoke", slide_rel, instance_id))
            check("ws/segment bind", bool(reply), reply[:200])
        except Exception as e:
            check("ws/segment bind", False, repr(e))
        try:
            asyncio.run(ws_presence(f"ws://127.0.0.1:{port}/ws/presence?file_path={slide_rel}&token=local&device_id=smoke"))
            check("ws/presence own slide accepted", True)
        except Exception as e:
            check("ws/presence own slide accepted", False, repr(e))
        try:
            asyncio.run(ws_presence(f"ws://127.0.0.1:{port}/ws/presence?file_path=users/someone-else/x.svs&token=local&device_id=smoke"))
            check("ws/presence other user's path refused", False, "connection was accepted")
        except Exception as e:
            check("ws/presence other user's path refused", True, type(e).__name__)

        # --- workflow history + feedback ---
        st, hist, _ = http("POST", f"{base}/api/workflow_history/v1/workflow_history", json_body={
            "zarr_path": zarr_rel, "panels": [], "output_path": f"users/{uid}"})
        check("workflow_history save", st == 200 and hist.get("code") == 0, str(hist)[:200])
        st, hist, _ = http("GET", f"{base}/api/workflow_history/v1/workflow_history")
        check("workflow_history list", st == 200 and hist.get("data", {}).get("entries"), str(hist)[:200])
        st, fb, _ = http("POST", f"{base}/api/feedback/v1/rate", json_body={"nodes": [{"model": "NucleiSeg", "impl": "StarDist"}], "rating": "up"})
        check("feedback/rate", st == 200 and fb.get("code") == 0, str(fb)[:200])
        st, prefs, _ = http("GET", f"{base}/api/feedback/v1/preferences")
        check("feedback/preferences", st == 200 and prefs.get("code") == 0, str(prefs)[:200])

        # --- agent (self-hosted OpenAI-compatible endpoint, or the real key) ---
        st, ag, _ = http("POST", f"{base}/api/agent/v1/entrance_agent", json_body={"agent_id": "a", "prompt": "please segment nuclei"})
        if mock_llm is not None or os.environ.get("OPENAI_API_KEY"):
            check("agent/entrance_agent", st == 200 and ag.get("code") == 0 and ag["data"].get("label") in ("1", "2", "3"), str(ag)[:200])
            st, ch, _ = http("POST", f"{base}/api/agent/v1/chat", json_body={"agent_id": "a", "prompt": "hello", "history": [], "data_context": {"zarr_path": zarr_rel}})
            check("agent/chat", st == 200 and ch.get("code") == 0 and ch["data"].get("response"), str(ch)[:200])
            st, steps, _ = http("POST", f"{base}/api/agent/v1/get_steps", json_body={"agent_id": "a", "prompt": "count tumor cells", "data_context": {"zarr_path": zarr_rel}})
            ok = st == 200 and steps.get("code") == 0 and isinstance(steps.get("data"), list) and steps["data"] and all("impl" in x for x in steps["data"])
            check("agent/get_steps", ok, str(steps)[:300])
            st, code, _ = http("POST", f"{base}/api/agent/v1/process_script", json_body={"agent_id": "a", "prompt": "count", "data_context": {"zarr_structure": {}}})
            check("agent/process_script", st == 200 and code.get("code") == 0 and "analyze_medical_image" in str(code.get("data")), str(code)[:200])
            req = urllib.request.Request(f"{base}/api/agent/v1/process_script_stream", data=json.dumps({"agent_id": "a", "prompt": "count"}).encode(),
                                         method="POST", headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                sse = resp.read().decode("utf-8", "replace")
            events = [json.loads(l[5:]) for l in sse.splitlines() if l.startswith("data:")]
            check("agent/process_script_stream", any(e.get("done") and "analyze_medical_image" in e.get("code", "") for e in events), sse[:200])
            st, summ, _ = http("POST", f"{base}/api/tasks/v1/summary_answer", json_body={"agent_id": "a", "prompt": "how many?", "parameters": {"answer": "{\"count\": 3}"}})
            check("tasks/summary_answer via agent", st == 200 and summ.get("code") == 0 and summ["data"].get("response") and not summ["data"].get("control_error"), str(summ)[:200])
            if mock_llm is not None:
                paths = {r["path"] for r in mock_llm.requests}
                check("agent used only /v1/chat/completions on the self-hosted endpoint", paths == {"/v1/chat/completions"}, str(paths))
        else:
            check("agent/entrance_agent reports missing key", st == 200 and ag.get("code") == 501, str(ag)[:200])

        # --- workflow status stream (EventSource cannot set headers) ---
        try:
            req = urllib.request.Request(f"{base}/api/tasks/v1/get_status?token=local", headers={"Accept": "text/event-stream"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                first = resp.readline().decode("utf-8", "replace")
            check("tasks/get_status SSE first event", first.startswith("data:") or first.startswith("event:") or first.startswith(":"), first[:120])
        except Exception as e:
            check("tasks/get_status SSE first event", False, repr(e))
        st, cur, _ = http("GET", f"{base}/api/tasks/v1/current_workflow_status")
        check("tasks/current_workflow_status", st == 200 and cur.get("code") == 0 and "active" in cur.get("data", {}), str(cur)[:200])

        # --- nodes / bundles ---
        st, nodes, _ = http("GET", f"{base}/api/tasks/v1/list_nodes_extended")
        check("tasks/list_nodes_extended", st == 200 and nodes.get("code") == 0, str(nodes)[:200])
        st, cat, _ = http("GET", f"{base}/api/tasks/v1/bundles/catalog")
        check("tasks/bundles/catalog", st == 200 and cat.get("code") == 0, str(cat)[:200])

        # --- removed surfaces really are gone ---
        for path in ("/api/collect/v1/audio", "/api/community/v1/classifiers/public", "/api/cohort/projects",
                     "/api/behavior/v1/upload-url", "/api/tickets/v1/error", "/api/fm/v1/files/shared",
                     "/api/agent/v1/coscientist/sessions", "/api/users/v1/lookup_by_email"):
            st, body, _ = http("GET", f"{base}{path}")
            gone = st in (404, 405) or (isinstance(body, dict) and body.get("code") in (404, 405))
            check(f"removed {path}", gone, f"{st} {str(body)[:80]}")

        # --- teardown instance ---
        st, d, _ = http("DELETE", f"{base}/api/load/v1/delete_instance", json_body={"instance_id": instance_id}, headers=hdr)
        check("load/delete_instance", st == 200 and d.get("code") == 0, str(d)[:200])
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        if mock_llm is not None:
            mock_llm.stop()
        print(f"\n{passes} passed, {fails} failed. service log: {log_path}")
        if not args.keep and fails == 0:
            shutil.rmtree(root, ignore_errors=True)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
