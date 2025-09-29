# app/services/factory/customized_factory.py

import os
import sys
import importlib.util
from typing import Dict, Any
from app.services.factory.base_factory import BaseModelFactory
from app.core.errors import AppError, AppErrors

class CustomizedModelFactory(BaseModelFactory):
    """
    recognize user model script
    eg:  script_path，.py script
    """

    def __init__(self, script_path: str, class_name: str = "UserModelAgent"):
        self.script_path = script_path
        self.class_name = class_name
        self.model_instance = None

        self._load_custom_model()

    def _load_custom_model(self):
        """
        dynamic load script
        """
        if not os.path.exists(self.script_path):
            raise AppErrors.INPUT_FILE_NOT_FOUND(f"{self.script_path} not found")

        # just get first method
        module_name = os.path.splitext(os.path.basename(self.script_path))[0]
        spec = importlib.util.spec_from_file_location(module_name, self.script_path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)

        # get function
        user_class = getattr(module, self.class_name, None)
        if not user_class:
            raise AppErrors.PARAMS_ERROR(f"Class {self.class_name} not found in script.")

        # get instance
        self.model_instance = user_class()

    def inference(self, input_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        user model predict logic
        """
        if not self.model_instance:
            raise AppErrors.SERVER_INTERNAL_ERROR("No model instance loaded.")

        try:

            # if not hasattr(self.model_instance, "run_inference"):
            #     raise AppErrors.PARAMS_ERROR("run_inference() not found in user model")

            result = self.model_instance.run_inference(input_data)

            return {
                "status": "success",
                "model": "custom",
                "detail": result
            }
        except AppError as err:
            raise err
        except Exception as e:
            raise AppErrors.SERVER_INTERNAL_ERROR(str(e))


