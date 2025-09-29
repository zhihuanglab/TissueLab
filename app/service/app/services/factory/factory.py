# app/services/factory/factory.py
from typing import Dict, Any
from app.services.factory.base_factory import BaseModelFactory
from app.services.factory.nuclei_segmentation import NucleiSegmentation
from app.services.factory.tissue_segmentation import TissueSegmentation
from app.services.factory.nuclei_feature_segmentation import NucleiFeatureSegmentation
from app.services.factory.patch_encoder import PatchEncoder
from app.services.factory.wsi_encoder import WsiEncoder
from app.services.factory.customized_factory import CustomizedModelFactory
from app.core.errors import AppError, AppErrors
from app.core.response import success_response, error_response

def get_factory(model_type: str, **kwargs) -> BaseModelFactory:
    custom_cls = kwargs.get("custom_cls", None)
    model_desc = kwargs.get("model_desc", None)

    if model_type == "cell_seg":
        factory = NucleiSegmentation(custom_cls=custom_cls)
        factory.model_desc = model_desc
        return factory
    elif model_type == "tissue_seg":
        return TissueSegmentation()
    elif model_type == "custom":
        script_path = kwargs.get("script_path")
        class_name = kwargs.get("class_name", "UserModelAgent")
        return CustomizedModelFactory(script_path, class_name)
    else:
        raise AppErrors.PARAMS_ERROR(f"Unsupported model_type: {model_type}")


