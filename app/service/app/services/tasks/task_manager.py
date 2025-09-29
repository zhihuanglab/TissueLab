from collections import defaultdict, deque
import requests
import time
from typing import Dict, List, Set
import logging
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

class TaskNodeManager:
    def __init__(self):
        self.nodes = {}          # key: node name, value: TaskNode instance
        self.graph = defaultdict(list)  # Dependency graph
        self.in_degree = defaultdict(int)  # In-degree of each node
        self.workflows = {}      # key: workflow ID, value: list of node names
        self.port_counter = 8000  # Starting port number
        self.node_factory = {}
        self.h5_group_by_node: Dict[str, str] = {}

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

    def execute_workflow(self, workflow_id: int, h5_path: str = None):
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
                            logger.info(f"[{node_name}] Tracking PID {process.pid} from running_processes for workflow {workflow_id}")
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
                    logger.info(f"[{node_name}] Tracking PID {pid} from node.process for workflow {workflow_id}")
                    pid_tracked = True
                # For CustomNodeWrapper: Get PID from running_processes or CUSTOM_NODE_SERVICE_REGISTRY
                elif hasattr(node, 'port'):
                    from app.services.tasks_service import running_processes
                    if node_name in running_processes:
                        process = running_processes[node_name]
                        if hasattr(process, 'pid'):
                            pid = process.pid
                            track_tasknode_pid(workflow_id, node_name, pid)
                            logger.info(f"[{node_name}] Tracking PID {pid} from running_processes for workflow {workflow_id}")
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
                                        logger.info(f"[{node_name}] Tracking PID {pid} from CUSTOM_NODE_SERVICE_REGISTRY for workflow {workflow_id}")
                                        pid_tracked = True
                                        break
                                    else:
                                        logger.warning(f"[{node_name}] Process in CUSTOM_NODE_SERVICE_REGISTRY has no PID")
                            
                            if not pid_tracked:
                                logger.warning(f"[{node_name}] Node not found in CUSTOM_NODE_SERVICE_REGISTRY")
                        except Exception as e:
                            logger.warning(f"[{node_name}] Error accessing CUSTOM_NODE_SERVICE_REGISTRY: {e}")
                else:
                    logger.error(f"[{node_name}] No process or PID found")
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

            # Collect data from dependencies
            input_data = {}
            input_data["node_name"] = node_name
            input_data["dependencies"] = node.dependencies

            if h5_path:
                input_data["h5_path"] = h5_path

            # 2) /init
            try:
                r_init = requests.post(f"http://localhost:{node.port}/init", timeout=None)
                r_init.raise_for_status()
                logger.info(f"[{node_name}] /init success")
            except Exception as e:
                logger.error(f"[{node_name}] /init error: {e}")
                raise

            # 3) /read (pass input_data)
            try:
                # Attach h5_group for this node and its dependencies, if available
                h5_group = self.h5_group_by_node.get(node_name)
                dep_h5_groups = {dep: self.h5_group_by_node.get(dep) for dep in node.dependencies}
                if h5_group:
                    input_data["h5_group"] = h5_group
                # Only include dependency groups that are defined
                dep_h5_groups_clean = {k: v for k, v in dep_h5_groups.items() if v}
                if dep_h5_groups_clean:
                    input_data["dependencies_h5_groups"] = dep_h5_groups_clean

                r_read = requests.post(
                    f"http://localhost:{node.port}/read",
                    json=input_data,
                    timeout=None
                )
                r_read.raise_for_status()
                logger.info(f"[{node_name}] /read success")
            except Exception as e:
                logger.error(f"[{node_name}] /read error: {e}")
                raise

            # 4) /execute
            try:
                r_exec = requests.post(
                    f"http://localhost:{node.port}/execute",
                    json={},
                    timeout=None
                )
                r_exec.raise_for_status()
                output_json = r_exec.json()
                data_store[node_name] = output_json.get("output", {})
                logger.info(f"[{node_name}] /execute success, output saved.")
            except Exception as e:
                logger.error(f"[{node_name}] /execute error: {e}")
                raise

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

    def _wait_for_node(self, node, timeout=30):
        """Wait for node service to become available"""
        start_time = time.time()
        while time.time() - start_time < timeout:
            try:
                response = requests.get(f"http://localhost:{node.port}/status")
                if response.status_code == 200:
                    return True
            except:
                time.sleep(1)
        raise TimeoutError(f"Node {node.name} service did not start within {timeout} seconds")

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


