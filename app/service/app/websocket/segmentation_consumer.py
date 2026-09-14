import json
import asyncio
import zstandard as zstd
import time
import os
import threading
import traceback
from fastapi import WebSocket, WebSocketDisconnect
from concurrent.futures import ThreadPoolExecutor
from app.services.seg import SegmentationHandler
from app.services.seg_registry import (
    get_annotation_handler,
    get_or_create_annotation_handler,
    pop_instance_handlers,
    set_annotation_handler,
    touch_annotation_handler,
)
from app.utils import resolve_path
from app.config.zarr_compat import as_zarr_path, is_zarr_store_path
from app.config.path_config import resolve_virtual_path
from app.middlewares.websocket_auth_middleware import websocket_auth_required, get_device_id_from_websocket
from app.core.auth import AuthUser
from app.core.background import track_background_task
from app.services.load import assert_session_owner, get_session_file_path
from app.websocket.device_connection_manager import device_connection_manager
from app.core.logger import logger
from app.core.executors import slide_metadata_executor
from app.websocket.overlay_binary import (
    KIND_ALL_ANNOTATIONS,
    KIND_ANNOTATIONS,
    pack_centroids_frame,
    pack_contours_frame,
)
from typing import Optional, Dict, Set

# Handlers are keyed by instance_id in app.services.seg_registry.
#
# Viewport queries are the slow, disk-bound half; packing + zstd is the fast,
# CPU-bound half that runs once per reply. Sharing one pool let a compression
# sit in front of a query and vice versa, so with a few viewers open the five
# slots were mostly occupied by work that was not the query anyone was waiting
# on. Separate pools: a query never queues behind a compression again.
executor = ThreadPoolExecutor(max_workers=5, thread_name_prefix="seg-query")
frame_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="seg-frame")


receive_count = 0
_compressor_local = threading.local()


def _compressor() -> zstd.ZstdCompressor:
    """One compressor per thread — ZstdCompressor must not be shared across them.

    ``threads=-1`` splits a large frame across cores (20 MB: 26 ms -> 6 ms, same
    bytes out); zstd keeps small frames single-threaded, so they pay nothing.
    """
    compressor = getattr(_compressor_local, "instance", None)
    if compressor is None:
        compressor = zstd.ZstdCompressor(level=1, threads=-1)
        _compressor_local.instance = compressor
    return compressor


def _keep_instances_alive(instance_ids: Set[str]) -> None:
    """Count a live socket as presence for the viewers it is serving.

    Both idle sweepers measure "abandoned" as time since the last request naming
    the instance, and an open viewer that nobody is panning sends none — so its
    handler was swept out from under it and the next pan returned NoDataError.

    One socket multiplexes every viewer in the app and outlives any single one,
    so ids are dropped once delete_instance has taken the session away. Without
    that, a viewer whose teardown failed would be pinned in memory for as long
    as the app stayed open — the leak the sweeper exists to prevent.
    """
    if not instance_ids:
        return
    from app.services.load import touch_session

    for instance_id in list(instance_ids):
        if touch_session(instance_id):
            touch_annotation_handler(instance_id)
        else:
            instance_ids.discard(instance_id)


def _viewport_handler_replaced(instance_id: str, handler) -> bool:
    """True if set_path rebound this instance while a viewport job was in the pool.

    In-flight centroids/patches/annotations keep a reference to the old handler.
    Sending those results after a path switch paints the previous overlay on the
    new slide for one frame.
    """
    return get_annotation_handler(instance_id) is not handler


# Slide binds run off the receive loop, one at a time per instance: a second
# set_path for the same viewer must not interleave with the first (they pop and
# recreate the same registry entry). Counted so the lock can be dropped only
# when nobody holds or awaits it.
_bind_locks: Dict[str, asyncio.Lock] = {}
_binds_in_flight: Dict[str, int] = {}
# Path of the in-flight bind per instance, for the duplicate check in spawn_bind.
_bind_paths: Dict[str, str] = {}


