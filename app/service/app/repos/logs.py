from datetime import datetime, timezone
from typing import Any, Dict, List
from app.repos.schema.logs import LogData

class LogsRepo:
    def __init__(self):
        self.db = None

    def write_log(self, log_data: LogData, date: datetime) -> str:
        """
        write logs
        """
        return None
