from typing import Dict, Any
from app.services.factory.base_factory import BaseModelFactory

class NucleiSegmentation(BaseModelFactory):
    def __init__(self, custom_cls=None):
        # initialize
        super().__init__()

        if custom_cls is not None:
            print("[NucleiSegmentation] Using user-defined segmentation class:", custom_cls)
            self._model_instance = custom_cls()
        else:
            print("[NucleiSegmentation] Initializing InstanSeg model...")

    def get_model(self) -> Any:
        return self._model_instance