def spawn_bind(
    websocket, device_id: str, connection_id: str, payload: dict, user
) -> Optional[asyncio.Task]:
    """Run a set_path bind in the background, serialized per instance.

    Returns ``None`` when the request duplicates one already in flight.
    """
    instance_id = payload.get("instance_id") or payload.get("instanceId") or ""
    path = payload.get("path") or ""

    # The viewer sends set_path from several places and can emit two for one
    # slide open. Binds are serialized per instance, so the second does not
    # interleave — it queues, and measured 906 ms of pure waiting before redoing
    # work the first bind had just finished. Identical path, nothing to redo:
    # drop it and let the first bind's ack answer both. A set_path for a
    # *different* path is a real switch and still runs.
    # A forced rebind (workflow completion, explicit reload) is never a duplicate:
    # the bind in flight may have read the zarr before the run finished writing
    # it, and this request is the only one that will re-read.
    if (
        not payload.get("force_reload")
        and _binds_in_flight.get(instance_id)
        and _bind_paths.get(instance_id) == path
    ):
        logger.info(
            "[WebSocket] skipping duplicate set_path for %s (bind already in flight)",
            instance_id,
        )
        return None

    # Registered here, not inside the task: the task body does not run until the
    # loop next yields, and a viewport request read before that would be served
    # from the handler this bind is about to replace.
    _binds_in_flight[instance_id] = _binds_in_flight.get(instance_id, 0) + 1
    _bind_paths[instance_id] = path
    lock = _bind_locks.setdefault(instance_id, asyncio.Lock())

    async def _run() -> None:
        try:
            async with lock:
                # Hold the stale-connection sweeper off for the whole bind, not
                # just until the task was scheduled.
                with device_connection_manager.handling(device_id, connection_id):
                    await handle_segmentation_message(
                        websocket, device_id, payload, user=user
                    )
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error(
                f"WebSocket: bind failed for instance {instance_id}: {e}", exc_info=e
            )
        finally:
            remaining = _binds_in_flight.get(instance_id, 1) - 1
            if remaining > 0:
                _binds_in_flight[instance_id] = remaining
            else:
                _binds_in_flight.pop(instance_id, None)
                _bind_locks.pop(instance_id, None)
                _bind_paths.pop(instance_id, None)

    return asyncio.create_task(_run())


async def _send_request_dropped(
    websocket, request_type: Optional[str], instance_id: Optional[str], reason: str
) -> None:
    """Ack a viewport request that will never produce data.

    Returning silently leaves the client's overlay flight open forever: the
    viewer only clears its "loading annotations" spinner when a request settles,
    so one unanswered centroids/annotations/patches request spins until reload.
    ``status: dropped`` settles the flight as "not applied" — the client keeps
    the layer pending and re-requests for the live viewport.
    """
    try:
        await websocket.send_text(json.dumps({
            "status": "dropped",
            "type": request_type,
            "instance_id": instance_id,
            "message": reason,
        }))
    except Exception as e:
        logger.warning(
            f"WebSocket: failed to ack dropped {request_type} for {instance_id}: {e}"
        )


def _frame_metadata(class_counts_by_id: Optional[Dict]) -> Dict:
    """Split the handler's counts blob into the overlay frame's metadata fields."""
    meta = class_counts_by_id or {}
    return {
        "class_names": meta.get("class_names"),
        "class_colors": meta.get("class_colors"),
        "class_counts_by_id": meta.get("class_counts_by_id", {}),
    }


async def _send_overlay_frame(websocket, pack) -> None:
    """Pack + compress in the executor, then send (see overlay_binary).

    A 20k-cell contour frame costs ~30 ms to pack and ~10 ms to compress. Doing
    that inline is 40 ms during which the event loop serves nobody — every other
    viewer shares this process — and pan/zoom sends these back to back.
    """
    payload = await asyncio.get_running_loop().run_in_executor(
        frame_executor, lambda: _compressor().compress(pack())
    )
    await websocket.send_bytes(payload)


