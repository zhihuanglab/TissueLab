"""Restartable WSI readers. Decode, resize and JPEG encode stay in the child.

Each slide owns a few (up to four) lazily started readers. A native timeout/crash
terminates only that reader. No caller shares a mutable pyvips concurrency
setting with pyramid conversion in the service process.
"""
from __future__ import annotations
import atexit
import contextlib
import multiprocessing
import os
import queue
import sys
import threading
import time
import types
import weakref
from collections.abc import Mapping
from app.tile_resources import (
    available_cpu_count, default_native_concurrency, default_reader_budget_mb,
    default_readers_per_slide, default_tile_workers, total_memory_bytes, integer_setting,
)


class NativeDecodeTimeout(TimeoutError):
    pass


class NativeWorkerError(RuntimeError):
    pass


class _PyramidMismatch(NativeWorkerError):
    """A restarted reader sees another pyramid; the fallback decoder must not be used."""


class NativeReadError(RuntimeError):
    """The reader answered with an error; the process itself is healthy."""


def _metadata(slide, backend):
    return dict(dimensions=tuple(slide.dimensions),
                level_dimensions=[tuple(d) for d in slide.level_dimensions],
                level_downsamples=list(slide.level_downsamples),
                properties=dict(slide.properties), backend=backend,
                associated=list(getattr(slide, 'associated_names', ())))


def _raw(image):
    return (image.width, image.height, image.bands, image.format, bytes(image.write_to_memory()))


def _ventana_properties(path):
    """OpenSlide-style scan properties of a Ventana BIF; None for anything else.

    Detected by content, not suffix: BIF scans are routinely uploaded as .tif.
    Neither decoder reports their resolution, which lives only in the iScan
    XMP element (ScanRes in um/px, Magnification), as OpenSlide reads it.
    """
    try:
        import tifffile
        with tifffile.TiffFile(path) as tiff:
            if not tiff.is_bif:
                return None
            xmps = [page.tags.valueof(700) for page in tiff.pages[:3]]
    except Exception:
        return None
    # A BIF whose scan metadata is missing or malformed is still a BIF.
    properties = {}
    xmp = next((x for x in xmps if isinstance(x, bytes) and b'<iScan' in x), None)
    if xmp is None:
        return properties
    try:
        from xml.etree import ElementTree
        # The XMP ends in NUL padding after the closing tag.
        scan = ElementTree.fromstring(xmp[:xmp.rfind(b'>') + 1]).find('iScan')
    except Exception:
        return properties
    for attribute, keys in (('ScanRes', ('openslide.mpp-x', 'openslide.mpp-y')),
                            ('Magnification', ('openslide.objective-power',))):
        value = scan.get(attribute) if scan is not None else None
        try:
            if value and 0 < float(value) < float('inf'):
                properties.update(dict.fromkeys(keys, value))
        except ValueError:
            pass
    return properties


def _overview_source(slide):
    if hasattr(slide, 'read_overview_vips'):
        return slide.read_overview_vips()
    level = len(slide.level_dimensions) - 1
    return slide.read_region_vips(level, 0, 0, *slide.level_dimensions[level])


