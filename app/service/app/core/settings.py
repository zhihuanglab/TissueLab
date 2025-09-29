import os
import sys
from typing import Dict, Optional
from pydantic_settings import BaseSettings
from dotenv import load_dotenv

# Handle PyInstaller bundled application
if getattr(sys, 'frozen', False):
    # Running as bundled executable
    application_path = os.path.dirname(sys.executable)
    internal_path = os.path.join(application_path, '_internal')
    # Try _internal directory first, then application directory
    env_paths = [internal_path, application_path]
else:
    # Running as script
    application_path = os.path.dirname(os.path.abspath(__file__))
    env_paths = [application_path]

# env = os.getenv("ENV", "dev")
env = os.getenv("ENV", "prod")
env_file = f".env.{env}"

# Try to load .env file from different paths
env_loaded = False
for path in env_paths:
    env_file_path = os.path.join(path, env_file)
    if os.path.exists(env_file_path):
        load_dotenv(env_file_path)
        env_loaded = True
        print(f"Loaded environment file: {env_file_path}")
        break

if not env_loaded:
    print(f"Warning: Environment file {env_file} not found in any path: {env_paths}")

class Settings(BaseSettings):
    ENVIRONMENT: str = "production"
    CTRL_SERVICE_API_ENDPOINT: str = os.getenv("CTRL_SERVICE_API_ENDPOINT", "http://127.0.0.1:5002/api")

settings = Settings()