def _ws_error(message: str, error_code: str, **extra) -> dict:
    """Backward-compatible WS error with a structured application envelope."""
    payload = {
        "status": "error",
        "code": 403 if error_code.endswith("ACCESS_DENIED") else 400,
        "message": message,
        "error_type": error_code,
        "data": {
            "error_code": error_code,
            "access_mode": extra.pop("access_mode", "forbidden"),
            "operation": extra.pop("operation", "websocket request"),
        },
    }
    payload.update(extra)
    return payload

async def segmentation_endpoint(websocket: WebSocket):
    """
    FastAPI WebSocket endpoint for segmentation with device isolation
    """
    # Authenticate WebSocket connection
    try:
        user: Optional[AuthUser] = await websocket_auth_required(websocket)
    except WebSocketDisconnect:
        return  # Connection closed due to auth failure
    
    # Get device ID from WebSocket
    device_id = get_device_id_from_websocket(websocket)
    if not device_id:
        logger.error("No device ID found in WebSocket connection")
        await websocket.close(code=1008, reason="No device ID provided")
        return
    
    # Connect to device connection manager
    connection_id = await device_connection_manager.connect(websocket, device_id)
    # Binds spawned by this connection; cancelled if it drops so they cannot
    # write to a closed socket.
    pending_binds: Set[asyncio.Task] = set()
    # Instances this connection serves, for the heartbeat keepalive. Scoped to
    # the connection so a viewer that goes away stops counting as present.
    live_instances: Set[str] = set()

    try:
        # Keep connection alive and handle incoming messages
        while True:
            try:
                data = await websocket.receive_text()
                if data == "ping":
                    await websocket.send_text("pong")
                    _keep_instances_alive(live_instances)
                    await device_connection_manager.update_connection_health(device_id, connection_id)
                elif data == "get_status":
                    # Send connection status
                    status = {
                        "status": "connected",
                        "device_id": device_id,
                        "connection_id": connection_id,
                        "total_connections": device_connection_manager.get_total_connection_count()
                    }
                    await websocket.send_text(json.dumps(status))
                    await device_connection_manager.update_connection_health(device_id, connection_id)
                else:
                    # Handle segmentation messages
                    try:
                        parsed_data = json.loads(data)

                        # Token refresh: the renderer re-sends its token when it
                        # rotates. The open edition has no tokens; acknowledge so
                        # the client keeps the same connection.
                        if parsed_data.get("type") == "token_refresh":
                            await websocket.send_text(json.dumps({
                                "type": "token_refresh_success",
                                "message": "Token refreshed successfully"
                            }))
                            continue

                        # One connection multiplexes every open viewer, so awaiting a
                        # bind here made all of them queue behind a zarr open. Binds
                        # run as background tasks (serialized per instance); viewport
                        # queries stay inline so replies keep matching the order the
                        # client's contour FIFO expects.
                        is_path_bind = ("path" in parsed_data) or (
                            parsed_data.get("type") == "set_path"
                        )
                        msg_instance = (
                            parsed_data.get("instance_id")
                            or parsed_data.get("instanceId")
                            or ""
                        )
                        if msg_instance:
                            live_instances.add(msg_instance)
                        if is_path_bind:
                            bind_task = spawn_bind(
                                websocket, device_id, connection_id, parsed_data, user
                            )
                            # None when the request duplicated an in-flight bind.
                            if bind_task is not None:
                                pending_binds.add(bind_task)
                                bind_task.add_done_callback(pending_binds.discard)
                        elif msg_instance and msg_instance in _binds_in_flight:
                            # This viewer is mid-rebind: its handler is being swapped,
                            # so answering now would serve the previous slide. Drop the
                            # request — the client re-syncs once the bind acks.
                            await _send_request_dropped(
                                websocket,
                                parsed_data.get("type"),
                                msg_instance,
                                "bind in progress",
                            )
                        else:
                            # LOAD-BEARING: viewport queries must stay awaited here.
                            # Replies carry no request id, so the client matches each
                            # one to its single in-flight request purely by arrival
                            # order, and its contour cache pairs reply data with the
                            # AABB it queued at send time. Dispatching these as tasks
                            # (as the bind above does) would reorder replies and paint
                            # the wrong cells / settle the wrong request, with no error
                            # anywhere. Add a request id on both sides first.
                            #
                            # Awaited here means the socket is not being read while
                            # the query runs, so heartbeats pile up unread and the
                            # sweeper closes a live connection mid-request.
                            # `handling` says "busy, not dead" (as spawn_bind does).
                            with device_connection_manager.handling(device_id, connection_id):
                                await handle_segmentation_message(
                                    websocket, device_id, parsed_data, user=user
                                )
                    except json.JSONDecodeError:
                        # If not JSON, treat as ping
                        await websocket.send_text("pong")

                    # Update health for any other message
                    await device_connection_manager.update_connection_health(device_id, connection_id)
            except WebSocketDisconnect:
                break
            except Exception as e:
                logger.error(f"WebSocket error for device {device_id}: {str(e)}", exc_info=e)
                break
                
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error(f"Error in WebSocket for device {device_id}: {str(e)}", exc_info=e)
    finally:
        for task in list(pending_binds):
            task.cancel()
        if pending_binds:
            await asyncio.gather(*pending_binds, return_exceptions=True)
            pending_binds.clear()
        if connection_id:
            await device_connection_manager.disconnect(device_id, connection_id)


async def handle_segmentation_message(
    websocket: WebSocket,
    device_id: str,
    data: dict,
    user: Optional[AuthUser] = None,
):
    """Handle segmentation-specific WebSocket messages.

    ``device_id`` is only used for connection routing/health.
    Segmentation handlers are keyed by ``instance_id`` from the message body.
    """
    instance_id = data.get("instance_id") or data.get("instanceId")
    request_type = data.get("type")
    HANDLER_MESSAGE_TYPES = {
        "set_path", "annotations", "centroids", "patches", "all_annotations",
    }
    # Path updates without type still bind the handler.
    needs_instance = ("path" in data) or (request_type in HANDLER_MESSAGE_TYPES)
    if needs_instance and not instance_id:
        await websocket.send_text(json.dumps({
            "status": "error",
            "message": "instance_id is required for segmentation WebSocket messages",
            "error_type": "MissingInstanceId",
            "type": request_type,
        }))
        return

    if needs_instance:
        try:
            assert_session_owner(instance_id, getattr(user, "uid", "") or "")
        except PermissionError:
            await websocket.send_text(json.dumps(_ws_error(
                "Instance access denied",
                "INSTANCE_OWNER_MISMATCH",
                operation="access segmentation websocket",
                type=request_type,
                instance_id=instance_id,
            )))
            return

    try:
        # handle path updates
        if "path" in data:
            svs_path = data["path"]
            
            if svs_path == '':
                pop_instance_handlers(instance_id)
                await websocket.send_text(json.dumps({
                    "status": "success",
                    "message": "Annotations cleared and handler reset",
                    "instance_id": instance_id,
                }))
                return
            
            # Handle relative path by constructing full path
            # Resolve virtual path aliases first (e.g., 'samples/Data' -> '/data/public')
            resolved_svs_path = resolve_virtual_path(svs_path)
            if not resolved_svs_path:
                logger.error(f"WebSocket: Invalid path alias: {svs_path}")
                await websocket.send_text(json.dumps({
                    "status": "error",
                    "message": f"Invalid path alias: {svs_path}",
                    "error_type": "InvalidPathError",
                    "instance_id": instance_id,
                }))
                return
            # Owning the instance says nothing about the path, which the client
            # picks freely — so bind only to the slide this instance was opened on.
            # Not a second share-ACL run: that one false-negatives on Viewer dest
            # symlinks and .zarr sidecars even where tiles work.
            full_svs_path = resolve_path(resolved_svs_path)
            zarr_path = as_zarr_path(full_svs_path)
            # Compare as .zarr so either half of the pair may be sent. Both sides
            # come from the same client string — the session records what
            # create_instance resolved — so this is an equality check, not an
            # attempt to reconcile different spellings of one slide.
            bound_zarr = as_zarr_path(get_session_file_path(instance_id) or "")
            if not bound_zarr or os.path.realpath(zarr_path) != os.path.realpath(bound_zarr):
                logger.warning(
                    "WebSocket: path %s does not match instance %s", svs_path, instance_id
                )
                await websocket.send_text(json.dumps(_ws_error(
                    "Path does not belong to this instance",
                    "INSTANCE_PATH_MISMATCH",
                    operation="bind segmentation path",
                    type=request_type,
                    instance_id=instance_id,
                )))
                return

            # Check for Zarr file (follow directory symlinks; do not use os.access)
            file_path = None
            if is_zarr_store_path(zarr_path):
                file_path = zarr_path
            else:
                logger.warning(f"WebSocket: No zarr file found at: {zarr_path}")
                pop_instance_handlers(instance_id)
                await websocket.send_text(json.dumps({
                    "status": "error",
                    "message": f"No zarr file found. Please check the path or upload the file.",
                    "error_type": "FileNotFoundError",
                    "instance_id": instance_id,
                }))
                return

            if file_path:
                try:
                    existing_handler = get_annotation_handler(instance_id)
                    if existing_handler is not None and SegmentationHandler._same_zarr_path(
                        getattr(existing_handler, 'zarr_file', None), file_path
                    ):
                        existing_handler._needs_reload = True
                        existing_handler._force_reload_centroids = True
                        try:
                            # Heavy zarr reload must not block the asyncio loop.
                            def _force_reload_handler() -> None:
                                existing_handler.load_file(
                                    file_path,
                                    force_reload=True,
                                    reload_segmentation_data=True,
                                )
                                existing_handler._needs_reload = False

                            await asyncio.get_running_loop().run_in_executor(
                                slide_metadata_executor, _force_reload_handler
                            )
                            touch_annotation_handler(instance_id)
                        except Exception as e:
                            logger.error(f"WebSocket: Failed to reload handler: {e}", exc_info=e)
                            existing_handler = None

                    if existing_handler is None or not SegmentationHandler._same_zarr_path(
                        getattr(existing_handler, 'zarr_file', None), file_path
                    ):
                        # Probing the store and binding the handler both open the
                        # zarr, which is filesystem-bound and can take seconds on a
                        # large or remote slide. Run it off the event loop: inline it
                        # froze the whole process — every viewer's socket and the tile
                        # HTTP endpoints — once for each slide being opened.
                        # (The force-reload branch above already does this.)
                        def _bind_handler() -> None:
                            if not is_zarr_store_path(file_path):
                                raise FileNotFoundError(f"Zarr file not found: {file_path}")

                            zarr_indicators = ['zarr.json', '.zarray', '.zgroup', '.zattrs']
                            probe_root = file_path
                            try:
                                if not os.path.isdir(file_path) and os.path.lexists(file_path):
                                    probe_root = os.path.realpath(file_path)
                            except OSError:
                                probe_root = file_path
                            has_zarr_indicators = any(
                                os.path.exists(os.path.join(probe_root, indicator)) for indicator in zarr_indicators
                            )
                            if not has_zarr_indicators:
                                try:
                                    from app.config.zarr_compat import open_zarr
                                    open_zarr(file_path, 'r')
                                except Exception:
                                    raise ValueError(f"File does not appear to be a valid Zarr file: {file_path}")

                            # Drop previous handler, then bind via registry.
                            pop_instance_handlers(instance_id)
                            # need_centroids=True: binding without it read the
                            # store's metadata and stopped, and then the viewer's
                            # first viewport query reopened the same store and
                            # read it all again — 1457 ms of bind followed by
                            # 922 ms of cold load, for one slide's data. One pass
                            # instead of two.
                            #
                            # It does mean a slide whose overlay is never switched
                            # on still pays for its centroids. That work happens on
                            # the bind's own pool, off the event loop and alongside
                            # the tile burst, where it costs the user nothing.
                            get_or_create_annotation_handler(
                                instance_id, file_path, need_centroids=True
                            )

                        # Dedicated pool: asyncio's default one serves tile
                        # reads, and a slide switch fills it.
                        await asyncio.get_running_loop().run_in_executor(
                            slide_metadata_executor, _bind_handler
                        )
                    else:
                        set_annotation_handler(instance_id, existing_handler)

                    # Sync session slide path for HTTP APIs that resolve via X-Instance-ID.
                    try:
                        from app.services.load import sessions, session_lock
                        with session_lock:
                            if instance_id in sessions:
                                # Prefer canonical zarr path so HTTP/session match handler.zarr_file.
                                sessions[instance_id]["current_file_path"] = file_path
                    except Exception as e:
                        logger.warning(
                            f"WebSocket: Failed to sync session path for instance {instance_id}: {e}"
                        )

                    stored_handler = get_annotation_handler(instance_id)
                    request_type = data.get("type")
                    if request_type == "set_path" and stored_handler:
                        await websocket.send_text(json.dumps({
                            "type": "set_path",
                            "status": "success",
                            "message": "Path set successfully",
                            "path": data.get("path", ""),
                            "instance_id": instance_id,
                            "data_available": True,
                        }))

                except Exception as e:
                    logger.error(f"WebSocket: Failed to create SegmentationHandler for {file_path}: {e}", exc_info=e)
                    pop_instance_handlers(instance_id)
                    await websocket.send_text(json.dumps({
                        "status": "error",
                        "message": f"Failed to load segmentation data: {str(e)}",
                        "error_type": type(e).__name__,
                        "instance_id": instance_id,
                    }))
                    return

            # If this was a set_path request, don't process as viewport request
            if data.get("type") == "set_path" and "path" in data:
                return

        # handle viewport update requests
        annotation_handler = get_annotation_handler(instance_id)
        if not annotation_handler:
            request_type = data.get("type", "unknown")
            logger.warning(
                f"WebSocket: No annotation handler for instance {instance_id}, request type: {request_type}"
            )

            # Check if this is a user-initiated request that should show error
            if request_type in ['centroids', 'patches', 'annotations', 'all_annotations']:
                error_response = {
                    "status": "error",
                    "message": "No Zarr file loaded or segmentation data not available. Please reconnect or reload the file.",
                    "error_type": "NoDataError",
                    "suggestion": "Please send a 'path' message to reload the Zarr file",
                    "instance_id": instance_id,
                }
                await websocket.send_text(json.dumps(error_response))
                return
            else:
                return
        
        # No cache system - direct file loading only

        # Process viewport requests
        x1, y1, x2, y2 = data.get("x1"), data.get("y1"), data.get("x2"), data.get("y2")
        request_type = data.get("type")

        if request_type == "annotations":
            use_classification = data.get("use_classification", True)

            annotations, class_counts_by_id = await asyncio.get_running_loop().run_in_executor(
                executor,
                annotation_handler.get_annotations_in_viewport,
                x1, y1, x2, y2, use_classification, True, True  # simplified, as_arrays
            )

            if _viewport_handler_replaced(instance_id, annotation_handler):
                logger.info("WebSocket: dropping stale annotations result after path switch")
                await _send_request_dropped(
                    websocket, request_type, instance_id, "handler replaced after path switch"
                )
                return

            if len(annotations) and len(annotations[0]):
                try:
                    await _send_overlay_frame(
                        websocket,
                        lambda: pack_contours_frame(
                            instance_id,
                            KIND_ANNOTATIONS,
                            *annotations,
                            **_frame_metadata(class_counts_by_id),
                        ),
                    )
                except Exception as e:
                    logger.error(f"WebSocket: Error sending annotations: {str(e)}", exc_info=e)
                    traceback.print_exc()
                    await _send_request_dropped(
                        websocket, request_type, instance_id, f"send failed: {e}"
                    )
            else:
                # Empty viewport is normal — always ack so the client can settle Space pending.
                await websocket.send_text(json.dumps({
                    "type": "annotations",
                    "annotations": [],
                    "instance_id": instance_id,
                }))

        elif request_type == "centroids":
            points, class_counts_by_id = await asyncio.get_running_loop().run_in_executor(
                executor,
                annotation_handler.get_centroids_in_viewport,
                x1, y1, x2, y2
            )

            if _viewport_handler_replaced(instance_id, annotation_handler):
                logger.info("WebSocket: dropping stale centroids result after path switch")
                await _send_request_dropped(
                    websocket, request_type, instance_id, "handler replaced after path switch"
                )
                return

            # Centroids always ack, even when empty — the client settles on the frame.
            await _send_overlay_frame(
                websocket,
                lambda: pack_centroids_frame(
                    instance_id,
                    points,
                    **_frame_metadata(class_counts_by_id),
                ),
            )

        elif request_type == "patches":
            patches, class_counts_by_id = await asyncio.get_running_loop().run_in_executor(
                executor,
                annotation_handler.get_patch_centroids_in_viewport,
                x1, y1, x2, y2
            )
            if _viewport_handler_replaced(instance_id, annotation_handler):
                logger.info("WebSocket: dropping stale patches result after path switch")
                await _send_request_dropped(
                    websocket, request_type, instance_id, "handler replaced after path switch"
                )
                return
            if len(patches) > 0:
                try:
                    payload = {
                        "type": "patches",
                        "patches": patches,
                        **class_counts_by_id,
                        "instance_id": instance_id,
                    }
                    # Serialized on the event loop, and it is not free: 25 ms for
                    # 20k patches. A thread would not help — a Python-level
                    # serializer holds the GIL, so the loop stalls either way
                    # (measured 43 ms inline vs 44 ms in a thread). If this ever
                    # matters, the fix is to stop sending patches as JSON and pack
                    # them like centroids/contours, where numpy releases the GIL.
                    json_str = json.dumps(payload, default=str)
                    json_bytes = json_str.encode('utf-8')
                    if len(json_bytes) > 1024:
                        await websocket.send_bytes(_compressor().compress(json_bytes))
                    else:
                        await websocket.send_text(json_str)
                except Exception as e:
                    logger.error(f"WebSocket: Error sending patches: {str(e)}", exc_info=e)
                    traceback.print_exc()
                    await _send_request_dropped(
                        websocket, request_type, instance_id, f"send failed: {e}"
                    )
            else:
                # Empty viewport is normal — always ack so pending Space/X can settle.
                await websocket.send_text(json.dumps({
                    "type": "patches",
                    "patches": [],
                    "instance_id": instance_id,
                }))

        elif request_type == "all_annotations":
            use_classification = data.get("use_classification", True)

            # Add timeout and progress logging
            get_start = time.time()
            try:
                annotations, class_counts_by_id = await asyncio.wait_for(
                    asyncio.get_running_loop().run_in_executor(
                        executor,
                        annotation_handler.get_annotations_in_viewport,
                        x1, y1, x2, y2, use_classification, True, True  # simplified, as_arrays
                    ),
                    timeout=30.0  # 30 second timeout
                )
                get_time = time.time() - get_start
                n_cells = len(annotations[0]) if len(annotations) else 0
                logger.info(
                    f"WebSocket: all_annotations cells={n_cells} get_ms={get_time * 1000:.1f}"
                )
            except asyncio.TimeoutError:
                logger.error(f"WebSocket: get_annotations_in_viewport timed out after 30 seconds", exc_info=True)
                await websocket.send_text(json.dumps({
                    "status": "error",
                    "message": "Timeout getting annotations data",
                    "error_type": "TimeoutError",
                    "type": request_type,
                    "instance_id": instance_id,
                }))
                return
            except Exception as e:
                logger.error(f"WebSocket: Error in get_annotations_in_viewport: {e}", exc_info=e)
                logger.error(f"Traceback: {traceback.format_exc()}")
                await websocket.send_text(json.dumps({
                    "status": "error",
                    "message": f"Error getting annotations: {str(e)}",
                    "error_type": type(e).__name__,
                    "type": request_type,
                    "instance_id": instance_id,
                }))
                return

            if _viewport_handler_replaced(instance_id, annotation_handler):
                logger.info("WebSocket: dropping stale all_annotations result after path switch")
                await _send_request_dropped(
                    websocket, request_type, instance_id, "handler replaced after path switch"
                )
                return

            if n_cells:
                try:
                    await _send_overlay_frame(
                        websocket,
                        lambda: pack_contours_frame(
                            instance_id,
                            KIND_ALL_ANNOTATIONS,
                            *annotations,
                            **_frame_metadata(class_counts_by_id),
                        ),
                    )
                except Exception as e:
                    logger.error(f"WebSocket: Error sending all_annotations: {str(e)}", exc_info=e)
                    traceback.print_exc()
                    await _send_request_dropped(
                        websocket, request_type, instance_id, f"send failed: {e}"
                    )
            else:
                # Empty viewport is normal — always ack so the client can settle Space pending.
                await websocket.send_text(json.dumps({
                    "type": "all_annotations",
                    "all_annotations": [],
                    "instance_id": instance_id,
                }))
        elif request_type == "set_path":
            # set_path without a path body: report whether this instance already has a handler.
            annotation_handler = get_annotation_handler(instance_id)
            if annotation_handler:
                try:
                    await websocket.send_text(json.dumps({
                        "type": "set_path",
                        "status": "success",
                        "message": "Path already set",
                        "path": getattr(annotation_handler, 'zarr_file', data.get("path", "")),
                        "instance_id": instance_id,
                    }))
                except Exception as e:
                    logger.error(f"WebSocket: Error sending set_path confirmation: {str(e)}", exc_info=e)
            else:
                logger.warning(f"WebSocket: set_path request - no handler for instance {instance_id}")
                await websocket.send_text(json.dumps({
                    "type": "set_path",
                    "status": "error",
                    "message": "No segmentation data loaded",
                    "path": data.get("path", ""),
                    "instance_id": instance_id,
                }))
        else:
            logger.warning(f"WebSocket: Unknown request type: {request_type}")

    except Exception as e:
        error_msg = f"Error processing segmentation message: {str(e)}"
        logger.error(f"WebSocket: {error_msg}", exc_info=e)
        traceback.print_exc()
        try:
            await websocket.send_text(json.dumps({
                "status": "error",
                "error": error_msg,
                "message": error_msg,
                "error_type": type(e).__name__,
                "type": data.get("type"),
                "path": data.get("path"),
                "instance_id": data.get("instance_id") or data.get("instanceId"),
                "viewport": {"x1": data.get("x1"), "y1": data.get("y1"),
                             "x2": data.get("x2"), "y2": data.get("y2")}
            }))
        except Exception as send_error:
            logger.error(f"WebSocket: Failed to send error message: {str(send_error)}", exc_info=send_error)