class _FastSlideReader:
    def __init__(self, path):
        import fastslide
        self._slide = fastslide.FastSlide.from_file_path(path)
        self.dimensions = self._slide.dimensions
        # fastslide lists a Ventana BIF label page (1003x3260 beside a
        # 44480x71616 base) as a pyramid level. Keep only levels with the base
        # aspect ratio, allowing rounding/padding (5%, or 2 px on tiny levels),
        # so the pyramid matches the pyvips reader's and a fallback switch is
        # not refused as a pyramid change.
        base_w, base_h = self.dimensions
        def pyramid_level(width, height):
            expected = width * base_h / base_w
            return abs(height - expected) <= max(2, .05 * expected)
        self._levels = [index for index, (width, height) in enumerate(self._slide.level_dimensions)
                        if pyramid_level(width, height)]
        self.level_dimensions = [tuple(self._slide.level_dimensions[i]) for i in self._levels]
        self.level_downsamples = [self._slide.level_downsamples[i] for i in self._levels]
        self.properties = dict(self._slide.properties)
        for source, target in (('mpp_x', 'openslide.mpp-x'), ('mpp_y', 'openslide.mpp-y'),
                               ('objective_magnification', 'openslide.objective-power')):
            if source in self.properties:
                self.properties.setdefault(target, str(self.properties[source]))
        self.properties.setdefault('channels', '3')
        self.properties['vendor'] = 'fastslide'
        if 'levels' in self.properties:
            self.properties['levels'] = len(self._levels)
        # Label/macro photos (NDPI, SVS); not pyramid levels.
        self.associated_names = list(self._slide.associated_images.keys())
        self._overview_image = None

    def read_overview_vips(self):
        """Prefer the vendor thumbnail (Aperio) over decoding the whole top level."""
        if self._overview_image is None and 'thumbnail' in self.associated_names:
            image = self.read_associated_vips('thumbnail')
            base_w, base_h = self.dimensions
            # Same guard as PyvipsSlideWrapper: it must show the scanned region.
            if abs(image.width / image.height - base_w / base_h) < .005:
                self._overview_image = image
        if self._overview_image is not None:
            return self._overview_image
        level = len(self.level_dimensions) - 1
        return self.read_region_vips(level, 0, 0, *self.level_dimensions[level])

    def read_associated_vips(self, name):
        import pyvips
        array = self._slide.associated_images[name].numpy()
        return pyvips.Image.new_from_memory(array.tobytes(), array.shape[1], array.shape[0], array.shape[2], 'uchar')

    def read_region_vips(self, level, x, y, w, h):
        import pyvips
        import numpy as np
        if w * h * 4 > 128 * 1024 * 1024:
            raise ValueError('Fastslide region too large; use a coarser pyramid level')
        array = self._slide.read_region((x, y), level=self._levels[level], size=(w, h)).numpy()
        if array.dtype != np.uint8 or array.ndim != 3:
            raise ValueError('Unsupported fastslide pixel type')
        return pyvips.Image.new_from_memory(array.tobytes(), array.shape[1], array.shape[0], array.shape[2], 'uchar')

    def close(self):
        self._slide.close()


def _worker_main(connection, path, backend, concurrency):
    # This affects only the child; pyvips may already be imported by spawn's
    # main-module bootstrap, so also call the native setter before doing work.
    os.environ['VIPS_CONCURRENCY'] = str(concurrency)
    import pyvips
    import fastslide
    fastslide.GlobalCacheManager.instance().set_capacity_bytes(64 * 1024 * 1024)
    try:
        pyvips.vips_lib.vips_concurrency_set(concurrency)
    except AttributeError:
        import cffi
        ffi = cffi.FFI()
        ffi.cdef('void vips_concurrency_set(int);')
        library = ffi.dlopen(pyvips.library_name('vips', 42))
        library.vips_concurrency_set(concurrency)
    pyvips.cache_set_max_mem(64 * 1024 * 1024)
    from app.wrapper.pyvips_slide_wrapper import PyvipsSlideWrapper
    from app.wrapper.tile_encoding import _resize_vips_tile_to_exact, _encode_tile_vips
    slide = None
    try:
        sequential = False
        if backend != 'fastslide':
            try:
                slide = PyvipsSlideWrapper(path, reject_sequential=True)
                backend = 'pyvips_tiff'
            except Exception as error:
                sequential = 'Sequential-only' in str(error)
                backend = 'fastslide'
        if slide is None:
            try:
                slide = _FastSlideReader(path)
            except Exception:
                if not sequential:
                    raise
                # Slow whole-level reads beat a slide that does not open.
                slide = PyvipsSlideWrapper(path)
                backend = 'pyvips_tiff'
        metadata = _metadata(slide, backend)
        metadata['properties']['native_tile_concurrency'] = str(concurrency)
        connection.send(('ok', metadata))
        while True:
            try:
                operation, arguments = connection.recv()
            except EOFError:
                break
            try:
                if operation == 'tile':
                    level, x, y, w, h, out_w, out_h, quality = arguments
                    if not 0 <= level < len(slide.level_dimensions):
                        raise ValueError(f'Pyramid level {level} does not exist')
                    def render(reader):
                        coarse = getattr(reader, 'read_coarse_region_vips', None)
                        region = coarse(level, x, y, w, h, out_w, out_h) if coarse else None
                        if region is None:
                            region = reader.read_region_vips(level, x, y, w, h)
                        region = _resize_vips_tile_to_exact(region, out_w, out_h)
                        return _encode_tile_vips(region, quality)
                    try:
                        result = render(slide)
                    except Exception:
                        if backend == 'fastslide':
                            raise
                        candidate = _FastSlideReader(path)
                        if list(candidate.level_dimensions) != list(slide.level_dimensions):
                            candidate.close()
                            raise ValueError('Fallback pyramid differs; reopen the slide')
                        # Switch decoders only once the fallback has produced this tile.
                        try:
                            result = render(candidate)
                        except Exception:
                            candidate.close()
                            raise
                        slide.close()
                        slide, backend = candidate, 'fastslide'
                elif operation == 'overview':
                    out_w, out_h, quality = arguments
                    image = _overview_source(slide)
                    result = _encode_tile_vips(_resize_vips_tile_to_exact(image, out_w, out_h), quality)
                elif operation == 'thumbnail':
                    # Downscale here: the lowest level can be far larger than
                    # what is worth sending over the pipe.
                    max_w, max_h = arguments
                    image = _overview_source(slide)
                    scale = min(1.0, max_w / image.width, max_h / image.height)
                    result = _raw(image.resize(scale) if scale < 1 else image)
                elif operation == 'associated':
                    result = _raw(slide.read_associated_vips(arguments[0]))
                elif operation == 'region':
                    level, x, y, w, h = arguments
                    result = _raw(slide.read_region_vips(level, x, y, w, h))
                else:
                    raise ValueError('Unknown reader operation')
                connection.send(('ok', result))
            except Exception as error:
                connection.send(('error', str(error)))
    except Exception as error:
        try:
            connection.send(('error', str(error)))
        except (BrokenPipeError, EOFError, OSError):
            pass
    finally:
        if slide is not None:
            slide.close()
        connection.close()


