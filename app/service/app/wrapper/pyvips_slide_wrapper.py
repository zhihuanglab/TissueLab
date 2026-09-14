import threading
import numpy as np
from PIL import Image
import pyvips

try:
    import tifffile as _tifffile
except Exception:
    _tifffile = None


class PyvipsSlideWrapper:
    """pyvips-native wrapper for TIFF/SVS/BTF slides.

    Uses tifffile series[0].levels to discover the true pyramid pages,
    correctly excluding SVS associated images (thumbnail, label, macro).
    For the raw TIFF loader, each logical level (after sorting largest-first)
    is mapped to the IFD index reported by tifffile (``TiffPage.index``) so
    ``pyvips`` opens the correct page when pyramid IFDs are not contiguous
    or not in coarse-to-fine file order. OpenSlide-backed files still use
    ``level=`` indices from the loader.
    """

    def __init__(self, file_path):
        self.path = file_path
        self._lock = threading.Lock()

        self.level_dimensions = []
        # Parallel to level_dimensions: 0-based TIFF IFD index for pyvips page=
        self._tif_page_indices = []
        # Parallel to level_dimensions: pyvips subifd index for levels stored as
        # SubIFDs of the base page (OME-TIFF / Bio-Formats pyramids); None when
        # the level is a top-level IFD opened by page= alone.
        self._tif_subifd_indices = []

        if _tifffile is not None:
            try:
                with _tifffile.TiffFile(file_path) as tf:
                    # series[0].levels gives only the real pyramid levels —
                    # tifffile already filters out SVS associated images
                    # (thumbnail, label, macro) which live in series[1+].
                    entries = []
                    if tf.series:
                        for lvl in tf.series[0].levels:
                            if not lvl.pages:
                                continue
                            p = lvl.pages[0]
                            try:
                                h, w = p.shape[0], p.shape[1]
                                pi, si = self._page_subifd_for(p)
                                entries.append((w, h, pi, si))
                            except Exception:
                                continue
                    else:
                        for page in tf.pages:
                            try:
                                h, w = page.shape[0], page.shape[1]
                                pi, si = self._page_subifd_for(page)
                                entries.append((w, h, pi, si))
                            except Exception:
                                continue
                    entries.sort(key=lambda e: e[0], reverse=True)
                    self.level_dimensions = [(w, h) for w, h, _, _ in entries]
                    self._tif_page_indices = [pi for _, _, pi, _ in entries]
                    self._tif_subifd_indices = [si for _, _, _, si in entries]
            except Exception:
                pass

        # Fallback: open with pyvips if tifffile failed or found nothing
        if not self.level_dimensions:
            base = pyvips.Image.new_from_file(file_path)
            n_pages = base.get('n-pages') if base.get_typeof('n-pages') else 1
            base_w, base_h = base.width, base.height
            entries = []
            for i in range(n_pages):
                scale = 2 ** i
                entries.append((
                    max(1, base_w // scale),
                    max(1, base_h // scale),
                    i,
                    None,
                ))
            entries.sort(key=lambda e: e[0], reverse=True)
            self.level_dimensions = [(w, h) for w, h, _, _ in entries]
            self._tif_page_indices = [pi for _, _, pi, _ in entries]
            self._tif_subifd_indices = [si for _, _, _, si in entries]

        self.dimensions = self.level_dimensions[0]
        self.level_count = len(self.level_dimensions)
        base_w = self.dimensions[0]
        self.level_downsamples = [base_w / w for w, h in self.level_dimensions]

        # Detect which loader pyvips chose — OpenSlide uses `level=N`, TIFF uses `page=N`
        _probe = pyvips.Image.new_from_file(file_path)
        self._is_openslide = 'openslide.level-count' in _probe.get_fields()
        bands = _probe.bands

        # Copy loader metadata into properties so upload_file_path can resolve MPP /
        # magnification (openslide.*, tiff.*, vendor tags). Previously only synthetic
        # keys were set, so mpp/mag always came back empty for the pyvips path.
        _META_PREFIXES = (
            'openslide.',
            'tiff.',
            'aperio.',
            'hamamatsu.',
            'leica.',
            'philips.',
            'DICOM.',
            'codex.',
            'tiffslide.',
        )
        _Blob = getattr(pyvips, 'Blob', None)
        loader_metadata = {}
        for name in _probe.get_fields():
            if not any(name.startswith(p) for p in _META_PREFIXES):
                continue
            try:
                val = _probe.get(name)
            except Exception:
                continue
            if isinstance(val, bytes):
                continue
            if _Blob is not None and isinstance(val, _Blob):
                continue
            if isinstance(val, (str, int, float)):
                loader_metadata[name] = val if isinstance(val, str) else str(val)
            else:
                try:
                    s = str(val)
                except Exception:
                    continue
                if len(s) > 8192:
                    continue
                loader_metadata[name] = s

        del _probe

        self.properties = {
            'vendor': 'pyvips',
            'level_count': str(self.level_count),
            'dimensions': f'{self.dimensions[0]}x{self.dimensions[1]}',
            'channels': str(bands),
            **loader_metadata,
        }

        # Per-level image cache: lazily opened on first tile read
        self._level_images = {}

    @staticmethod
    def _page_subifd_for(p):
        """Map a tifffile ``TiffPage`` to the ``(pyvips page, pyvips subifd)`` it
        lives at.

        Bio-Formats / OME-TIFF pyramids often store sub-resolution levels as
        SubIFDs of the base page rather than as separate top-level IFDs. pyvips's
        ``page=`` only addresses top-level IFDs, so those levels must be opened
        with ``page=<base>, subifd=<n>``. ``TiffPage.treeindex`` is ``(page,)``
        for a top-level IFD and ``(page, k)`` for its k-th child SubIFD (k is
        1-based in tifffile), which maps to pyvips ``subifd = k - 1``. Falls back
        to ``page.index`` with no subifd when treeindex is unavailable (older
        tifffile) — preserving the previous page-based behavior.
        """
        ti = getattr(p, "treeindex", None)
        if isinstance(ti, tuple) and len(ti) >= 2:
            return int(ti[0]), int(ti[1]) - 1
        if isinstance(ti, tuple) and len(ti) == 1:
            return int(ti[0]), None
        return int(p.index), None

    def _get_level_image(self, level: int):
        """Return cached pyvips Image for the given pyramid level (lazy load).

        pyvips routes options to the correct loader internally:
        - SVS via OpenSlide loader → ``level=N`` (OpenSlide pyramid index)
        - TIFF/BTF via TIFF loader → ``page=`` uses the IFD index from
          tifffile (``_tif_page_indices``), not the logical pyramid level.
        """
        # Fetch by value, not `in` then `[...]`: close() clears this dict, so a
        # membership test followed by an unlocked subscript can raise KeyError
        # when a slide is closed while a tile read is between the two. Holding a
        # reference is safe — libvips keeps the image alive for as long as it.
        cached = self._level_images.get(level)
        if cached is not None:
            return cached

        with self._lock:
            cached = self._level_images.get(level)
            if cached is None:
                if self._is_openslide:
                    self._level_images[level] = pyvips.Image.new_from_file(
                        self.path, level=level, access="random"
                    )
                else:
                    page = (
                        self._tif_page_indices[level]
                        if level < len(self._tif_page_indices)
                        else level
                    )
                    subifd = (
                        self._tif_subifd_indices[level]
                        if level < len(self._tif_subifd_indices)
                        else None
                    )
                    if subifd is not None:
                        # Sub-resolution level stored as a SubIFD of the base
                        # page (OME-TIFF) — page= alone can't reach it.
                        self._level_images[level] = pyvips.Image.new_from_file(
                            self.path, page=page, subifd=subifd, access="random"
                        )
                    else:
                        self._level_images[level] = pyvips.Image.new_from_file(
                            self.path, page=page, access="random"
                        )
            return self._level_images[level]

    def read_region(self, location, level, size, as_array=False, **kwargs):
        """Read a region from the specified pyramid level."""
        x, y = location
        w, h = size

        # Scale coordinates from level 0 to the target level
        scale = self.dimensions[0] / self.level_dimensions[level][0]
        sx = int(x / scale)
        sy = int(y / scale)

        # Clamp to level bounds
        lw, lh = self.level_dimensions[level]
        sx = max(0, min(sx, lw - 1))
        sy = max(0, min(sy, lh - 1))
        sw = min(w, lw - sx)
        sh = min(h, lh - sy)

        # Use cached level image — no file open per tile
        img = self._get_level_image(level)
        region = img.crop(sx, sy, sw, sh)

        # Convert to numpy
        mem = region.write_to_memory()
        arr = np.frombuffer(mem, dtype=np.uint8).reshape(sh, sw, region.bands)

        # Pad if needed
        if sw < w or sh < h:
            padded = np.zeros((h, w, arr.shape[2]), dtype=np.uint8)
            padded[:sh, :sw] = arr
            arr = padded

        if as_array:
            return arr
        return Image.fromarray(arr)

    def read_region_vips(self, level: int, x: int, y: int, w: int, h: int) -> pyvips.Image:
        """Read a region from the given pyramid level as a pyvips.Image.

        Parameters
        ----------
        level : int
            Pyramid level (0 = full resolution).
        x, y : int
            Top-left corner in the coordinate space of the requested level.
        w, h : int
            Width and height in level-pixel coordinates.
        """
        lw, lh = self.level_dimensions[level]
        x = max(0, min(x, lw - 1))
        y = max(0, min(y, lh - 1))
        w = min(w, lw - x)
        h = min(h, lh - y)
        img = self._get_level_image(level)
        return img.crop(x, y, max(1, w), max(1, h))

    def get_best_level_for_downsample(self, downsample):
        """Pick the coarsest pyramid level usable for ``downsample``.

        OpenSlide-style ``ds <= downsample`` rejects levels whose stored
        downsample is a hair above the DZI power-of-two target (e.g. image
        25899px → level downsample 16.007 vs target 16.0). That forces a
        much finer level and a large residual resize. Allow 1% relative
        overshoot so the nearest coarser level still wins.
        """
        if not self.level_downsamples:
            return 0
        limit = max(1.0, float(downsample)) * 1.01
        best = 0
        for i, ds in enumerate(self.level_downsamples):
            if ds <= limit:
                best = i
        return best

    def close(self):
        """Release pyvips resources for this slide.

        Clears the per-level image cache (drops Python references).
        libvips reference counting handles the actual C-level cleanup:
        any tile threads still holding a local `img` ref will keep
        libvips alive for that image until the thread finishes, then it
        frees automatically. Do NOT call cache_drop_all() here — that
        clears the global libvips op-cache while other threads may be
        mid-operation, causing crashes.
        """
        with self._lock:
            self._level_images.clear()

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass
