from pathlib import Path
import sys
from fastapi import FastAPI
from typing import Optional, Dict, Any
from abc import ABC, abstractmethod
from pydantic import BaseModel

project_root = str(Path(__file__).parents[3])
sys.path.append(project_root)

class DataModel(BaseModel):
    data: Dict[str, Any]

class TaskNode(ABC):
    def __init__(self, name, port: Optional[int] = None, requirements_path: Optional[str] = None):
        """
        Initialize the task node.

        :param name: The name of the node, used for identification and dependency management.
        :param port: Optional port number for the node's HTTP service.
        :param requirements_path: Optional path to requirements.txt file
        """
        self.name = name
        self.dependencies = []
        self.model = None
        self.port = port
        self.app = None
        self.env_name = f"tissuelab_{self.name}"
        self.requirements_path = requirements_path

    def add_dependency(self, node_name):
        """Add a dependency to another node."""
        self.dependencies.append(node_name)

    @abstractmethod
    def init(self):
        """Initialize the model instance."""
        pass

    @abstractmethod
    def read(self, data):
        """Receive data from upstream nodes."""
        pass

    @abstractmethod
    def execute(self):
        """Execute the node's logic and return output."""
        pass

    def cleanup(self):
        """Cleanup resources when shutting down"""
        pass

def create_node_server(node_class, node_name: str, port: int, requirements_path: Optional[str] = None):
    """Create a FastAPI server for the node"""
    app = FastAPI()

    # Instantiate node
    node = node_class(node_name, requirements_path=requirements_path)
    node.init()

    @app.get("/init")
    async def init_node():
        node.init()
        return {"status": "ok", "message": f"{node_name}.init() done"}

    @app.post("/read")
    async def read_node(data: DataModel):
        node.read(data.data)
        return {"status": "ok", "message": f"{node_name}.read() done", "input_data": data.data}

    @app.post("/execute")
    async def execute_node():
        result = node.execute()
        return {"status": "ok", "output": result}

    @app.post("/process")
    async def process_data(data: DataModel):
        node.read(data.data)
        result = node.execute()
        return {"status": "success", "output": result}

    @app.get("/status")
    async def get_status():
        return {
            "name": node_name,
            "status": "running",
            "port": port,
            "conda_env": node.env_name
        }

    return app

