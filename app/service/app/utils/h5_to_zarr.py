import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from itertools import product
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import h5py
import numpy as np
import zarr
from numcodecs import Blosc, GZip, LZ4, Zstd


logger = logging.getLogger(__name__)


@dataclass
class ConversionConfig:
    compression: str = "gzip"
    chunk_size_mb: float = 64.0
    max_workers: int = 4
    verbose: bool = False
    skip_empty: bool = True
    skip_object_arrays: bool = True
    progress_interval: int = 100
    write_stats: bool = False


class ConversionStats:
    def __init__(self):
        self.total_groups = 0
        self.total_datasets = 0
        self.converted_datasets = 0
        self.skipped_datasets = 0
        self.errors = []
        self.skipped_keys = []
        self.start_time = time.time()
        self.last_progress_time = time.time()

    def add_error(self, path: str, error: str):
        self.errors.append({"path": path, "error": str(error)})

    def add_skipped_key(self, path: str, reason: str):
        self.skipped_keys.append({"path": path, "reason": reason})

    def get_elapsed_time(self) -> float:
        return time.time() - self.start_time

    def should_report_progress(self, interval: int = 100) -> bool:
        current_time = time.time()
        if self.total_datasets % interval == 0 and current_time - self.last_progress_time > 1.0:
            self.last_progress_time = current_time
            return True
        return False


def calculate_optimal_chunks(shape: Tuple[int, ...], dtype: np.dtype, target_size_mb: float = 64.0) -> Tuple[int, ...]:
    element_size = dtype.itemsize
    target_elements = int(target_size_mb * 1024 * 1024 / element_size)

    if target_elements <= 0:
        return shape

    ndim = len(shape)
    if ndim == 0:
        return ()

    base_chunk = max(1, int(target_elements ** (1.0 / ndim)))
    chunks = []
    for dim_size in shape:
        chunk_size = min(dim_size, base_chunk)
        chunks.append(chunk_size)

    return tuple(chunks)


def resolve_compressor(name: Optional[str]):
    if not name or name.lower() in {"none", "false", "0"}:
        return None

    normalized = name.lower()
    if normalized == "gzip":
        return GZip()
    if normalized == "lz4":
        return LZ4()
    if normalized == "zstd":
        return Zstd()
    if normalized == "blosc":
        return Blosc(cname="zstd", clevel=5, shuffle=Blosc.SHUFFLE)

    raise ValueError(f"Unsupported compression codec: {name}")


def generate_chunk_slices(shape: Tuple[int, ...], chunk_shape: Tuple[int, ...]):
    if len(shape) != len(chunk_shape):
        raise ValueError("Chunk shape dimensionality must match dataset shape.")
    if not shape:
        yield ()
        return

    ranges = [range(0, dim, max(1, chunk)) for dim, chunk in zip(shape, chunk_shape)]

    for start_indices in product(*ranges):
        slices = tuple(
            slice(start, min(start + max(1, chunk), dim))
            for start, chunk, dim in zip(start_indices, chunk_shape, shape)
        )
        yield slices


def safe_convert_dataset(
    h5_dataset: h5py.Dataset,
    zarr_group: zarr.Group,
    key: str,
    config: ConversionConfig,
    stats: ConversionStats,
    logger: logging.Logger,
) -> bool:
    try:
        dtype = h5_dataset.dtype
        shape = h5_dataset.shape
        compressor = resolve_compressor(config.compression)

        if config.skip_object_arrays and dtype.kind == "O":
            logger.debug(f"Skipping object array: {key} (dtype: {dtype})")
            stats.add_skipped_key(key, f"Object array (dtype: {dtype})")
            stats.skipped_datasets += 1
            return False

        if config.skip_empty and h5_dataset.size == 0:
            logger.debug(f"Skipping empty array: {key}")
            stats.add_skipped_key(key, "Empty array")
            stats.skipped_datasets += 1
            return False

        optimal_chunks = calculate_optimal_chunks(shape, dtype, config.chunk_size_mb)

        if dtype.kind in ["S", "U"]:
            logger.debug(f"Converting string array: {key}")

            if h5_dataset.size == 1:
                data = h5_dataset[()]
                if isinstance(data, bytes):
                    data = data.decode("utf-8")
            else:
                data = h5_dataset[...]
                if isinstance(data, np.ndarray) and data.dtype.kind == "S":
                    data = np.char.decode(data, "utf-8")

            zarr_group.create_dataset(
                name=key,
                data=data,
                chunks=optimal_chunks,
                compressor=compressor,
                overwrite=True,
            )
        else:
            logger.debug(f"Converting numeric array: {key} (shape: {shape}, dtype: {dtype})")

            if h5_dataset.size > 10_000_000:
                logger.info(f"Large array detected ({h5_dataset.size} elements), using streaming")
                zarr_array = zarr_group.create_dataset(
                    name=key,
                    shape=shape,
                    dtype=dtype,
                    chunks=optimal_chunks,
                    compressor=compressor,
                    overwrite=True,
                )

                for slices in generate_chunk_slices(shape, optimal_chunks):
                    data_chunk = h5_dataset[slices]
                    zarr_array[slices] = data_chunk
            else:
                data = h5_dataset[...]
                zarr_group.create_dataset(
                    name=key,
                    data=data,
                    chunks=optimal_chunks,
                    compressor=compressor,
                    overwrite=True,
                )

        if h5_dataset.attrs:
            zarr_group[key].attrs.update(dict(h5_dataset.attrs))

        stats.converted_datasets += 1
        return True

    except Exception as e:
        logger.warning(f"Unable to convert dataset {key}: {e}")
        stats.add_error(key, str(e))
        stats.add_skipped_key(key, f"Conversion error: {str(e)}")
        stats.skipped_datasets += 1
        return False


