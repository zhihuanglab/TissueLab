import os
from typing import Dict, Optional
from pydantic_settings import BaseSettings
from dotenv import load_dotenv

service_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # .../app/service
env_file = os.path.join(service_root, ".env")

# Do not override existing environment variables
load_dotenv(env_file, override=False)

class Settings(BaseSettings):
    TL_SERVICE_ROOT: str = service_root
    STORAGE_BUCKET_NAME: str
    FIREBASE_PROJECT_ID: str
    ENVIRONMENT: str
    CTRL_SERVICE_API_ENDPOINT: str
    TASKNODE_MANAGER_URL: Optional[str] = os.getenv("TASKNODE_MANAGER_URL")
    BACKEND_INSTANCE_ID: int = int(os.getenv("BACKEND_INSTANCE_ID", "1"))
    OPENAI_API_KEY: Optional[str] = os.getenv("OPENAI_API_KEY")

settings = Settings()