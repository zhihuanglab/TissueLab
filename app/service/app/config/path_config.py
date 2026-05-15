import os
from app.core.settings import settings

current_file_dir = os.path.dirname(os.path.abspath(__file__))

# derive from settings to ensure single source of truth
SERVICE_ROOT_DIR = os.path.abspath(settings.TL_SERVICE_ROOT)
STORAGE_ROOT = os.path.join(SERVICE_ROOT_DIR, 'storage', 'uploads')
os.makedirs(STORAGE_ROOT, exist_ok=True)

try:
    print(f"[PATH CONFIG] SERVICE_ROOT_DIR: {SERVICE_ROOT_DIR}")
    print(f"[PATH CONFIG] STORAGE_ROOT: {STORAGE_ROOT}")
except Exception:
    pass

# Public paths that are accessible to all users but read-only
# These paths are visible to everyone but operations are restricted
PUBLIC_READ_ONLY_PATHS = [
    'samples',
    '/data/public',  # Absolute path on system
]

# Virtual links configuration: Allow linking paths into other directories
# Each entry creates a virtual folder that appears in a parent directory but maps to a different real path
PUBLIC_VIRTUAL_LINKS = [
    {
        'alias': 'samples/Data',      # Virtual path shown to users
        'target': '/data/public',     # Restricted absolute system path (not under STORAGE_ROOT)
        'display_name': 'Data',        # Display name in UI
        'read_only': True,             # Whether this link should be read-only
    },
    # Add more virtual links here as needed in the future
    # Example:
    # {
    #     'alias': 'samples/Examples',
    #     'target': 'examples',
    #     'display_name': 'Examples',
    #     'read_only': True,
    # },
]

def resolve_virtual_path(path: str) -> str:
    """
    Resolve a virtual path alias to its real storage path.
    If the path is not a virtual alias, returns the original path.
    
    Args:
        path: Relative path that might be a virtual alias (e.g., 'samples/Data')
    
    Returns:
        Real storage path (e.g., 'data') or original path if not virtual
    """
    if not path:
        return path
    
    # Normalize path (remove leading/trailing slashes)
    normalized = path.strip('/')
    
    # Check each virtual link
    for link in PUBLIC_VIRTUAL_LINKS:
        alias = link['alias'].strip('/')
        target = link['target']  # Don't strip leading slash for absolute paths
        
        # Exact match or subdirectory
        if normalized == alias:
            return target
        elif normalized.startswith(f"{alias}/"):
            # Replace alias prefix with target
            relative_subpath = normalized[len(alias)+1:]
            # Handle absolute vs relative target paths
            if target.startswith('/'):
                return f"{target}/{relative_subpath}"
            else:
                return f"{target}/{relative_subpath}"
    
    return path

def is_virtual_path(path: str) -> bool:
    """
    Check if a path is a virtual alias or under a virtual alias.
    
    Args:
        path: Relative path to check
    
    Returns:
        True if path is virtual, False otherwise
    """
    if not path:
        return False
    
    normalized = path.strip('/')
    
    for link in PUBLIC_VIRTUAL_LINKS:
        alias = link['alias'].strip('/')
        if normalized == alias or normalized.startswith(f"{alias}/"):
            return True
    
    return False

def get_virtual_children(parent_path: str) -> list[dict]:
    """
    Get list of virtual child entries that should appear under a parent directory.
    
    Args:
        parent_path: Parent directory path (e.g., 'samples')
    
    Returns:
        List of virtual entry metadata dicts with 'alias', 'display_name', 'target', 'read_only'
    """
    if not parent_path:
        parent_path = ''
    
    normalized_parent = parent_path.strip('/')
    children = []
    
    for link in PUBLIC_VIRTUAL_LINKS:
        alias = link['alias'].strip('/')
        
        # Check if this virtual link is a direct child of parent_path
        if '/' in alias:
            alias_parent = alias.rsplit('/', 1)[0]
            if alias_parent == normalized_parent:
                children.append(link)
    
    return children

def is_public_read_only_path(path: str) -> bool:
    """
    Check if a path is in a public read-only directory.
    This now includes both real paths and virtual alias paths.
    
    Args:
        path: Relative path from storage root (e.g., 'samples', 'data', 'samples/Data')
    
    Returns:
        True if the path is in a public read-only directory, False otherwise
    """
    if not path:
        return False
    
    # Normalize path (remove leading/trailing slashes)
    normalized = path.strip('/')
    
    # Check if path matches any public read-only path or is a subdirectory
    for public_path in PUBLIC_READ_ONLY_PATHS:
        # Handle absolute paths in PUBLIC_READ_ONLY_PATHS
        if public_path.startswith('/'):
            # Absolute path comparison
            if path == public_path or path.startswith(f"{public_path}/"):
                return True
        else:
            # Relative path comparison
            if normalized == public_path or normalized.startswith(f"{public_path}/"):
                return True
    
    # Check if this is a virtual path that maps to a read-only target
    for link in PUBLIC_VIRTUAL_LINKS:
        alias = link['alias'].strip('/')
        target = link['target']
        
        # Check if path matches the alias
        if normalized == alias or normalized.startswith(f"{alias}/"):
            # Check if the link itself is marked read-only
            if link.get('read_only', False):
                return True
            # Also check if the target is in a read-only path
            for public_path in PUBLIC_READ_ONLY_PATHS:
                if public_path.startswith('/'):
                    # Absolute path check
                    if target == public_path or target.startswith(f"{public_path}/"):
                        return True
                else:
                    # Relative path check
                    target_normalized = target.strip('/')
                    if target_normalized == public_path or target_normalized.startswith(f"{public_path}/"):
                        return True
    
    return False

def get_public_read_only_paths() -> list[str]:
    """
    Get list of all public read-only paths (includes real paths, not aliases).
    
    Returns:
        List of public read-only path names
    """
    return PUBLIC_READ_ONLY_PATHS.copy()

def get_public_virtual_links() -> list[dict]:
    """
    Get list of all public virtual links configuration.
    
    Returns:
        List of virtual link configurations
    """
    return PUBLIC_VIRTUAL_LINKS.copy()