def convert_group_parallel(
    h5_group: h5py.Group,
    zarr_group: zarr.Group,
    path: str,
    config: ConversionConfig,
    stats: ConversionStats,
    logger: logging.Logger,
):
    datasets_to_convert = []

    for key in h5_group.keys():
        obj = h5_group[key]
        current_path = f"{path}/{key}" if path else key

        if isinstance(obj, h5py.Group):
            zarr_subgroup = zarr_group.create_group(key, overwrite=True)
            stats.total_groups += 1

            if obj.attrs:
                zarr_subgroup.attrs.update(dict(obj.attrs))

            convert_group_parallel(obj, zarr_subgroup, current_path, config, stats, logger)

        elif isinstance(obj, h5py.Dataset):
            stats.total_datasets += 1
            datasets_to_convert.append((obj, key, current_path))

    if datasets_to_convert and config.max_workers > 1:
        with ThreadPoolExecutor(max_workers=config.max_workers) as executor:
            futures = []
            for h5_dataset, key, current_path in datasets_to_convert:
                future = executor.submit(
                    safe_convert_dataset, h5_dataset, zarr_group, key, config, stats, logger
                )
                futures.append((future, current_path))

            for future, current_path in futures:
                try:
                    future.result(timeout=300)
                    if config.verbose:
                        logger.info(f"Processed dataset: {current_path}")
                except Exception as e:
                    logger.error(f"Failed to process dataset {current_path}: {e}")
                    stats.add_error(current_path, str(e))
                    stats.add_skipped_key(current_path, f"Processing error: {str(e)}")
                    stats.skipped_datasets += 1
    else:
        for h5_dataset, key, current_path in datasets_to_convert:
            logger.info(f"Processing dataset: {current_path}")
            safe_convert_dataset(h5_dataset, zarr_group, key, config, stats, logger)

            if stats.should_report_progress(config.progress_interval):
                elapsed = stats.get_elapsed_time()
                logger.info(
                    f"Progress: {stats.converted_datasets}/{stats.total_datasets} "
                    f"datasets converted in {elapsed:.1f}s"
                )


