import os
import re
import threading
import numpy as np
from PIL import Image
import pyvips

try:
    import tifffile as _tifffile
except Exception:
    _tifffile = None


_APERIO_JP2K = (33003, 33005)


def _is_aperio_jp2k(page) -> bool:
    try:
        return int(page.compression) in _APERIO_JP2K
    except Exception:
        return False


def _reduced_ifd_pyramid(pages):
    """The pyramid as the top-level IFDs lay it out: the tiled base page plus each
    tiled reduced-resolution page (NewSubfileType bit 0) of the same aspect, each
    smaller than the last.

    tifffile's series detection misses it when every IFD repeats the base page's
    "shaped" description (HistAI exports): it then reports too few levels or
    fails with "incompatible keyframe", and the slide opened as one 3-gigapixel
    level. Associated images (label, macro) differ in aspect or are not tiled.
    """
    def reduced(page):
        return int(page.tags.valueof(254, 0) or 0) & 1  # NewSubfileType

    def tiled(page):
        return page.tags.valueof(322) is not None  # raw tag, not NDPI virtual tiles

    pages = list(pages)
    if not pages or reduced(pages[0]) or not tiled(pages[0]):
        return []
    base = pages[0]
    aspect = base.imagewidth / base.imagelength
    levels = [base]
    for page in pages[1:]:
        if (reduced(page) and tiled(page)
                and page.samplesperpixel == base.samplesperpixel
                and abs(page.imagewidth / page.imagelength - aspect) <= 0.01 * aspect
                and page.imagewidth < levels[-1].imagewidth):
            levels.append(page)
    return levels


