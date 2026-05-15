"""
TaskNode Auto-Activation Service

Handles automatic activation of TaskNodes on service startup with race-condition-free
port allocation using socket-held reservations.
"""
import os
import logging
import asyncio
import traceback
import socket
import requests
from typing import List, Tuple, Dict, Any, Optional
from urllib.parse import urlparse
from app.core.settings import settings

logger = logging.getLogger(__name__)

AUTO_ACTIVATE_TASKNODES = os.getenv("AUTO_ACTIVATE_TASKNODES", "true").lower() == "true"


class PortReservation:
    """
    Manages port reservations by holding sockets bound until release.
    Prevents race conditions by ensuring ports cannot be claimed by external
    processes between reservation and subprocess binding.
    """
    
    def __init__(self):
        self.reservations: List[Tuple[int, socket.socket]] = []
    
    def reserve(self, count: int, start_port: int = 8001) -> List[int]:
        """Reserve N ports by binding sockets (held until explicit release)."""
        current_port = start_port
        max_port = start_port + 1000
        
        while len(self.reservations) < count and current_port < max_port:
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(("0.0.0.0", current_port))
                self.reservations.append((current_port, s))
                logger.debug(f"[PORT] Reserved port {current_port}")
            except OSError:
                pass
            current_port += 1
        
        if len(self.reservations) < count:
            self.release_all()
            raise RuntimeError(
                f"Could not reserve {count} ports (scanned {start_port}-{current_port})"
            )
        
        return [port for port, _ in self.reservations]
    
    def release_port(self, port: int) -> None:
        """Release a specific port for subprocess binding."""
        for i, (p, s) in enumerate(self.reservations):
            if p == port:
                try:
                    s.close()
                except Exception:
                    pass
                self.reservations.pop(i)
                logger.debug(f"[PORT] Released port {port}")
                return
    
    def release_all(self) -> None:
        """Release all held ports."""
        for _, s in self.reservations:
            try:
                s.close()
            except Exception:
                pass
        self.reservations.clear()
    
    def get_ports(self) -> List[int]:
        """Get list of currently reserved ports."""
        return [port for port, _ in self.reservations]


def _has_complete_runtime_config(runtime: Dict) -> bool:
    """Check if runtime config has required fields for activation."""
    return bool(
        runtime and 
        runtime.get("service_path") and 
        runtime.get("dependency_path") and
        runtime.get("python_version")
    )


def _is_remote_node(runtime: Dict) -> bool:
    """Check if node is a remote node (should not be auto-activated locally).
    Uses the explicit is_remote flag set by the frontend."""
    return runtime.get("is_remote") is True


def _filter_activatable_nodes(nodes: Dict[str, Any]) -> List[Tuple[str, Dict, Dict]]:
    """Filter nodes that have complete runtime configuration and are local nodes."""
    activatable = []
    for name, info in nodes.items():
        runtime = info.get("runtime", {})
        
        # Skip remote nodes - they should be already running and only need connection
        if _is_remote_node(runtime):
            logger.info(f"[SKIP] {name}: Remote node (host: {runtime.get('remote_host')}), skipping auto-activation")
            continue

        # Local auto-activation requires a valid local service_path.
        service_path = runtime.get("service_path")
        if not isinstance(service_path, str) or not service_path.strip():
            logger.debug(f"[SKIP] {name}: Missing service_path")
            continue
        if not os.path.isfile(service_path):
            logger.warning(f"[SKIP] {name}: service_path is missing or not a file: {service_path}")
            continue
        
        if _has_complete_runtime_config(runtime):
            activatable.append((name, info, runtime))
            logger.info(f"[OK] {name}: Ready for activation")
        else:
            logger.debug(f"[SKIP] {name}: No runtime config")
    return activatable


