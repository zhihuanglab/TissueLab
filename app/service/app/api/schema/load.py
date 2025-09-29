from pydantic import BaseModel

class TiffToPyramidRequest(BaseModel):
    input_path: str
    output_path: str 