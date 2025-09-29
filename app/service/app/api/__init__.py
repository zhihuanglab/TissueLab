# from .processing import processing_router
from .tasks import tasks_router
from .agent import agent_router
from .load import load_router
from .seg import seg_router

__all__ = [
    "tasks_router",
    "agent_router",
    "load_router",
    "seg_router",
]