def _filter_remote_nodes(nodes: Dict[str, Any]) -> List[Tuple[str, Dict, Dict]]:
    """Filter remote nodes that should be auto-connected on startup."""
    remote_nodes = []
    for name, info in nodes.items():
        runtime = info.get("runtime", {})
        
        # Only include remote nodes with port configured
        if _is_remote_node(runtime) and runtime.get("port"):
            remote_nodes.append((name, info, runtime))
            logger.info(f"[REMOTE] {name}: Remote node (host: {runtime.get('remote_host')}, port: {runtime.get('port')}), will attempt auto-connect")
    return remote_nodes


async def _activate_nodes(activatable_nodes: List[Tuple[str, Dict, Dict]]) -> int:
    """
    Activate nodes concurrently with race-condition-free port allocation.
    
    Phase 1: Reserve all needed ports (sockets held)
    Phase 2: Release each port immediately before its subprocess starts
    """
    from app.services.tasks_service import register_custom_node_endpoint

    if not activatable_nodes:
        return 0

    # Phase 1: Reserve ports
    nodes_needing_ports = [
        (name, info, runtime) 
        for name, info, runtime in activatable_nodes 
        if not runtime.get("port")
    ]
    
    port_assignments: Dict[str, int] = {}
    port_reservation = PortReservation()
    
    if nodes_needing_ports:
        try:
            logger.info(f"[PORT] Reserving {len(nodes_needing_ports)} ports...")
            reserved_ports = port_reservation.reserve(len(nodes_needing_ports))
            for (name, _, _), port in zip(nodes_needing_ports, reserved_ports):
                port_assignments[name] = port
            logger.info(f"[PORT] Assignments: {port_assignments}")
        except RuntimeError as e:
            logger.error(f"[ERROR] Port reservation failed: {e}")
            return 0

    # Phase 2: Activate nodes
    async def activate_node(
        node_name: str, 
        node_info: Dict, 
        runtime: Dict,
        assigned_port: Optional[int]
    ) -> bool:
        try:
            port = assigned_port or runtime.get("port")
            logger.info(f"[START] {node_name} on port {port}")

            def do_register():
                if assigned_port is not None:
                    port_reservation.release_port(assigned_port)
                
                return register_custom_node_endpoint(
                    model_name=node_name,
                    python_version=runtime.get("python_version", "3.8"),
                    service_path=runtime.get("service_path"),
                    dependency_path=runtime.get("dependency_path"),
                    factory=node_info.get("factory") or node_info.get("factory_name") or "",
                    description=node_info.get("description"),
                    port=port,
                    env_name=runtime.get("env_name"),
                    install_dependencies=False,
                    io_specs=None,
                    log_path=None,
                    is_remote=runtime.get("is_remote", False),
                    remote_host=runtime.get("remote_host"),
                    mnt_path=runtime.get("mnt_path"),
                )

            result = await asyncio.to_thread(do_register)

            success = isinstance(result, dict) and (
                result.get("status") == "success" or result.get("code") == 0
            )
            
            if success:
                actual_port = result.get("port") or result.get("data", {}).get("port") or port
                logger.info(f"[OK] {node_name}: port {actual_port}")
                return True
            else:
                logger.error(f"[FAIL] {node_name}: {result}")
                return False

        except Exception as e:
            logger.error(f"[ERROR] {node_name}: {e}")
            return False

    try:
        tasks = [
            activate_node(name, info, runtime, port_assignments.get(name))
            for name, info, runtime in activatable_nodes
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        return sum(1 for r in results if r is True)
    finally:
        port_reservation.release_all()


async def _connect_remote_nodes(remote_nodes: List[Tuple[str, Dict, Dict]]) -> int:
    """
    Attempt to connect to remote nodes by registering them (health check will be performed).
    This will automatically connect to remote nodes that are already running.
    """
    from app.services.register_service import register_custom_node
    
    if not remote_nodes:
        return 0
    
    async def connect_remote_node(
        node_name: str,
        node_info: Dict,
        runtime: Dict
    ) -> bool:
        try:
            remote_host = runtime.get("remote_host")
            port = runtime.get("port")
            
            if not remote_host or not port:
                logger.warning(f"[REMOTE] {node_name}: Missing remote_host or port, skipping")
                return False
            
            logger.info(f"[REMOTE] Attempting to connect to {node_name} at {remote_host}:{port}...")
            
            def do_register():
                return register_custom_node(
                    model_name=node_name,
                    python_version=runtime.get("python_version", "3.8"),
                    service_path=runtime.get("service_path", ""),
                    dependency_path=runtime.get("dependency_path", ""),
                    port=port,
                    env_name=runtime.get("env_name"),
                    install_dependencies=False,
                    log_path=None,
                    is_remote=True,
                    remote_host=remote_host,
                    mnt_path=runtime.get("mnt_path"),
                )
            
            result = await asyncio.to_thread(do_register)
            
            success = isinstance(result, dict) and result.get("status") == "success"
            
            if success:
                logger.info(f"[REMOTE] {node_name}: Successfully connected to {remote_host}:{port}")
                
                # Add to TaskNodeManager
                try:
                    from app.services.tasks_service import manager
                    if node_name not in manager.nodes:
                        from app.services.tasks_service import CustomNodeWrapper
                        node_obj = CustomNodeWrapper(name=node_name, port=port, remote_host=remote_host)
                        manager.add_node(node_obj)
                        logger.info(f"[REMOTE] {node_name}: Added to TaskNodeManager")
                    else:
                        logger.info(f"[REMOTE] {node_name}: Already in TaskNodeManager")
                except Exception as e:
                    logger.error(f"[REMOTE] {node_name}: Failed to add to TaskNodeManager: {e}")
                
                return True
            else:
                error_msg = result.get("message", "Unknown error")
                logger.warning(f"[REMOTE] {node_name}: Connection failed: {error_msg}")
                return False
                
        except Exception as e:
            logger.error(f"[REMOTE] {node_name}: Error during connection: {e}")
            return False
    
    try:
        tasks = [
            connect_remote_node(name, info, runtime)
            for name, info, runtime in remote_nodes
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        return sum(1 for r in results if r is True)
    except Exception as e:
        logger.error(f"[REMOTE] Error connecting remote nodes: {e}")
        return 0


async def _fetch_remote_group_nodes() -> List[Tuple[str, Dict, Dict]]:
    """Fetch task nodes from remote TaskNodeManager for the current group."""
    if not settings.TASKNODE_MANAGER_URL:
        return []
    
    try:
        url = f"{settings.TASKNODE_MANAGER_URL.rstrip('/')}/api/tasknodes"
        params = {"groupId": settings.BACKEND_INSTANCE_ID}
        logger.info(f"[AUTO] Fetching remote group nodes from {url} with groupId={settings.BACKEND_INSTANCE_ID}...")
        
        def do_fetch():
            return requests.get(url, params=params, timeout=5.0)
            
        response = await asyncio.to_thread(do_fetch)
        if response.status_code != 200:
            logger.error(f"[AUTO] Failed to fetch remote nodes: {response.status_code}")
            return []
        
        nodes_data = response.json()
        remote_group_nodes = []
        
        # Determine the host address from the manager URL
        # TaskNodeManager manages its local nodes, so their host is the manager's IP/hostname
        manager_url = settings.TASKNODE_MANAGER_URL
        if "://" not in manager_url:
            manager_url = f"http://{manager_url}"
        parsed_url = urlparse(manager_url)
        default_host = parsed_url.hostname or "127.0.0.1"

        for node in nodes_data:
            # We assume nodes returned are the ones that SHOULD be connected
            # Even if TaskNodeManager says they are not running yet, we can try to connect
            # or skip them if they are definitely not running.
            if node.get("isRunning") is False:
                 logger.debug(f"[AUTO] Remote node {node.get('modelName')} is NOT running, skipping")
                 continue
                 
            name = node.get("modelName")
            port = node.get("port")
            
            # Mock info and runtime for connect_remote_node
            info = {
                "description": f"Remote node from Group {settings.BACKEND_INSTANCE_ID}"
            }
            runtime = {
                "remote_host": default_host,
                "port": port,
                "env_name": node.get("envName"),
                "gpu_device_id": node.get("gpuDeviceId")
            }
            
            remote_group_nodes.append((name, info, runtime))
            logger.info(f"[AUTO] Found remote group node: {name} at {default_host}:{port}")
            
        return remote_group_nodes
    except Exception as e:
        logger.error(f"[AUTO] Error fetching remote group nodes: {e}")
        return []


async def auto_activate_all_tasknodes() -> bool:
    """Auto-activate all TaskNodes on startup (local nodes) and auto-connect remote nodes."""
    try:
        from app.services.model_store import model_store

        # 1. Fetch remote group nodes from Manager first
        remote_group_nodes = await _fetch_remote_group_nodes()
        # Map for easy lookup: {name: (info, runtime)}
        remote_updates = {name: (info, runtime) for name, info, runtime in remote_group_nodes}

        logger.info("[AUTO] Loading TaskNodes from ModelStore...")
        nodes = model_store.get_nodes_extended()
        
        if not nodes and not remote_group_nodes:
            logger.warning("[AUTO] No TaskNodes found locally or remotely")
            return False

        # 2. Update local nodes with remote ports if they match
        if nodes:
            logger.info(f"[AUTO] Checking {len(nodes)} local nodes for remote overrides...")
            for name, info in nodes.items():
                if name in remote_updates:
                    _, r_runtime = remote_updates[name]
                    if "runtime" not in info:
                        info["runtime"] = {}
                    
                    logger.info(f"[AUTO] Node '{name}' found in both local config and remote manager. Updating port to {r_runtime['port']}")
                    info["runtime"]["port"] = r_runtime["port"]
                    info["runtime"]["remote_host"] = r_runtime["remote_host"]
                    
                    # We remove it from remote_updates so we don't add it as a "new" node later
                    del remote_updates[name]

        # 3. Filter as usual
        activatable = _filter_activatable_nodes(nodes) if nodes else []
        remote_nodes = _filter_remote_nodes(nodes) if nodes else []
        
        # 4. Add remaining remote nodes that were NOT in local config
        for name, (r_info, r_runtime) in remote_updates.items():
            logger.info(f"[AUTO] Adding new remote node '{name}' from TaskNodeManager")
            remote_nodes.append((name, r_info, r_runtime))

        if not activatable and not remote_nodes:
            logger.warning("[AUTO] No activatable or remote TaskNodes")
            return False

        # Activate local nodes and connect remote nodes concurrently
        tasks = []
        if activatable:
            tasks.append(_activate_nodes(activatable))
        if remote_nodes:
            tasks.append(_connect_remote_nodes(remote_nodes))
        
        if not tasks:
            return False
        
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        # Extract results
        local_count = 0
        remote_count = 0
        result_idx = 0
        if activatable:
            local_count = results[result_idx] if not isinstance(results[result_idx], Exception) else 0
            result_idx += 1
        if remote_nodes:
            remote_count = results[result_idx] if not isinstance(results[result_idx], Exception) else 0

        logger.info("=" * 50)
        logger.info(f"[AUTO] Complete: {local_count}/{len(activatable)} local nodes activated, {remote_count}/{len(remote_nodes)} remote nodes connected")
        logger.info("=" * 50)

        return (local_count + remote_count) > 0

    except Exception as e:
        logger.error(f"[AUTO] Error: {e}")
        traceback.print_exc()
        return False


def is_auto_activation_enabled() -> bool:
    """Check if auto-activation is enabled via environment variable."""
    return AUTO_ACTIVATE_TASKNODES


def get_activation_status_message() -> str:
    """Get status message for startup logs."""
    if AUTO_ACTIVATE_TASKNODES:
        return "TaskNode Auto-Activation: ENABLED"
    return "TaskNode Auto-Activation: DISABLED"
