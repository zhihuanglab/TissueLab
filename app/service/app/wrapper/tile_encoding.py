import pyvips

def _resize_vips_tile_to_exact(img: pyvips.Image, out_w: int, out_h: int) -> pyvips.Image:
    """Scale to exact (out_w, out_h) so JPEG size matches OSD-reported tile geometry.

    Uses independent horizontal/vertical scale so read_region rounding cannot leave a
    height/width mismatch vs independently ceiled out_w/out_h (edge tiles).
    """
    if img.width == out_w and img.height == out_h:
        return img
    sx = out_w / img.width
    sy = out_h / img.height
    out = img.resize(sx, vscale=sy)
    if out.width > out_w:
        out = out.crop(0, 0, out_w, out.height)
    if out.height > out_h:
        out = out.crop(0, 0, out.width, out_h)
    if out.width < out_w or out.height < out_h:
        out = out.embed(0, 0, out_w, out_h, extend="background", background=[255, 255, 255])
    return out


def _encode_tile_vips(img: pyvips.Image, quality: int = 85) -> bytes:
    """Encode a pyvips image to JPEG bytes for tile serving."""
    if img.bands == 4:
        img = img.extract_band(0, n=3)
    elif img.bands == 1:
        img = img.colourspace("srgb")
    return img.jpegsave_buffer(Q=quality, keep="none")