def _array(width, height, bands, dtype, data):
    import numpy as np
    types = {'uchar': np.uint8, 'char': np.int8, 'ushort': np.uint16,
             'short': np.int16, 'uint': np.uint32, 'int': np.int32,
             'float': np.float32, 'double': np.float64}
    return np.frombuffer(data, dtype=types[dtype]).reshape(height, width, bands)


def _pil(width, height, bands, dtype, data):
    from PIL import Image
    array = _array(width, height, bands, dtype, data)
    return Image.fromarray(array[..., 0] if bands == 1 else array[..., :3])


def _vips_pil(image):
    # Scale deeper samples to 8 bits as the tile path does; a plain cast clips
    # a 16-bit image to white.
    if image.format == 'ushort':
        image = (image >> 8).cast('uchar')
    elif image.format != 'uchar':
        peak = image.max()
        image = (image * (255.0 / peak) if peak > 0 else image).cast('uchar')
    return _pil(*_raw(image))


class _PreviewAssociated(Mapping):
    def __init__(self, reader):
        self._reader = reader

    def __getitem__(self, name):
        if name not in self._reader.associated_names:
            raise KeyError(name)
        return _vips_pil(self._reader.read_associated_vips(name))

    def __contains__(self, name):
        return name in self._reader.associated_names

    def __iter__(self):
        return iter(self._reader.associated_names)

    def __len__(self):
        return len(self._reader.associated_names)


class PreviewSlide:
    """In-process slide for file-list previews (thumbnail, label, macro).

    Opens with the tile readers' decoders, in the same order, so previews come
    from the decoder that serves the slide's tiles and see its label and macro
    photos. Previews read only the coarsest level and the associated images,
    so they run in-process rather than in a reader process.
    """
    def __init__(self, path):
        from app.wrapper.pyvips_slide_wrapper import PyvipsSlideWrapper
        sequential = False
        try:
            self._reader = PyvipsSlideWrapper(path, reject_sequential=True)
        except Exception as error:
            sequential = 'Sequential-only' in str(error)
            try:
                self._reader = _FastSlideReader(path)
            except Exception:
                if not sequential:
                    raise
                self._reader = PyvipsSlideWrapper(path)
        self.dimensions = tuple(self._reader.dimensions)
        self.level_dimensions = [tuple(d) for d in self._reader.level_dimensions]
        self.level_downsamples = list(self._reader.level_downsamples)
        self.properties = dict(self._reader.properties)
        self.associated_images = _PreviewAssociated(self._reader)

    @property
    def associated_names(self):
        return list(getattr(self._reader, 'associated_names', ()))

    def read_associated_vips(self, name):
        return self._reader.read_associated_vips(name)

    def coarse_preview(self, size):
        """The whole slide fitted to ``size`` px from the reader's coarse copy of a
        large single-level slide (see PyvipsSlideWrapper.coarse_overview); None
        for slides whose coarsest level is already small enough to read."""
        from PIL import Image
        coarse = getattr(self._reader, 'coarse_overview', lambda: None)()
        if coarse is None:
            return None
        width, height = self.level_dimensions[0]
        scale = min(size / width, size / height)
        target = (max(1, int(width * scale)), max(1, int(height * scale)))
        return _vips_pil(coarse).resize(target, Image.Resampling.LANCZOS)

    def read_region(self, location, level, size, **kwargs):
        scale = self.level_downsamples[level]
        x, y = int(location[0] / scale), int(location[1] / scale)
        return _vips_pil(self._reader.read_region_vips(level, x, y, *size))

    def close(self):
        self._reader.close()