class PyvipsSlideWrapper:
    """pyvips-native wrapper for TIFF/SVS/BTF slides.

    Uses tifffile series[0].levels to discover the true pyramid pages,
    correctly excluding SVS associated images (thumbnail, label, macro).
    For the raw TIFF loader, each logical level (after sorting largest-first)
    is mapped to the IFD index reported by tifffile (``TiffPage.index``) so
    ``pyvips`` opens the correct page when pyramid IFDs are not contiguous
    or not in coarse-to-fine file order. The TIFF loader is explicit;
    automatic OpenSlide selection is never used.
    """

    def __init__(self, file_path, reject_sequential=False):
        if os.path.splitext(file_path)[1].lower() == '.ndpi':
            raise ValueError('NDPI requires fastslide for bounded region decoding')
        self.path = file_path
        self._lock = threading.Lock()

        self.level_dimensions = []
        # Parallel to level_dimensions: 0-based TIFF IFD index for pyvips page=
        self._tif_page_indices = []
        # Parallel to level_dimensions: pyvips subifd index for levels stored as
        # SubIFDs of the base page (OME-TIFF / Bio-Formats pyramids); None when
        # the level is a top-level IFD opened by page= alone.
        self._tif_subifd_indices = []
        self._thumbnail_page = None
        self._overview_image = None

        if _tifffile is not None:
            try:
                with _tifffile.TiffFile(file_path) as tf:
                    # series[0].levels gives only the real pyramid levels —
                    # tifffile already filters out SVS associated images
                    # (thumbnail, label, macro) which live in series[1+].
                    # Read the IFDs before series: a failed series detection
                    # leaves tf.pages raising "incompatible keyframe" on access.
                    pages = list(tf.pages)
                    for page in pages:
                        # Raw tags, not tifffile's virtual NDPI tiles.
                        rows = page.tags.valueof(278, page.imagelength)
                        tiled = page.tags.valueof(322) is not None
                        if not tiled and int(page.compression) == 7 and page.imagewidth * rows * page.samplesperpixel > 64 * 1024 * 1024:
                            raise ValueError('Large JPEG strip requires fastslide')
                    entries = []
                    try:
                        series_levels = [lvl for lvl in tf.series[0].levels if lvl.pages] if tf.series else None
                    except Exception:
                        # Detection itself failed; the IFD scan below still finds the pyramid.
                        series_levels = []
                    level_pages = []
                    if series_levels is not None:
                        level_pages = [lvl.pages[0] for lvl in series_levels]
                        ifd_levels = _reduced_ifd_pyramid(pages)
                        if len(ifd_levels) > len(level_pages):
                            # Only levels libvips can open (a header read, no pixels).
                            for depth, page in enumerate(ifd_levels):
                                try:
                                    pyvips.Image.tiffload(file_path, page=int(page.index), access="random")
                                except pyvips.Error:
                                    ifd_levels = ifd_levels[:depth]
                                    break
                            if len(ifd_levels) > len(level_pages):
                                level_pages = ifd_levels
                        for p in level_pages:
                            try:
                                h, w = int(p.imagelength), int(p.imagewidth)
                                pi, si = self._page_subifd_for(p)
                                entries.append((w, h, pi, si))
                            except Exception:
                                continue
                    else:
                        for page in pages:
                            try:
                                h, w = int(page.imagelength), int(page.imagewidth)
                                pi, si = self._page_subifd_for(page)
                                entries.append((w, h, pi, si))
                            except Exception:
                                continue
                    if any(_is_aperio_jp2k(p) for p in level_pages):
                        # Aperio JPEG 2000: fastslide decodes 33003 ~2x faster than
                        # libvips' TIFF loader, which also renders 33005 (RGB) as
                        # YCbCr (magenta tiles). JPEG SVS stays here: fastslide is
                        # slower on it. The isolated reader falls back to fastslide
                        # when this constructor raises.
                        raise ValueError('Aperio JPEG 2000 requires fastslide')
                    entries.sort(key=lambda e: e[0], reverse=True)
                    if (reject_sequential and entries and entries[0][3] is None
                            and pages[entries[0][2]].tags.valueof(322) is not None):
                        # libvips reads some tiled pages only sequentially (JPEG
                        # YCbCr 2:1, e.g. Ventana BIF). A random read then decodes
                        # the whole level first: 11-14 s and a multi-GB temp file
                        # that a reader killed on timeout leaves behind (seen on
                        # macOS). A header read; fastslide reads by tile. Opt-in:
                        # only the isolated reader has fastslide to fall back to.
                        try:
                            _, loaded = pyvips.Image.tiffload(file_path, page=entries[0][2], access="random", flags=True)
                            sequential = not int(loaded['flags']) & 1   # VIPS_FOREIGN_PARTIAL
                        except pyvips.Error:
                            sequential = False
                        if sequential:
                            raise ValueError('Sequential-only tiled TIFF requires fastslide')
                    self.level_dimensions = [(w, h) for w, h, _, _ in entries]
                    self._tif_page_indices = [pi for _, _, pi, _ in entries]
                    if entries:
                        base_w, base_h = entries[0][0], entries[0][1]
                        for page in pages:
                            if int(page.index) in self._tif_page_indices:
                                continue
                            # Aperio's thumbnail names the exact scanned region;
                            # labels/macros don't. Keep it outside the pyramid.
                            marker = f'{base_w}x{base_h} -> {page.imagewidth}x{page.imagelength}'
                            if (page.samplesperpixel == 3 and page.imagewidth * page.imagelength <= 4_000_000
                                    and marker in (page.description or '')
                                    and abs(page.imagewidth / page.imagelength - base_w / base_h) < .005):
                                self._thumbnail_page = int(page.index)
                                break
                    self._tif_subifd_indices = [si for _, _, _, si in entries]
            except ValueError:
                raise
            except Exception:
                pass

        # Fallback: open with pyvips if tifffile failed or found nothing
        if not self.level_dimensions:
            base = pyvips.Image.tiffload(file_path, access="random")
            # Do not invent a pyramid from page count (associated images may exist).
            self.level_dimensions = [(base.width, base.height)]
            self._tif_page_indices = [0]
            self._tif_subifd_indices = [None]

        self.dimensions = self.level_dimensions[0]
        self.level_count = len(self.level_dimensions)
        base_w = self.dimensions[0]
        self.level_downsamples = [base_w / w for w, h in self.level_dimensions]

        # Explicit TIFF loader: never select OpenSlide implicitly.
        _probe = pyvips.Image.tiffload(file_path, access="random")
        self._is_openslide = False
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

        if _tifffile is not None:
            with _tifffile.TiffFile(file_path) as tf:
                page = tf.pages[0]
                description = page.description or ''
                match = re.search(r'(?:^|[|\s])MPP\s*=\s*([\d.]+)', description)
                if match:
                    loader_metadata['openslide.mpp-x'] = match.group(1)
                    loader_metadata['openslide.mpp-y'] = match.group(1)
                match = re.search(r'(?:^|[|\s])AppMag\s*=\s*([\d.]+)', description)
                if match:
                    loader_metadata['openslide.objective-power'] = match.group(1)
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
        for a top-level IFD and ``(page, k)`` for a child SubIFD, but tifffile
        numbers k from 1 for OME series and from 0 for generic ones (libvips
        ``subifd=True`` output). pyvips ``subifd`` is the position in the base
        page's SubIFDs tag, so resolve it by offset. Falls back to
        ``page.index`` with no subifd when treeindex is unavailable (older
        tifffile) — preserving the previous page-based behavior.
        """
        ti = getattr(p, "treeindex", None)
        if isinstance(ti, tuple) and len(ti) >= 2:
            base = p.parent.pages[int(ti[0])]
            return int(ti[0]), list(base.subifds or ()).index(p.offset)
        if isinstance(ti, tuple) and len(ti) == 1:
            return int(ti[0]), None
        return int(p.index), None

    def _get_level_image(self, level: int):
        """Return cached pyvips Image for the given pyramid level (lazy load).

        The explicit TIFF loader uses the physical IFD/SubIFD mappings.
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
                page = self._tif_page_indices[level]
                subifd = self._tif_subifd_indices[level]
                options = dict(page=page, access="random")
                if subifd is not None:
                    options['subifd'] = subifd
                image = pyvips.Image.tiffload(self.path, **options)
                if (image.width, image.height) != tuple(self.level_dimensions[level]):
                    raise ValueError('TIFF pyramid page dimensions do not match metadata')
                self._level_images[level] = image
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

    def read_overview_vips(self):
        """Display fallback only; an associated thumbnail is not a pyramid level."""
        if self._thumbnail_page is not None:
            # TIFF strips may be sequential even with access='random'. Decode
            # the metadata-validated small thumbnail once into reusable pixels.
            with self._lock:
                if self._overview_image is None:
                    self._overview_image = pyvips.Image.tiffload(
                        self.path, page=self._thumbnail_page, access='random'
                    ).copy_memory()
                return self._overview_image
        level = len(self.level_dimensions) - 1
        return self.read_region_vips(level, 0, 0, *self.level_dimensions[level])

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
            self._overview_image = None

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass
