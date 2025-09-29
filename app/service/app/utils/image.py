from PIL import Image, ExifTags
import io
import requests


def create_thumbnail(image_bytes: bytes, max_size: int = 256) -> bytes:
    """create image thumbnail"""
    image = Image.open(io.BytesIO(image_bytes))

    # handle EXIF orientation
    try:
        for orientation in ExifTags.TAGS.keys():
            if ExifTags.TAGS[orientation] == 'Orientation':
                break
        exif = image._getexif()
        if exif is not None:
            orientation_value = exif.get(orientation)
            if orientation_value == 3:
                image = image.rotate(180, expand=True)
            elif orientation_value == 6:
                image = image.rotate(270, expand=True)
            elif orientation_value == 8:
                image = image.rotate(90, expand=True)
    except (AttributeError, KeyError, IndexError):
        # if image has no EXIF data or orientation info, ignore
        pass

    # calculate scale
    width, height = image.size
    scale = min(max_size / width, max_size / height)
    new_size = (int(width * scale), int(height * scale))

    # create thumbnail
    thumbnail = image.resize(new_size, Image.Resampling.LANCZOS)

    # convert to bytes
    buffer = io.BytesIO()
    thumbnail.save(buffer, format='PNG')
    return buffer.getvalue()

def download_image(access_url: str) -> bytes:
    response = requests.get(access_url)
    response.raise_for_status()
    return response.content