_readers = weakref.WeakSet()
_spawn_lock = threading.Lock()


@contextlib.contextmanager
def _spawn_without_main():
    """From source, spawn re-imports main.py — the whole service, its signal
    handlers included — into every reader (~2 s, ~250 MB each). The worker
    target is importable on its own, so give the child no main to import.
    Frozen builds already skip it via freeze_support()."""
    if getattr(sys, 'frozen', False):
        yield
        return
    with _spawn_lock:
        main = sys.modules.get('__main__')
        sys.modules['__main__'] = types.ModuleType('__main__')
        try:
            yield
        finally:
            if main is None:
                sys.modules.pop('__main__', None)
            else:
                sys.modules['__main__'] = main


class IsolatedSlideWrapper:
    def __init__(self, path, *, workers=None, timeout=None, concurrency=None, _worker_target=None):
        self.path = path
        self._timeout = float(timeout or os.getenv('TL_TILE_DECODE_TIMEOUT', '15'))
        self._open_timeout = max(self._timeout, float(os.getenv('TL_TILE_OPEN_TIMEOUT', '45')))
        cpus = available_cpu_count()
        self._concurrency = (max(1, min(128, int(concurrency))) if concurrency else
                             integer_setting('TL_TILE_VIPS_CONCURRENCY', default_native_concurrency(cpus)))
        if workers:
            count = max(1, min(4, int(workers)))
        else:
            budget_mb = integer_setting(
                'TL_TILE_MEMORY_BUDGET_MB', default_reader_budget_mb(total_memory_bytes()), high=65536,
            )
            default_readers = default_readers_per_slide(
                default_tile_workers(cpus, self._concurrency, budget_mb), budget_mb,
            )
            count = integer_setting('TL_TILE_READERS_PER_SLIDE', default_readers, high=4)
        self._available = queue.LifoQueue()
        self._slots = [None] * count
        for index in reversed(range(count)):
            self._available.put(index)
        self._lock = threading.Lock()
        # Reader demand: RPCs holding a slot, RPCs waiting for one, readers starting.
        self._inflight = self._waiting = self._warming = 0
        self._closed = False
        self._worker_target = _worker_target or _worker_main
        # NDPI and Ventana BIF start on fastslide. libvips spends 11-14 s of
        # JPEG decoding on the first read of a BIF level (JPEG tiles, YCbCr
        # 2:1; 44k x 71k base), past the reader timeout, so a restarted pyvips
        # reader never warms up; it also rejects levels smaller than one
        # 1024 px tile. fastslide reads the same tile in ~50 ms, matching
        # OpenSlide's pixels.
        ventana = _ventana_properties(path)
        self._backend = self._initial_backend = (
            'fastslide' if ventana is not None or os.path.splitext(path)[1].lower() == '.ndpi'
            else 'pyvips_tiff')
        self.restarts = 0
        self._fallback_refused = False
        try:
            metadata = self._rpc(None, (), metadata_only=True)
            self.dimensions = metadata['dimensions']
            self.level_dimensions = metadata['level_dimensions']
            self.level_downsamples = metadata['level_downsamples']
            # fastslide reports 0 mpp / objective power for BIF.
            self.properties = {**metadata['properties'], **(ventana or {})}
            self.properties['decoder_backend'] = metadata['backend']
            self.associated_names = metadata['associated']
            self.level_count = len(self.level_dimensions)
            _readers.add(self)
        except BaseException:
            self.close()
            raise

    @staticmethod
    def _stop(slot):
        if slot is None:
            return
        process, connection = slot
        connection.close()
        if process.is_alive():
            process.terminate()
        process.join(timeout=0.3)
        if process.is_alive():
            process.kill()
            process.join(timeout=0.3)
        if not process.is_alive():
            process.close()

    def _retire_failed_reader(self, index, error=None):
        with self._lock:
            failed, self._slots[index] = self._slots[index], None
            self.restarts += 1
            # Recover from native crashes/timeouts with the fallback decoder,
            # unless it has produced a different pyramid for this file: then
            # every later timeout would fail one more tile on the same mismatch.
            if isinstance(error, _PyramidMismatch):
                self._fallback_refused = True
            self._backend = self._initial_backend if self._fallback_refused else 'fastslide'
        self._stop(failed)

    def _start(self, index):
        context = multiprocessing.get_context('spawn')
        parent, child = context.Pipe()
        process = context.Process(target=self._worker_target,
                                  args=(child, self.path, self._backend, self._concurrency),
                                  name='tile-reader', daemon=True)
        with self._lock:
            if self._closed:
                parent.close()
                child.close()
                raise NativeWorkerError('Slide reader is closed')
            try:
                with _spawn_without_main():
                    process.start()
            except BaseException:
                parent.close()
                child.close()
                raise
            child.close()
            slot = self._slots[index] = (process, parent)
        return slot

    @staticmethod
    def _receive(slot, timeout):
        process, connection = slot
        if not connection.poll(timeout):
            raise NativeDecodeTimeout('Native tile reader timed out')
        try:
            status, result = connection.recv()
        except (EOFError, OSError) as error:
            raise NativeWorkerError('Native tile reader exited') from error
        if status != 'ok':
            raise NativeReadError(result)
        return result

    def _warm(self, index):
        """Start the reader in an owned slot off the request path, then hand the slot back."""
        try:
            slot = self._start(index)
            try:
                metadata = self._receive(slot, self._open_timeout)
            except NativeReadError as error:
                raise NativeWorkerError(str(error)) from error
            if metadata['level_dimensions'] != self.level_dimensions:
                raise _PyramidMismatch('Reader pyramid changed during preparation')
        except (NativeDecodeTimeout, NativeWorkerError, EOFError, OSError) as error:
            self._retire_failed_reader(index, error)
        finally:
            with self._lock:
                self._warming -= 1
            self._available.put(index)

    def _acquire(self, metadata_only):
        deadline = time.monotonic() + self._timeout
        held = []  # unstarted slots taken off the queue while waiting for a running reader
        with self._lock:
            self._waiting += 1
        try:
            while True:
                try:
                    index = self._available.get(timeout=max(0.0, deadline - time.monotonic()))
                except queue.Empty:
                    raise NativeDecodeTimeout('Slide readers are busy') from None
                with self._lock:
                    cold = self._slots[index] is None
                    started = sum(slot is not None for slot in self._slots) + self._warming
                    spare = (cold and started and not metadata_only and not self._closed
                             and self._inflight + self._waiting > started)
                    if spare:
                        self._warming += 1
                if spare:
                    # More concurrent reads than readers: start one off the
                    # request path (~0.25 s) and take whichever is ready first.
                    threading.Thread(target=self._warm, args=(index,), name='tile-reader-warm', daemon=True).start()
                    continue
                if metadata_only or not cold or not started or self._closed:
                    return index
                # Running readers cover the demand (e.g. a busy server keeps
                # each viewer at ~2 reads): wait for one, start nothing.
                held.append(index)
        finally:
            with self._lock:
                self._waiting -= 1
            for index in held:
                self._available.put(index)

    def _rpc(self, operation, arguments, *, metadata_only=False):
        index = self._acquire(metadata_only)
        with self._lock:
            self._inflight += 1
        try:
            with self._lock:
                if self._closed:
                    raise NativeWorkerError('Slide reader is closed')
                slot = self._slots[index]
            if slot is not None and not slot[0].is_alive():
                # A sibling crash or OOM kill: restart now rather than failing
                # this tile on a dead pipe first.
                self._retire_failed_reader(index, NativeWorkerError('Native tile reader exited'))
                slot = None
            if slot is None:
                slot = self._start(index)
                try:
                    metadata = self._receive(slot, self._open_timeout)
                except NativeReadError as error:
                    raise NativeWorkerError(str(error)) from error
                if hasattr(self, 'level_dimensions') and metadata['level_dimensions'] != self.level_dimensions:
                    raise _PyramidMismatch('Reader pyramid changed; reopen the slide')
                if metadata_only:
                    return metadata
            elif metadata_only:
                raise NativeWorkerError('Metadata requested twice')
            slot[1].send((operation, arguments))
            return self._receive(slot, self._timeout)
        except (NativeDecodeTimeout, NativeWorkerError, EOFError, OSError) as error:
            self._retire_failed_reader(index, error)
            raise
        finally:
            with self._lock:
                self._inflight -= 1
            self._available.put(index)

    def render_tile(self, level, x, y, w, h, out_w, out_h, quality=85):
        return self._rpc('tile', (level, x, y, w, h, out_w, out_h, quality))

    def render_overview(self, out_w, out_h, quality=85):
        return self._rpc('overview', (out_w, out_h, quality))

    def prepare(self):
        """Warm a second reader after open; further ones start on demand (_acquire).

        Never waits on the slot queue: requests may hold unstarted slots while
        they wait for a running reader, so blocking here could deadlock both.
        """
        with self._lock:
            if self._closed or sum(slot is not None for slot in self._slots) + self._warming >= 2:
                return
        taken = []
        with contextlib.suppress(queue.Empty):
            while True:
                taken.append(self._available.get_nowait())
        with self._lock:
            cold = next((index for index in taken if self._slots[index] is None), None)
            if cold is not None:
                taken.remove(cold)
                self._warming += 1
        for index in reversed(taken):
            self._available.put(index)
        if cold is not None:
            self._warm(cold)

    def resident_readers(self):
        with self._lock:
            return sum(slot is not None for slot in self._slots)

    def trim(self, keep=1):
        """Stop idle reader processes beyond ``keep``; returns how many stopped.

        Busy readers are never touched. A stopped slot restarts lazily when
        concurrent reads need it again, like a discarded browser tab reloading.
        """
        held, stopped = [], []
        try:
            while True:
                try:
                    held.append(self._available.get_nowait())
                except queue.Empty:
                    break
            with self._lock:
                started = sum(slot is not None for slot in self._slots)
                # LIFO: held[0] is the most recently used reader; stop the coldest.
                idle = [index for index in held if self._slots[index] is not None]
                victims = idle[len(idle) - max(0, started - keep):] if started > keep else []
                stopped = [self._slots[index] for index in victims]
                for index in victims:
                    self._slots[index] = None
        finally:
            # Hand the slots back before stopping processes: reads continue meanwhile.
            for index in reversed(held):
                self._available.put(index)
        for slot in stopped:
            self._stop(slot)
        return len(stopped)

    def read_region_vips(self, level, x, y, w, h):
        import pyvips
        lw, lh = self.level_dimensions[level]
        x, y = max(0, min(x, lw - 1)), max(0, min(y, lh - 1))
        w, h = max(1, min(w, lw - x)), max(1, min(h, lh - y))
        if w * h * 8 > 128 * 1024 * 1024:
            raise ValueError('Region too large; use a coarser pyramid level')
        width, height, bands, dtype, data = self._rpc('region', (level, x, y, w, h))
        return pyvips.Image.new_from_memory(data, width, height, bands, dtype)

    def get_thumbnail(self, size):
        """Whole slide fitted inside ``size``, as PIL (openslide semantics)."""
        return _pil(*self._rpc('thumbnail', (int(size[0]), int(size[1]))))

    def read_associated(self, name):
        if name not in self.associated_names:
            raise KeyError(name)
        return _pil(*self._rpc('associated', (name,)))

    def read_region(self, location, level, size, as_array=False, **kwargs):
        import numpy as np
        from PIL import Image
        scale = self.level_downsamples[level]
        x, y = int(location[0] / scale), int(location[1] / scale)
        image = self.read_region_vips(level, x, y, *size)
        array = _array(image.width, image.height, image.bands, image.format, image.write_to_memory())
        if image.width < size[0] or image.height < size[1]:
            padded = np.zeros((size[1], size[0], image.bands), dtype=array.dtype)
            padded[:image.height, :image.width] = array
            array = padded
        return array if as_array else Image.fromarray(array[..., 0] if image.bands == 1 else array)

    def get_best_level_for_downsample(self, downsample):
        limit = max(1.0, float(downsample)) * 1.01
        return max((i for i, scale in enumerate(self.level_downsamples) if scale <= limit), default=0)

    def close(self):
        with self._lock:
            self._closed = True
            slots, self._slots = self._slots, [None] * len(self._slots)
        for slot in slots:
            self._stop(slot)
        _readers.discard(self)

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass


def _close_readers():
    for reader in tuple(_readers):
        reader.close()


atexit.register(_close_readers)
