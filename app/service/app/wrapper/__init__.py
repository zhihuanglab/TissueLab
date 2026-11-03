"""Slide readers: shared session handles over restartable native workers."""
# Import fastslide before anything loads libvips. fastslide bundles its own
# libjpeg and exports those symbols; once pyvips has put the system libjpeg in
# the global namespace (Linux), fastslide's jpeg_* calls bind to that copy and
# NDPI decoding deadlocks in the reader. Binding happens at import, so loading
# fastslide first keeps it on its own copy. Reader children import this
# package before anything else; macOS two-level namespaces are unaffected.
try:
    import fastslide  # noqa: F401
except ImportError:
    pass

from .pyvips_slide_wrapper import PyvipsSlideWrapper
from .shared_slide_wrapper import SharedSlideWrapper

__all__ = ["PyvipsSlideWrapper", "SharedSlideWrapper"]
