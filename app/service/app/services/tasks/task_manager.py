from collections import defaultdict, deque
import requests
from requests.exceptions import ConnectionError, Timeout, RequestException
import time
from typing import Dict, List, Set, Any
import logging
import os
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# --- Resilient HTTP helpers ---
_HTTP_MAX_RETRIES = 3
_HTTP_RETRY_BASE_DELAY = 1.0  # seconds; exponential backoff: 1s, 2s, 4s


def _request_with_retry(method: str, url: str, max_retries: int = _HTTP_MAX_RETRIES, **kwargs) -> requests.Response:
    """
    Execute an HTTP request with exponential backoff retry.
    Retries only on connection-level errors (ConnectionError, Timeout), not on HTTP 4xx/5xx.
    """
    last_exc = None
    for attempt in range(max_retries):
        try:
            resp = requests.request(method, url, **kwargs)
            resp.raise_for_status()
            return resp
        except (ConnectionError, Timeout) as e:
            last_exc = e
            delay = _HTTP_RETRY_BASE_DELAY * (2 ** attempt)
            logger.warning(f"[HTTP retry] {method.upper()} {url} failed (attempt {attempt + 1}/{max_retries}): {e}. Retrying in {delay:.1f}s...")
            time.sleep(delay)
        except RequestException:
            # Non-retryable HTTP errors (4xx, 5xx) — raise immediately
            raise
    # Exhausted retries
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

    def execute_workflow(self, workflow_id: int, zarr_path: str = None):
        """Execute a specific workflow"""
        if not self.workflows:
            self.detect_workflows()

        if workflow_id not in self.workflows:
            raise ValueError(f"Workflow '{workflow_id}' does not exist.")

        workflow_nodes = self.workflows[workflow_id]
        execution_order = self.topological_sort_workflow(workflow_nodes)
        data_store = {}  # Stores data sent by each node

        logger.info(f"Executing {workflow_id} with order: {execution_order}")

        for node_name in execution_order:
            node = self.nodes[node_name]

            # Check if node service needs to be started
            logger.info(f"[{node_name}] Node type: {type(node)}")
            if hasattr(node, 'start_server'):
                # This is a TaskNode that needs to be started
                logger.info(f"[{node_name}] Starting server as subprocess...")
                node.start_server()
                logger.info(f"[{node_name}] Server start command executed")
            else:
                # This is a CustomNodeWrapper - service should already be running
                logger.info(f"[{node_name}] CustomNodeWrapper detected - service should already be running on port {node.port}")
                # Try to get PID from running_processes if available
                try:
                    from app.services.tasks_service import running_processes
                    if node_name in running_processes:
                        process = running_processes[node_name]
                        if hasattr(process, 'pid'):
                            from app.services.tasks_service import track_tasknode_pid
                            track_tasknode_pid(workflow_id, node_name, process.pid)
                            logger.info(f"[{node_name}] [SUCCESS] Tracking PID {process.pid} from running_processes for workflow {workflow_id}")
                except Exception as e:
                    logger.warning(f"[{node_name}] Could not track PID from running_processes: {e}")

            # Wait for node service to start
            self._wait_for_node(node, timeout=30)
            
            # Track PID for this node - MUST be done before status update
            pid_tracked = False
            try:
                from app.services.tasks_service import track_tasknode_pid
                
                # For TaskNode: Get PID from node.process.pid (should exist after start_server)
                if hasattr(node, 'process') and node.process and hasattr(node.process, 'pid'):
                    pid = node.process.pid
                    track_tasknode_pid(workflow_id, node_name, pid)
                    logger.info(f"[{node_name}] [SUCCESS] Tracking PID {pid} from node.process for workflow {workflow_id}")
                    pid_tracked = True
                # For CustomNodeWrapper: Get PID from running_processes or CUSTOM_NODE_SERVICE_REGISTRY
                elif hasattr(node, 'port'):
                    from app.services.tasks_service import running_processes
                    if node_name in running_processes:
                        process = running_processes[node_name]
                        if hasattr(process, 'pid'):
                            pid = process.pid
                            track_tasknode_pid(workflow_id, node_name, pid)
                            logger.info(f"[{node_name}] [SUCCESS] Tracking PID {pid} from running_processes for workflow {workflow_id}")
                            pid_tracked = True
                        else:
                            logger.warning(f"[{node_name}] Process in running_processes has no PID")
                    else:
                        # Try to get PID from CUSTOM_NODE_SERVICE_REGISTRY
                        try:
                            from app.services.register_service import CUSTOM_NODE_SERVICE_REGISTRY
                            logger.info(f"[{node_name}] Checking CUSTOM_NODE_SERVICE_REGISTRY for PID...")
                            logger.info(f"[{node_name}] Available registry keys: {list(CUSTOM_NODE_SERVICE_REGISTRY.keys())}")
                            
                            # Look for the node in the registry
                            for registry_key, registry_info in CUSTOM_NODE_SERVICE_REGISTRY.items():
                                if registry_info.get("model_name") == node_name:
                                    process = registry_info.get("process")
                                    if process and hasattr(process, 'pid'):
                                        pid = process.pid
                                        track_tasknode_pid(workflow_id, node_name, pid)
                                        logger.info(f"[{node_name}] [SUCCESS] Tracking PID {pid} from CUSTOM_NODE_SERVICE_REGISTRY for workflow {workflow_id}")
                                        pid_tracked = True
                                        break
                                    else:
                                        logger.warning(f"[{node_name}] Process in CUSTOM_NODE_SERVICE_REGISTRY has no PID")
                            
                            if not pid_tracked:
                                logger.warning(f"[{node_name}] Node not found in CUSTOM_NODE_SERVICE_REGISTRY")
                        except Exception as e:
                            logger.warning(f"[{node_name}] Error accessing CUSTOM_NODE_SERVICE_REGISTRY: {e}")
                else:
                    logger.error(f"[{node_name}] [ERROR] No process or PID found")
                    logger.error(f"[{node_name}] Node has process: {hasattr(node, 'process')}")
                    if hasattr(node, 'process'):
                        logger.error(f"[{node_name}] Process object: {node.process}")
                        if node.process:
                            logger.error(f"[{node_name}] Process has pid: {hasattr(node.process, 'pid')}")
            except Exception as e:
                logger.error(f"Failed to track PID for node {node_name}: {e}")
            
            # Update status to running ONLY after PID tracking is attempted
            from app.services.tasks_service import node_execution_status
            node_execution_status[node_name] = 1
            logger.info(f"[{node_name}] Status updated to running (1) - PID tracked: {pid_tracked}")

            # Mark node as executing so health checks are skipped during execution
            try:
                from app.services.register_service import mark_node_executing
                mark_node_executing(node_name)
            except Exception:
                pass

            # Collect data from dependencies
            input_data = {}
            input_data["node_name"] = node_name
            input_data["dependencies"] = node.dependencies

            if zarr_path:
                input_data["zarr_path"] = zarr_path

            execution_success = False
            try:
                # 2) /init (with retry)
                try:
                    base_url = self._get_node_base_url(node_name, node.port)
                    _request_with_retry("post", f"{base_url}/init", timeout=None)
                    logger.info(f"[{node_name}] /init success")
                except Exception as e:
                    logger.error(f"[{node_name}] /init error: {e}")
                    raise

                # 3) /read (with retry)
                try:
                    zarr_group = self.zarr_group_by_node.get(node_name)
                    dep_zarr_groups = {dep: self.zarr_group_by_node.get(dep) for dep in node.dependencies}
                    if zarr_group:
                        input_data["zarr_group"] = zarr_group
                    dep_zarr_groups_clean = {k: v for k, v in dep_zarr_groups.items() if v}
                    if dep_zarr_groups_clean:
                        input_data["dependencies_zarr_groups"] = dep_zarr_groups_clean

                    input_data = self._convert_paths_in_data(input_data, node_name)

                    base_url = self._get_node_base_url(node_name, node.port)
                    _request_with_retry("post", f"{base_url}/read", json=input_data, timeout=None)
                    logger.info(f"[{node_name}] /read success")
                except Exception as e:
                    logger.error(f"[{node_name}] /read error: {e}")
                    raise

                # 4) /execute (NO retry — long-running, retry would cause duplicate work)
                try:
                    base_url = self._get_node_base_url(node_name, node.port)
                    r_exec = requests.post(
                        f"{base_url}/execute",
                        json={},
                        timeout=None
                    )
                    r_exec.raise_for_status()
                    output_json = r_exec.json()
                    data_store[node_name] = output_json.get("output", {})
                    logger.info(f"[{node_name}] /execute success, output saved.")
                    execution_success = True
                except Exception as e:
                    logger.error(f"[{node_name}] /execute error: {e}")
                    raise
            finally:
                # Unmark node as executing so health checks resume
                try:
                    from app.services.register_service import unmark_node_executing
                    unmark_node_executing(node_name)
                except Exception:
                    pass
                # If node execution failed/interrupted, clear running status to avoid stale "running"
                if not execution_success:
                    try:
                        from app.services.tasks_service import node_execution_status
                        if node_execution_status.get(node_name) == 1:
                            node_execution_status[node_name] = 0
                            logger.info(f"[{node_name}] Reset status to not started (0) after failed/interrupted execution")
                    except Exception:
                        pass

        return data_store

    def execute_all_workflows(self):
        """Execute all detected workflows"""
        if not self.workflows:
            self.detect_workflows()

        results = {}
        for workflow_id in self.workflows:
            logger.info(f"Executing workflow: {workflow_id}")
            try:
                results[workflow_id] = self.execute_workflow(workflow_id)
            except Exception as e:
                logger.error(f"Error executing workflow {workflow_id}: {str(e)}")
                results[workflow_id] = {"error": str(e)}

        return results

    def execute_single_node(self, node_name: str, zarr_path: str, dependencies: List[str], workflow_id: int, node_inputs: dict = None) -> dict:
        """
        Execute a single node (extracted from execute_workflow loop body).

        This method executes a single node using the 3-phase HTTP protocol:
        1. /init - Initialize the node
        2. /read - Pass input data and dependencies (including node_inputs so node does not rely on zarr userData)
        3. /execute - Execute the node and return output

        Args:
            node_name: Name of the node to execute
            zarr_path: Path to the zarr file
            dependencies: List of dependency node names
            workflow_id: Workflow ID for PID tracking
            node_inputs: Params for this node (path, patch_size, tissue_classes, etc.); sent in /read so node gets them even if userData was overwritten

        Returns:
            dict: Output from the /execute endpoint

        Raises:
            Exception: If any phase of execution fails
        """
        if node_inputs is None:
            node_inputs = {}
        if node_name not in self.nodes:
            raise ValueError(f"Node '{node_name}' not found in manager")

        node = self.nodes[node_name]

        # Check if node service needs to be started
        logger.info(f"[{node_name}] Node type: {type(node)}")
        if hasattr(node, 'start_server'):
            # This is a TaskNode that needs to be started
            logger.info(f"[{node_name}] Starting server as subprocess...")
            node.start_server()
            logger.info(f"[{node_name}] Server start command executed")
        else:
            # This is a CustomNodeWrapper - service should already be running
            logger.info(f"[{node_name}] CustomNodeWrapper detected - service should already be running on port {node.port}")
            # Try to get PID from running_processes if available
            try:
                from app.services.tasks_service import running_processes
                if node_name in running_processes:
                    process = running_processes[node_name]
                    if hasattr(process, 'pid'):
                        from app.services.tasks_service import track_tasknode_pid
                        track_tasknode_pid(workflow_id, node_name, process.pid)
                        logger.info(f"[{node_name}] [SUCCESS] Tracking PID {process.pid} from running_processes for workflow {workflow_id}")
            except Exception as e:
                logger.warning(f"[{node_name}] Could not track PID from running_processes: {e}")

        # Wait for node service to start
        self._wait_for_node(node, timeout=30)

        # Track PID for this node
        pid_tracked = False
        try:
            from app.services.tasks_service import track_tasknode_pid

            # For TaskNode: Get PID from node.process.pid (should exist after start_server)
            if hasattr(node, 'process') and node.process and hasattr(node.process, 'pid'):
                pid = node.process.pid
                track_tasknode_pid(workflow_id, node_name, pid)
                logger.info(f"[{node_name}] [SUCCESS] Tracking PID {pid} from node.process for workflow {workflow_id}")
                pid_tracked = True
            # For CustomNodeWrapper: Get PID from running_processes or CUSTOM_NODE_SERVICE_REGISTRY
            elif hasattr(node, 'port'):
                from app.services.tasks_service import running_processes
                if node_name in running_processes:
                    process = running_processes[node_name]
                    if hasattr(process, 'pid'):
                        pid = process.pid
                        track_tasknode_pid(workflow_id, node_name, pid)
                        logger.info(f"[{node_name}] [SUCCESS] Tracking PID {pid} from running_processes for workflow {workflow_id}")
                        pid_tracked = True
                    else:
                        logger.warning(f"[{node_name}] Process in running_processes has no PID")
                else:
                    # Try to get PID from CUSTOM_NODE_SERVICE_REGISTRY
                    try:
                        from app.services.register_service import CUSTOM_NODE_SERVICE_REGISTRY
                        logger.info(f"[{node_name}] Checking CUSTOM_NODE_SERVICE_REGISTRY for PID...")
                        logger.info(f"[{node_name}] Available registry keys: {list(CUSTOM_NODE_SERVICE_REGISTRY.keys())}")

                        # Look for the node in the registry
                        for registry_key, registry_info in CUSTOM_NODE_SERVICE_REGISTRY.items():
                            if registry_info.get("model_name") == node_name:
                                process = registry_info.get("process")
                                if process and hasattr(process, 'pid'):
                                    pid = process.pid
                                    track_tasknode_pid(workflow_id, node_name, pid)
                                    logger.info(f"[{node_name}] [SUCCESS] Tracking PID {pid} from CUSTOM_NODE_SERVICE_REGISTRY for workflow {workflow_id}")
                                    pid_tracked = True
                                    break
                                else:
                                    logger.warning(f"[{node_name}] Process in CUSTOM_NODE_SERVICE_REGISTRY has no PID")

                        if not pid_tracked:
                            logger.warning(f"[{node_name}] Node not found in CUSTOM_NODE_SERVICE_REGISTRY")
                    except Exception as e:
                        logger.warning(f"[{node_name}] Error accessing CUSTOM_NODE_SERVICE_REGISTRY: {e}")
            else:
                logger.error(f"[{node_name}] [ERROR] No process or PID found")
                logger.error(f"[{node_name}] Node has process: {hasattr(node, 'process')}")
                if hasattr(node, 'process'):
                    logger.error(f"[{node_name}] Process object: {node.process}")
                    if node.process:
                        logger.error(f"[{node_name}] Process has pid: {hasattr(node.process, 'pid')}")
        except Exception as e:
            logger.error(f"Failed to track PID for node {node_name}: {e}")

        # Update status to running
        from app.services.tasks_service import node_execution_status
        node_execution_status[node_name] = 1
        logger.info(f"[{node_name}] Status updated to running (1) - PID tracked: {pid_tracked}")

        # Mark node as executing so health checks are skipped during execution
        try:
            from app.services.register_service import mark_node_executing
            mark_node_executing(node_name)
        except Exception:
            pass

        # Collect data from dependencies and this node's params (so node does not depend on zarr userData)
        input_data = dict(node_inputs)
        input_data["node_name"] = node_name
        input_data["dependencies"] = dependencies

        if zarr_path:
            input_data["zarr_path"] = zarr_path

        execution_success = False
        try:
            # Phase 1: /init (with retry)
            try:
                base_url = self._get_node_base_url(node_name, node.port)
                _request_with_retry("post", f"{base_url}/init", timeout=None)
                logger.info(f"[{node_name}] /init success")
            except Exception as e:
                logger.error(f"[{node_name}] /init error: {e}")
                raise

            # Phase 2: /read (with retry)
            try:
                zarr_group = self.zarr_group_by_node.get(node_name)
                dep_zarr_groups = {dep: self.zarr_group_by_node.get(dep) for dep in dependencies}
                if zarr_group:
                    input_data["zarr_group"] = zarr_group
                dep_zarr_groups_clean = {k: v for k, v in dep_zarr_groups.items() if v}
                if dep_zarr_groups_clean:
                    input_data["dependencies_zarr_groups"] = dep_zarr_groups_clean

                input_data = self._convert_paths_in_data(input_data, node_name)

                base_url = self._get_node_base_url(node_name, node.port)
                _request_with_retry("post", f"{base_url}/read", json=input_data, timeout=None)
                logger.info(f"[{node_name}] /read success")
            except Exception as e:
                logger.error(f"[{node_name}] /read error: {e}")
                raise

            # Phase 3: /execute (NO retry — long-running, retry would cause duplicate work)
            try:
                base_url = self._get_node_base_url(node_name, node.port)
                r_exec = requests.post(
                    f"{base_url}/execute",
                    json={},
                    timeout=None
                )
                r_exec.raise_for_status()
                output_json = r_exec.json()
                output = output_json.get("output", {})
                logger.info(f"[{node_name}] /execute success, output returned.")
                execution_success = True
                return output
            except Exception as e:
                logger.error(f"[{node_name}] /execute error: {e}")
                raise
        finally:
            # Unmark node as executing so health checks resume
            try:
                from app.services.register_service import unmark_node_executing
                unmark_node_executing(node_name)
            except Exception:
                pass
            # If node execution failed/interrupted, clear running status to avoid stale "running"
            if not execution_success:
                try:
                    from app.services.tasks_service import node_execution_status
                    if node_execution_status.get(node_name) == 1:
                        node_execution_status[node_name] = 0
                        logger.info(f"[{node_name}] Reset status to not started (0) after failed/interrupted execution")
                except Exception:
                    pass

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
            from app.services.register_service import CUSTOM_NODE_SERVICE_REGISTRY
            
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
            from app.config.path_config import STORAGE_ROOT
            
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
                logger.info(f"[_convert_path_for_remote_node] Converted {path} -> {mapped_path}")
                return mapped_path
            else:
                # Path is not under STORAGE_ROOT, might be absolute system path
                # For now, return as-is (could be extended to handle other mappings)
                logger.warning(f"[_convert_path_for_remote_node] Path {path} is not under STORAGE_ROOT {storage_root}, returning as-is")
                return path.replace('\\', '/')  # Still convert to POSIX style
        except Exception as e:
            logger.error(f"[_convert_path_for_remote_node] Error converting path {path}: {e}")
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
        
        logger.info("all workflows and dependencies have been cleared, node instances have been kept")

    def reset_nodes(self):
        """Reset all nodes without removing them"""
        # reset dependencies between nodes, but keep node instances
        self.graph = defaultdict(list)  # reset dependency graph
        self.in_degree = defaultdict(int)  # reset in-degree
        
        # clear dependencies of each node
        for node_name, node in self.nodes.items():
            if hasattr(node, 'dependencies'):
                node.dependencies = []
        
        logger.info("all node dependencies have been reset")

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


