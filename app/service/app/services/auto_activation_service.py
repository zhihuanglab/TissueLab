"""
TaskNode Auto-Activation Service
This service handles the automatic activation of all TaskNodes on service startup.
"""
import os
import logging
import asyncio
import traceback
from typing import List, Tuple, Dict, Any

logger = logging.getLogger(__name__)

# Configuration
AUTO_ACTIVATE_TASKNODES = os.getenv("AUTO_ACTIVATE_TASKNODES", "true").lower() == "true"

async def auto_activate_all_tasknodes() -> bool:
    """
    Auto-activate all TaskNodes on startup
    
    Returns:
        bool: True if activation was successful, False otherwise
    """
    try:
        from app.services.model_store import model_store
        from app.services.register_service import register_custom_node

        logger.info("🔍 Loading available TaskNodes from ModelStore...")

        # Get all nodes from model store
        nodes = model_store.get_nodes_extended()
        if not nodes:
            logger.warning("No TaskNodes found in ModelStore")
            return False

        logger.info(f"Found {len(nodes)} TaskNodes: {list(nodes.keys())}")

        # Filter nodes that have runtime configuration (custom nodes)
        activatable_nodes = _filter_activatable_nodes(nodes)

        if not activatable_nodes:
            logger.warning(" No custom TaskNodes with runtime configuration found")
            return False

        logger.info(f"🚀 Starting activation of {len(activatable_nodes)} custom TaskNodes...")

        # Activate each node
        success_count = await _activate_nodes(activatable_nodes)

        _log_activation_summary(success_count, len(activatable_nodes))

        return success_count > 0

    except Exception as e:
        logger.error(f"Error during auto-activation: {str(e)}")
        traceback.print_exc()
        return False

def _filter_activatable_nodes(nodes: Dict[str, Any]) -> List[Tuple[str, Dict, Dict]]:
    """
    Filter nodes that can be auto-activated
    
    Args:
        nodes: Dictionary of all nodes from ModelStore
        
    Returns:
        List of tuples (node_name, node_info, runtime)
    """
    activatable_nodes = []

    for node_name, node_info in nodes.items():
        runtime = node_info.get("runtime", {})
        if (_has_complete_runtime_config(runtime)):
            activatable_nodes.append((node_name, node_info, runtime))
            logger.info(f"{node_name}: Ready for activation")
        else:
            logger.info(f"{node_name}: No runtime config (built-in node)")

    return activatable_nodes

def _has_complete_runtime_config(runtime: Dict) -> bool:
    """
    Check if runtime configuration is complete
    
    Args:
        runtime: Runtime configuration dictionary
        
    Returns:
        bool: True if configuration is complete
    """
    return (runtime and 
            runtime.get("service_path") and 
            runtime.get("dependency_path") and
            runtime.get("python_version"))

async def _activate_nodes(activatable_nodes: List[Tuple[str, Dict, Dict]]) -> int:
    """
    Activate a list of nodes
    
    Args:
        activatable_nodes: List of nodes to activate
        
    Returns:
        int: Number of successfully activated nodes
    """
    # Use the higher-level registration that also registers into TaskNodeManager
    from app.services.tasks_service import register_custom_node_endpoint as service_register_custom_node_endpoint

    success_count = 0

    for node_name, node_info, runtime in activatable_nodes:
        try:
            logger.info(f"🔄 Activating {node_name}...")

            # Run potentially blocking registration in a thread
            def _register_sync():
                return service_register_custom_node_endpoint(
                    model_name=node_name,
                    python_version=runtime.get("python_version", "3.8"),
                    service_path=runtime.get("service_path"),
                    dependency_path=runtime.get("dependency_path"),
                    factory=node_info.get("factory") or node_info.get("factory_name") or "",
                    description=node_info.get("description"),
                    port=runtime.get("port"),
                    env_name=runtime.get("env_name"),
                    install_dependencies=False,
                    io_specs=None,
                    log_path=runtime.get("log_path"),
                )

            result = await asyncio.to_thread(_register_sync)

            # Handle both {status: 'success'} and {code: 0} formats
            if (isinstance(result, dict) and (
                (result.get("status") == "success") or (result.get("code") == 0)
            )):
                try:
                    port = (result.get("port") or result.get("data", {}).get("port"))
                    env_name = (result.get("env_name") or result.get("data", {}).get("env_name"))
                except Exception:
                    port = None
                    env_name = None
                logger.info(f"{node_name}: Activated and registered on port {port} (env: {env_name})")
                success_count += 1
            else:
                logger.error(f"{node_name}: Activation failed - {result}")

        except Exception as e:
            logger.error(f"{node_name}: Exception during activation - {str(e)}")

    return success_count

def _log_activation_summary(success_count: int, total_count: int):
    """
    Log the activation summary
    
    Args:
        success_count: Number of successfully activated nodes
        total_count: Total number of nodes attempted
    """
    logger.info("=" * 60)
    logger.info(f"Auto-activation completed: {success_count}/{total_count} TaskNodes activated")
    if success_count > 0:
        logger.info("Users can now use TaskNodes without manual activation!")
    logger.info("=" * 60)

def is_auto_activation_enabled() -> bool:
    """
    Check if auto-activation is enabled
    
    Returns:
        bool: True if auto-activation is enabled
    """
    return AUTO_ACTIVATE_TASKNODES

def get_activation_status_message() -> str:
    """
    Get the activation status message for startup logs
    
    Returns:
        str: Status message
    """
    if AUTO_ACTIVATE_TASKNODES:
        return "🚀 TaskNode Auto-Activation: ENABLED\n   All TaskNodes will be activated automatically on startup"
    else:
        return "⏸️  TaskNode Auto-Activation: DISABLED\n   TaskNodes need to be manually activated by users"
