from collections import defaultdict, deque
import asyncio
import logging
import os
import requests
import time
from typing import Any, Dict, List, Optional, Set, Tuple

import aiohttp
from aiohttp import ClientConnectorError, ClientResponseError, ServerTimeoutError

from app.config.path_config import STORAGE_ROOT
from app.utils.workflow.register import (
    CUSTOM_NODE_SERVICE_REGISTRY,
    mark_node_executing,
    unmark_node_executing,
)

logger = logging.getLogger(__name__)

# --- Resilient HTTP helpers ---
_HTTP_MAX_RETRIES = 3
_HTTP_RETRY_BASE_DELAY = 1.0  # seconds; exponential backoff: 1s, 2s, 4s
_AIOHTTP_RETRY_ERRORS = (ClientConnectorError, asyncio.TimeoutError, ServerTimeoutError)


async def _arequest_with_retry(
    session: aiohttp.ClientSession,
    method: str,
    url: str,
    max_retries: int = _HTTP_MAX_RETRIES,
    **kwargs,
) -> Any:
    """
    Async HTTP with exponential backoff on connection errors (not 4xx/5xx).
    Cancelling the awaiting task closes the client connection.
    """
    last_exc = None
    for attempt in range(max_retries):
        try:
            async with session.request(method, url, **kwargs) as resp:
                resp.raise_for_status()
                try:
                    return await resp.json(content_type=None)
                except Exception:
                    return await resp.read()
        except _AIOHTTP_RETRY_ERRORS as e:
            last_exc = e
            delay = _HTTP_RETRY_BASE_DELAY * (2 ** attempt)
            logger.warning(
                f"[HTTP retry] {method.upper()} {url} failed "
                f"(attempt {attempt + 1}/{max_retries}): {e}. Retrying in {delay:.1f}s..."
            )
            await asyncio.sleep(delay)
        except ClientResponseError:
            raise
    raise last_exc  # type: ignore[misc]


