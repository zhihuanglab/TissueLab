# Local mode: identity, permissions and network exposure

The open edition runs as a single local process for a single person. This
page explains how identity and access control work, and why the design keeps
the permission checks instead of deleting them.

## One principal, unchanged guards

The hosted TissueLab verifies a Firebase ID token on every request and keeps
share grants in a database. The open edition has neither, and follows the
pattern used by other single-user open-source servers:

| Project | Single-user mode |
|---------|------------------|
| Open WebUI | `WEBUI_AUTH=false` → every request runs as a fixed admin user; role checks still execute |
| Langflow | `LANGFLOW_AUTO_LOGIN=true` → auto-login as the superuser |
| Grafana | `auth.anonymous.enabled` with a fixed org role |
| Jupyter, ComfyUI, Ollama | no accounts; bind 127.0.0.1 by default, opt in to `0.0.0.0` |

TissueLab does the same:

* `app/service/app/core/identity.py` defines the single principal (`local`,
  configurable with `TL_LOCAL_USER_ID`). The HTTP middleware
  (`app/middlewares/auth_middleware.py`) and the WebSocket helpers attach it to
  **every** request. `AuthUser`, `request.state.user`, `get_auth_user` and
  `get_optional_auth_user` keep their names and shapes, so the route handlers
  and every path guard are untouched.
* The guards in `app/core/access.py` and `app/config/path_config.py` still run:
  * paths must resolve under `users/<uid>` or the read-only `samples` area, or
    be an absolute path — a location the person at the machine named themselves
    (their slide in `~/Downloads`, the `.zarr` sidecar a run is about to write
    next to it), gated by the filesystem's own permissions and nothing else;
  * **authorization asks where a path is, never whether it is there.** Every
    output path is missing at the moment it is authorized, so a guard that
    also required existence turns "run a workflow on a new slide" into a 403.
    A missing file is a 404 / `FileNotFoundError` from the handler;
  * the Samples area rejects writes and exports (`PUBLIC_READ_ONLY_FORBIDDEN`);
  * viewer instances must belong to the caller;
  * `..` and encoded traversal are normalised before any prefix check.
* Cross-user sharing does not exist. `get_path_share_mode` returns `None` and
  `FilesRepo` (`app/repos/files.py`) answers "no record" for every lookup — the
  Null Object pattern, not a stub waiting for a database. The file manager
  stats the filesystem directly; it did that already, the hosted file table was
  only a size/mtime cache plus the share ACL.

## What was removed, not stubbed

Data-collection features are gone rather than disabled: request logs and
workflow-usage rollups, error tickets, behaviour/eye-tracking logs, voice
capture (`/api/collect`, `/ws/collect/realtime`), training-data collection in
the agent, the community marketplace, cohort analysis and autoresearch.
Workflow history, feedback preferences and the agent's per-user knowledge base
are kept and stored as JSON under `app/service/storage/users/<uid>/`.

## Network exposure

The service performs no authentication, so exposure is controlled by binding.
`main.py` listens on `127.0.0.1` unless `--host` or `TL_HOST` says otherwise,
and prints a warning when bound to a non-loopback interface. Anyone who can
reach the port can read and modify every slide under the storage root — only
open it on a network you trust, or put a reverse proxy with its own
authentication in front of it.

## Storage layout

```
<TL_SERVICE_ROOT>/storage/
├── uploads/
│   ├── users/local/        # personal files (slides, .zarr sidecars, .tlcls classifiers)
│   └── samples/            # public read-only samples
├── users/local/            # profile.json, avatar, workflow_history/, knowledge_base.json
├── workflow_preferences/   # feedback preference store
├── discovery_sessions/     # Research panel sessions (runs themselves live in <workspace>/autoresearch_runs/)
├── model_registry.json     # installed task nodes
├── nodes/, tasknode_logs/  # task node bundles and their logs
└── logs/                   # service log
```

`TL_SERVICE_ROOT` defaults to `app/service`; the desktop app passes
`--service-root <per-user app data dir>`.
