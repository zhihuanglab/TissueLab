from datetime import datetime


class TypeManageHandler:
    def __init__(self):
        # format：{idx: {"color": ..., "category": ..., "timestamp": ...}}
        self.type_data = {}

    def update_type(self, idx, color, category):
        """
        add or update based on idx (uid)。
        """
        self.type_data[idx] = {
            "color": color,
            "category": category,
            "timestamp": datetime.now().isoformat()
        }

    def get_type(self, idx):
        """
        search information based on idx
        """
        return self.type_data.get(idx)

    def remove_type(self, idx):
        """
        delete information based on idx
        """
        if idx in self.type_data:
            del self.type_data[idx]

    def list_all_types(self):
        """
        get information about all types
        """
        return self.type_data

    def clear_all(self):
        """
        clear information about all types
        """
        self.type_data.clear()
