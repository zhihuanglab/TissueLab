# app/services/factory/base_factory.py
from abc import ABC, abstractmethod
from typing import Any

class BaseModelFactory(ABC):
    """
    abstract factory: every model need implement this interface
    """
    def __init__(self):
        self.name = None
        self.port = None
        self.model_desc = None

    @abstractmethod
    def get_model(self) -> Any:
        """
        return model instance
        """
        pass

    def configure(self, name: str = None, port: int = None) -> None:
        """
        the model name and port
        """
        self.name = name
        self.port = port

    def get_config(self) -> dict:
        """
        Return current config data: name & port
        """
        return {
            "name": self.name,
            "port": self.port,
            "model_desc": self.model_desc
        }