class TaskNodeManager:
    def __init__(self):
        self.nodes = {}          # key: node name, value: TaskNode instance
        self.graph = defaultdict(list)  # Dependency graph
        self.in_degree = defaultdict(int)  # In-degree of each node
        self.workflows = {}      # key: workflow ID, value: list of node names
        self.port_counter = 8000  # Starting port number
        self.node_factory = {}
        self.zarr_group_by_node: Dict[str, str] = {}

    def _get_next_port(self) -> int:
        """Get next available port number"""
        self.port_counter += 1
        return self.port_counter

    def add_node(self, node):
        """Add a node and start its service"""
        if node.name in self.nodes:
            raise ValueError(f"Node '{node.name}' already exists.")

        # Assign port if not already assigned
        if node.port is None:
            node.port = self._get_next_port()

        self.nodes[node.name] = node

        if getattr(node, "factory", None):
            self.node_factory[node.name] = node.factory

    def add_dependency(self, from_node: str, to_node: str):
        """Define a dependency between two nodes"""
        if from_node not in self.nodes or to_node not in self.nodes:
            raise ValueError("Both nodes must be added before defining dependencies.")
        self.graph[from_node].append(to_node)
        self.in_degree[to_node] += 1
        self.nodes[to_node].add_dependency(from_node)

    def detect_workflows(self):
        """Detect all distinct workflows by finding all possible paths from source nodes to sink nodes."""
        self.workflows.clear()

        # Find source nodes (nodes with no incoming edges)
        source_nodes = [node for node in self.nodes if self.in_degree[node] == 0]

        # Find sink nodes (nodes with no outgoing edges)
        sink_nodes = [node for node in self.nodes if not self.graph[node]]

        def find_all_paths(current: str, target: str, path: List[str], visited: Set[str]):
            """Helper function to find all paths from source to sink nodes"""
            path = path + [current]
            if current == target:
                workflow_id = len(self.workflows) + 1
                self.workflows[workflow_id] = path
            else:
                for neighbor in self.graph[current]:
                    if neighbor not in visited:
                        find_all_paths(neighbor, target, path, visited | {current})

        # Find all paths from each source to each sink
        for source in source_nodes:
            visited = set()
            for sink in sink_nodes:
                find_all_paths(source, sink, [], visited)

    def topological_sort_workflow(self, workflow_nodes: List[str]) -> List[str]:
        """Perform topological sorting on a subset of nodes representing a workflow."""
        in_degree = {node: 0 for node in workflow_nodes}
        graph = defaultdict(list)

        for node in workflow_nodes:
            for neighbor in self.graph[node]:
                if neighbor in workflow_nodes:
                    graph[node].append(neighbor)
                    in_degree[neighbor] += 1

        queue = deque([node for node in workflow_nodes if in_degree[node] == 0])
        order = []

        while queue:
            current = queue.popleft()
            order.append(current)
            for neighbor in graph[current]:
                in_degree[neighbor] -= 1
                if in_degree[neighbor] == 0:
                    queue.append(neighbor)

        if len(order) != len(workflow_nodes):
            raise ValueError("The workflow has a cycle and cannot be sorted topologically.")

        return order



    def _setup_single_node_execution(
        self,
        node_name: str,
        zarr_path: str,
        dependencies: List[str],
        node_inputs: Optional[dict] = None,
    ) -> Tuple[Any, str, dict]:
        """
        Start/wait/mark node and build /read payload. Sync — may block on health wait.
        Returns (node, base_url, input_data).
        """
        if node_inputs is None:
            node_inputs = {}
        if node_name not in self.nodes:
            raise ValueError(f"Node '{node_name}' not found in manager")

        node = self.nodes[node_name]

        self._wait_for_node(node, timeout=30)

        # Do NOT mark executing here — that must happen on the async side after
        # to_thread returns, so cancel during wait cannot leave a permanent
        # "executing" mark without teardown.

        input_data = dict(node_inputs)
        input_data["node_name"] = node_name
        input_data["dependencies"] = dependencies
        if zarr_path:
            input_data["zarr_path"] = zarr_path

        base_url = self._get_node_base_url(node_name, node.port)
        return node, base_url, input_data

    def _mark_node_execution_started(self, node_name: str) -> None:
        try:
            mark_node_executing(node_name)
        except Exception:
            pass

    def _teardown_single_node_execution(self, node_name: str) -> None:
        try:
            unmark_node_executing(node_name)
        except Exception:
            pass

    def _build_read_payload(
        self,
        node_name: str,
        input_data: dict,
        dependencies: List[str],
    ) -> dict:
        zarr_group = self.zarr_group_by_node.get(node_name)
        dep_zarr_groups = {dep: self.zarr_group_by_node.get(dep) for dep in dependencies}
        if zarr_group:
            input_data["zarr_group"] = zarr_group
        dep_zarr_groups_clean = {k: v for k, v in dep_zarr_groups.items() if v}
        if dep_zarr_groups_clean:
            input_data["dependencies_zarr_groups"] = dep_zarr_groups_clean
        return self._convert_paths_in_data(input_data, node_name)

    async def execute_single_node(
        self,
        node_name: str,
        zarr_path: str,
        dependencies: List[str],
        node_inputs: dict = None,
    ) -> dict:
        """
        Async 3-phase node execution (/init, /read, /execute) via aiohttp.

        Cancelling the awaiting Task closes the client connection so force-finalize
        can release model_lock without waiting on a stuck sync HTTP thread.
        TaskNode may still run until it honors POST /cancel.
        """
        marked = False
        try:
            # Blocking prep (start/wait) off the loop. Mark executing only after
            # this returns so cancel during wait cannot orphan mark/status.
            _node, base_url, input_data = await asyncio.to_thread(
                self._setup_single_node_execution,
                node_name,
                zarr_path,
                dependencies,
                node_inputs,
            )
            self._mark_node_execution_started(node_name)
            marked = True

            timeout = aiohttp.ClientTimeout(total=None, sock_connect=30, sock_read=None)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                try:
                    await _arequest_with_retry(session, "post", f"{base_url}/init")
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.error(f"[{node_name}] /init error: {e}", exc_info=e)
                    raise

                try:
                    read_payload = self._build_read_payload(node_name, input_data, dependencies)
                    await _arequest_with_retry(session, "post", f"{base_url}/read", json=read_payload)
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.error(f"[{node_name}] /read error: {e}", exc_info=e)
                    raise

                # /execute — NO retry; this await is the cancellable long poll.
                try:
                    async with session.post(f"{base_url}/execute", json={}) as r_exec:
                        r_exec.raise_for_status()
                        output_json = await r_exec.json(content_type=None)
                    output_json = output_json or {}
                    # Nodes answer HTTP 200 with {"status": "error", "message": ...}
                    # ("Please /init first", "Zarr path not configured", a caught
                    # exception, ...) and usually no "output" key at all. Returning
                    # the empty output used to make the scheduler mark them completed.
                    if output_json.get("status") == "error":
                        raise RuntimeError(
                            str(output_json.get("message") or f"{node_name} /execute reported an error")
                        )
                    return output_json.get("output", {})
                except asyncio.CancelledError:
                    logger.info(f"[{node_name}] /execute client cancelled")
                    raise
                except Exception as e:
                    logger.error(f"[{node_name}] /execute error: {e}", exc_info=e)
                    raise
        finally:
            if marked:
                self._teardown_single_node_execution(node_name)

    def _wait_for_node(self, node, timeout=60):
        """Wait for node service to become available with exponential backoff."""
        base_url = self._get_node_base_url(node.name, node.port)
        start_time = time.time()
        delay = 0.5
        while time.time() - start_time < timeout:
            try:
                response = requests.get(f"{base_url}/status", timeout=5)
                if response.status_code == 200:
                    return True
            except Exception:
                pass
            time.sleep(min(delay, timeout - (time.time() - start_time)))
            delay = min(delay * 1.5, 5.0)  # Cap backoff at 5s
        raise TimeoutError(f"Node {node.name} service did not start within {timeout} seconds")

    def _is_remote_node(self, node_name: str) -> tuple[bool, str | None, str | None]:
        """
        Check if a node is a remote node and return its remote_host and mnt_path if available.
        
        Args:
            node_name: Name of the node to check
            
        Returns:
            Tuple of (is_remote, remote_host, mnt_path)
            - is_remote: True if node is remote, False otherwise
            - remote_host: remote_host if remote node, None otherwise
            - mnt_path: mnt_path if remote node, None otherwise
        """
        try:
            for registry_key, info in CUSTOM_NODE_SERVICE_REGISTRY.items():
                if info.get("model_name") == node_name:
                    is_remote_flag = info.get("is_remote")
                    remote_host = info.get("remote_host")
                    mnt_path = info.get("mnt_path")
                    
                    # Prefer is_remote.
                    if is_remote_flag is True:
                        return True, remote_host, mnt_path
                    break
        except Exception as e:
            logger.warning(f"[_is_remote_node] Error checking remote node status for {node_name}: {e}")
        
        return False, None, None

    def _get_node_base_url(self, node_name: str, port: int) -> str:
        """
        Get the base URL for a node (localhost for local nodes, remote_host for remote nodes).
        
        Args:
            node_name: Name of the node
            port: Port number of the node
            
        Returns:
            Base URL string (e.g., "http://localhost:8001" or "http://192.168.1.100:8001")
        """
        is_remote, remote_host, _ = self._is_remote_node(node_name)
        
        if is_remote and remote_host:
            return f"http://{remote_host}:{port}"
        else:
            return f"http://localhost:{port}"

    def _convert_path_for_remote_node(self, path: str, mnt_path: str) -> str:
        """
        Convert a path from ctrl-service path to mnt_path-based path for remote tasknode.
        
        Args:
            path: Absolute path on ctrl-service (e.g., /path/to/storage/uploads/file.zarr)
            mnt_path: Mount path on remote server (e.g., /mnt/remote)
            
        Returns:
            Path converted to mnt_path-based path (e.g., /mnt/remote/file.zarr)
            Always returns POSIX-style path (forward slashes) for remote nodes
        """
        if not path or not mnt_path:
            return path
        
        try:
            # Normalize paths and convert to POSIX style (forward slashes)
            # This ensures compatibility with Linux-based remote tasknodes
            path = os.path.normpath(path).replace('\\', '/')
            mnt_path = os.path.normpath(mnt_path).replace('\\', '/')
            storage_root = os.path.normpath(STORAGE_ROOT).replace('\\', '/')
            
            # If path is under STORAGE_ROOT, extract relative path and map to mnt_path
            if path.startswith(storage_root):
                # Get relative path from STORAGE_ROOT
                relative_path = os.path.relpath(path, storage_root).replace('\\', '/')
                # Map to mnt_path (ensure mnt_path ends with / for proper joining)
                if mnt_path.endswith('/'):
                    mapped_path = f"{mnt_path}{relative_path}"
                else:
                    mapped_path = f"{mnt_path}/{relative_path}"
                return mapped_path
            else:
                # Path is not under STORAGE_ROOT, might be absolute system path
                # For now, return as-is (could be extended to handle other mappings)
                logger.warning(f"[_convert_path_for_remote_node] Path {path} is not under STORAGE_ROOT {storage_root}, returning as-is")
                return path.replace('\\', '/')  # Still convert to POSIX style
        except Exception as e:
            logger.error(f"[_convert_path_for_remote_node] Error converting path {path}: {e}", exc_info=e)
            return path.replace('\\', '/') if path else path

    def _convert_paths_in_data(self, data: Any, node_name: str) -> Any:
        """
        Recursively convert all path fields in data for remote nodes.
        
        Args:
            data: Data structure (dict, list, or primitive) that may contain paths
            node_name: Name of the node to check if remote
            
        Returns:
            Data structure with paths converted if node is remote
        """
        # Check if node is remote
        is_remote, _, mnt_path = self._is_remote_node(node_name)
        
        if not is_remote or not mnt_path:
            # Not a remote node or no mnt_path, return as-is
            return data
        
        # Path fields that need conversion
        path_fields = ["zarr_path", "file_path", "path", "classifier_path", "save_classifier_path"]
        
        if isinstance(data, dict):
            converted = {}
            for key, value in data.items():
                if key in path_fields and isinstance(value, str):
                    # Convert path
                    converted[key] = self._convert_path_for_remote_node(value, mnt_path)
                else:
                    # Recursively process nested structures
                    converted[key] = self._convert_paths_in_data(value, node_name)
            return converted
        elif isinstance(data, list):
            return [self._convert_paths_in_data(item, node_name) for item in data]
        else:
            # Primitive type, return as-is
            return data

    def cleanup(self):
        """Cleanup all node processes"""
        for node in self.nodes.values():
            node.cleanup()

    def list_workflows(self):
        """List all detected workflows"""
        if not self.workflows:
            self.detect_workflows()
        return list(self.workflows.keys())
        
    def remove_workflow(self, workflow_id: int):
        """Remove a workflow from the manager"""
        if workflow_id in self.workflows:
            del self.workflows[workflow_id]
        else:
            raise ValueError(f"Workflow '{workflow_id}' does not exist.")

    def clear_workflows(self):
        """clear all workflows and dependencies, but keep node instances"""
        # clear workflows dictionary
        self.workflows.clear()
        
        # reset dependencies, but keep node instances
        self.reset_nodes()

    def reset_nodes(self):
        """Reset all nodes without removing them"""
        # reset dependencies between nodes, but keep node instances
        self.graph = defaultdict(list)  # reset dependency graph
        self.in_degree = defaultdict(int)  # reset in-degree
        
        # clear dependencies of each node
        for node_name, node in self.nodes.items():
            if hasattr(node, 'dependencies'):
                node.dependencies = []

    def remove_node(self, node_name: str):
        """remove a node and its all dependencies from the manager
        
        Args:
            node_name: the name of the node to remove
        """
        if node_name not in self.nodes:
            raise ValueError(f"Node '{node_name}' does not exist.")
        
        # try to clean up node resources
        try:
            node = self.nodes[node_name]
            if hasattr(node, 'cleanup') and callable(getattr(node, 'cleanup')):
                node.cleanup()
        except Exception as e:
            logger.warning(f"Error cleaning up node {node_name}: {e}")
        
        # delete node from nodes dictionary
        del self.nodes[node_name]
        
        # delete node from dependency graph
        if node_name in self.graph:
            del self.graph[node_name]
        
        # delete node from in-degree dictionary
        if node_name in self.in_degree:
            del self.in_degree[node_name]
        
        # delete node from dependencies of other nodes
        for other_node_deps in self.graph.values():
            if node_name in other_node_deps:
                other_node_deps.remove(node_name)
        
        # delete node from node_factory dictionary
        if node_name in self.node_factory:
            del self.node_factory[node_name]