def convert_h5_to_zarr(h5_path: str, zarr_path: str, config: ConversionConfig) -> Dict[str, Any]:
    logger = logging.getLogger("h5_to_zarr")
    level = logging.DEBUG if config.verbose else logging.INFO
    logging.basicConfig(level=level)

    try:
        logger.info(f"Converting {h5_path} to {zarr_path}")
        logger.info(
            f"Configuration: compression={config.compression}, "
            f"chunk_size={config.chunk_size_mb}MB, workers={config.max_workers}"
        )

        os.makedirs(os.path.dirname(zarr_path), exist_ok=True)

        stats = ConversionStats()

        with h5py.File(h5_path, "r") as h5_file:
            store = zarr.DirectoryStore(zarr_path)
            root = zarr.group(store=store, overwrite=True)

            if h5_file.attrs:
                root.attrs.update(dict(h5_file.attrs))

            convert_group_parallel(h5_file, root, "", config, stats, logger)

            elapsed_time = stats.get_elapsed_time()
            logger.info(f"Conversion completed in {elapsed_time:.2f} seconds:")
            logger.info(f"  Total groups: {stats.total_groups}")
            logger.info(f"  Total datasets: {stats.total_datasets}")
            logger.info(f"  Successfully converted: {stats.converted_datasets}")
            logger.info(f"  Skipped: {stats.skipped_datasets}")
            logger.info(f"  Errors: {len(stats.errors)}")

            if stats.skipped_keys:
                logger.info(f"\nSkipped datasets ({len(stats.skipped_keys)}):")
                for skipped in stats.skipped_keys:
                    logger.info(f"  - {skipped['path']}: {skipped['reason']}")

            if config.write_stats:
                stats_dict = {
                    "total_groups": stats.total_groups,
                    "total_datasets": stats.total_datasets,
                    "converted_datasets": stats.converted_datasets,
                    "skipped_datasets": stats.skipped_datasets,
                    "skipped_keys": stats.skipped_keys,
                    "errors": stats.errors,
                    "elapsed_time": elapsed_time,
                    "config": {
                        "compression": config.compression,
                        "chunk_size_mb": config.chunk_size_mb,
                        "max_workers": config.max_workers,
                    },
                }

                stats_file = zarr_path + ".conversion_stats.json"
                with open(stats_file, "w") as f:
                    json.dump(stats_dict, f, indent=2)
                logger.info(f"Conversion statistics saved to: {stats_file}")

            return {
                "success": True,
                "stats": {
                    "total_groups": stats.total_groups,
                    "total_datasets": stats.total_datasets,
                    "converted_datasets": stats.converted_datasets,
                    "skipped_datasets": stats.skipped_datasets,
                    "errors": stats.errors,
                    "elapsed_time": elapsed_time,
                },
            }

    except Exception as e:
        logger.error(f"Conversion failed: {e}")
        if config.verbose:
            import traceback

            traceback.print_exc()
        return {"success": False, "error": str(e)}


def test_zarr_file(zarr_path: str, verbose: bool = False) -> Dict[str, Any]:
    logger = logging.getLogger("h5_to_zarr_test")
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(level=level)

    try:
        logger.info(f"Testing Zarr file: {zarr_path}")

        details = {
            "groups": 0,
            "arrays": 0,
            "total_size_bytes": 0,
            "sample_errors": [],
        }

        with zarr.open(zarr_path, mode="r") as zarr_file:
            logger.info(f"Root attributes: {len(zarr_file.attrs)}")

            def count_objects(obj, path=""):
                for key in obj.keys():
                    child = obj[key]
                    if isinstance(child, zarr.Group):
                        details["groups"] += 1
                        count_objects(child, f"{path}/{key}")
                    elif isinstance(child, zarr.Array):
                        details["arrays"] += 1
                        array_size = child.nbytes
                        details["total_size_bytes"] += array_size
                        if verbose:
                            logger.debug(
                                f"Array {path}/{key}: {child.shape}, "
                                f"{child.dtype}, {array_size / 1024 / 1024:.2f} MB"
                            )

            count_objects(zarr_file)

            logger.info(f"Groups: {details['groups']}")
            logger.info(f"Arrays: {details['arrays']}")
            logger.info(f"Total data size: {details['total_size_bytes'] / 1024 / 1024:.2f} MB")

            def test_read_arrays(obj, path="", max_samples=10):
                samples_tested = 0
                for key in obj.keys():
                    if samples_tested >= max_samples:
                        break
                    child = obj[key]
                    if isinstance(child, zarr.Array):
                        try:
                            logger.debug(
                                f"Testing array {path}/{key}: "
                                f"shape={child.shape}, dtype={child.dtype}"
                            )

                            if child.size < 1000:
                                data = child[...]
                                logger.debug(f"Sample data: {np.ravel(data)[:5]}")
                            else:
                                slice_tuple = tuple(slice(0, min(1, dim)) for dim in child.shape)
                                sample_data = np.array(child[slice_tuple]).ravel()[:5]
                                logger.debug(f"Sample data: {sample_data}")

                            samples_tested += 1

                        except Exception as e:
                            logger.error(f"Failed to read array {path}/{key}: {e}")
                            details["sample_errors"].append({"array": f"{path}/{key}", "error": str(e)})
                    elif isinstance(child, zarr.Group):
                        test_read_arrays(child, f"{path}/{key}", max_samples - samples_tested)

            test_read_arrays(zarr_file)

        logger.info("Zarr file test passed")
        return {"success": True, "details": details}

    except Exception as e:
        logger.error(f"Zarr file test failed: {e}")
        if verbose:
            import traceback

            traceback.print_exc()
        return {"success": False, "error": str(e)}

