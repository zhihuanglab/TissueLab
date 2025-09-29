import os

current_file_dir = os.path.dirname(os.path.abspath(__file__))

# check environment variable first, then use default path
if 'SERVICE_ROOT' in os.environ:
    SERVICE_ROOT_DIR = os.path.abspath(os.environ['SERVICE_ROOT'])
else:
    SERVICE_ROOT_DIR = os.path.abspath(os.path.join(current_file_dir, '..', '..'))

STORAGE_ROOT = os.path.join(SERVICE_ROOT_DIR, 'storage', 'uploads')
os.makedirs(STORAGE_ROOT, exist_ok=True) 