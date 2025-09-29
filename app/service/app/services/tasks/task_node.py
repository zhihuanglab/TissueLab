from pathlib import Path
import sys
import subprocess
import os
from fastapi import FastAPI
import uvicorn
from typing import Optional, Dict, Any
from abc import ABC, abstractmethod
from pydantic import BaseModel

project_root = str(Path(__file__).parents[3])
print(f"Adding path: {project_root}")
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
        self.process = None
        self.env_name = f"tissuelab_{self.name}"
        self.requirements_path = requirements_path

    def _install_requirements(self):
        """Install packages from requirements.txt in the conda environment."""
        if not self.requirements_path:
            return

        try:
            if not os.path.exists(self.requirements_path):
                print(f"Warning: Requirements file not found at {self.requirements_path}")
                return

            print(f"Installing requirements from {self.requirements_path}")
            subprocess.run([
                'conda', 'run', '-n', self.env_name,
                'pip', 'install', '-r', self.requirements_path
            ], check=True)

        except subprocess.CalledProcessError as e:
            print(f"Error installing requirements: {e}")
            raise
        except Exception as e:
            print(f"Unexpected error during requirements installation: {e}")
            raise

    def setup_environment(self):
        """Create and set up the conda environment if it doesn't exist."""
        try:
            # Check if conda is available
            subprocess.run(['conda', '--version'], check=True, capture_output=True)

            # Check if environment exists
            result = subprocess.run(['conda', 'env', 'list'],
                                    capture_output=True,
                                    text=True)

            if self.env_name not in result.stdout:
                print(f"Creating new conda environment: {self.env_name}")
                # Create new environment with python
                subprocess.run([
                    'conda', 'create', '-n', self.env_name,
                    'python=3.8', '-y'
                ], check=True)

                # Install base required packages
                subprocess.run([
                    'conda', 'run', '-n', self.env_name,
                    'pip', 'install', 'fastapi', 'uvicorn', 'pydantic'
                ], check=True)

                # Install packages from requirements.txt if provided
                self._install_requirements()
            else:
                print(f"Using existing conda environment: {self.env_name}")
                # Update packages from requirements.txt if provided
                self._install_requirements()

        except subprocess.CalledProcessError as e:
            print(f"Error setting up conda environment: {e}")
            raise
        except Exception as e:
            print(f"Unexpected error during conda setup: {e}")
            raise

    def start_server(self):
        """Start the FastAPI server in the conda environment"""
        if self.port is None:
            return

        try:
            # Get conda environment path
            env_path = subprocess.run(
                ['conda', 'env', 'list'],
                capture_output=True,
                text=True
            ).stdout

            env_info = [line for line in env_path.split('\n') if self.env_name in line]
            if not env_info:
                raise Exception(f"Environment {self.env_name} not found")

            env_path = env_info[0].split()[-1]
            env = os.environ.copy()
            env.update({
                "PATH": f"{env_path}/bin:{env['PATH']}",
                "CONDA_DEFAULT_ENV": self.env_name,
                "CONDA_PREFIX": env_path
            })

            # Start the server in the conda environment
            cmd = [
                'conda', 'run', '-n', self.env_name,
                'python', __file__,
                "--name", self.name,
                "--port", str(self.port),
                "--node-class", f"{self.__class__.__module__}.{self.__class__.__name__}"
            ]

            if self.requirements_path:
                cmd.extend(["--requirements", self.requirements_path])

            self.process = subprocess.Popen(cmd, env=env)
            print(f"Server started in environment {self.env_name}")

        except Exception as e:
            print(f"Error starting server: {e}")
            raise

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
        if self.process:
            self.process.terminate()
            self.process.wait()

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

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--node-class", type=str, default="app.services.tasks.current_tasks.node_A.NodeA")
    parser.add_argument("--requirements", type=str, help="Path to requirements.txt file")
    args = parser.parse_args()

    if args.node_class:
        module_path, class_name = args.node_class.rsplit('.', 1)
        module = __import__(module_path, fromlist=[class_name])
        node_class = getattr(module, class_name)
    else:
        node_class = None

    app = create_node_server(node_class, args.name, args.port, args.requirements)
    uvicorn.run(app, host="0.0.0.0", port=args.port)


