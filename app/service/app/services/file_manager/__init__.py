"""File manager service package — explicit public exports.

Ported from the TissueLab control plane. The open edition has one local user
and no cross-user sharing, so the share / collaboration module is not part of
this package.
"""
from app.services.file_manager.common import (
    build_file_id,
    calculate_directory_size_bytes,
    convert_datetime_for_json,
    ensure_quota_or_raise,
    get_user_root_path,
    get_user_storage_quota_bytes,
    get_user_storage_usage_bytes,
    normalize_rel_path,
    validate_user_access_to_path,
)
from app.services.file_manager.schemas import (
    CompressRequest,
    CopyToPersonalRequest,
    DecompressRequest,
    DeleteRequest,
    FileOperationRequest,
    MoveRequest,
    RefreshMetadataRequest,
)
from app.services.file_manager.files import (
    copy_file_to_personal,
    copy_folder_to_personal,
    create_download_link_endpoint,
    create_view_link_endpoint,
    create_item,
    download_file_direct,
    get_config,
    list_files,
    move_items,
    refresh_file_metadata,
    rename_item,
    search_files,
    start_cleanup_scheduler,
)
from app.services.file_manager.upload import (
    cancel_zarr_batch_upload,
    cancel_chunked_upload,
    complete_chunked_upload,
    get_upload_status,
    init_chunked_upload,
    start_upload_session_cleanup_scheduler,
    upload_chunk,
    upload_files,
    upload_manifest,
    upload_zarr_batch,
)
from app.services.file_manager.tasks import (
    compress_items,
    decompress_zip,
    delete_items,
    get_task_status,
    stream_task_status,
)

__all__ = [
    # common
    "build_file_id",
    "calculate_directory_size_bytes",
    "convert_datetime_for_json",
    "ensure_quota_or_raise",
    "get_user_root_path",
    "get_user_storage_quota_bytes",
    "get_user_storage_usage_bytes",
    "normalize_rel_path",
    "validate_user_access_to_path",
    "start_cleanup_scheduler",
    "start_upload_session_cleanup_scheduler",
    # schemas
    "CompressRequest",
    "CopyToPersonalRequest",
    "DecompressRequest",
    "DeleteRequest",
    "FileOperationRequest",
    "MoveRequest",
    "RefreshMetadataRequest",
    # files
    "copy_file_to_personal",
    "copy_folder_to_personal",
    "create_download_link_endpoint",
    "create_view_link_endpoint",
    "create_item",
    "download_file_direct",
    "get_config",
    "list_files",
    "move_items",
    "refresh_file_metadata",
    "rename_item",
    "search_files",
    # upload
    "cancel_zarr_batch_upload",
    "cancel_chunked_upload",
    "complete_chunked_upload",
    "get_upload_status",
    "init_chunked_upload",
    "upload_chunk",
    "upload_files",
    "upload_manifest",
    "upload_zarr_batch",
    # tasks
    "compress_items",
    "decompress_zip",
    "delete_items",
    "get_task_status",
    "stream_task_status",
]

# Start the cleanup scheduler when the module is imported
start_cleanup_scheduler()
start_upload_session_cleanup_scheduler()
