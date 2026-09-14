import { apiFetch, requireAxiosAppPayload } from '@/utils/common/apiFetch';
import { isApiResponse } from '@/utils/common/apiResponse';
import { AI_SERVICE_API_ENDPOINT, CTRL_SERVICE_API_ENDPOINT } from '@/config/api.config';
import { getAuthToken } from '@/utils/common/authToken';
import { getOrCreateDeviceId } from '@/utils/common/device.utils';
import { assertCanWrite } from '@/utils/common/pathAccess.utils';
import { ChunkedUploadManager } from '@/services/fileManager.service';
import { CHUNK_UPLOAD_MIN_BYTES } from '@/services/chunkedUpload.utils';

// ============================================================================
// H5 to Zarr Conversion
// ============================================================================

export type ConversionJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface H5ToZarrRequestPayload {
  source_path: string;
  target_path?: string;
  compression?: 'gzip' | 'lz4' | 'zstd' | 'blosc' | 'none';
  chunk_size_mb?: number;
  workers?: number;
  skip_empty?: boolean;
  skip_objects?: boolean;
  overwrite?: boolean;
  test?: boolean;
  verbose?: boolean;
  write_stats?: boolean;
}

interface RawConversionJob {
  job_id: string;
  status: ConversionJobStatus;
  error?: string | null;
  result?: unknown;
  enqueued_at?: number;
  started_at?: number | null;
  finished_at?: number | null;
  source_path: string;
  target_path: string;
}

export interface ConversionJobInfo {
  jobId: string;
  status: ConversionJobStatus;
  error?: string | null;
  result?: unknown;
  enqueuedAt?: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  sourcePath: string;
  targetPath: string;
}

const mapJobPayload = (payload: RawConversionJob): ConversionJobInfo => ({
  jobId: payload.job_id,
  status: payload.status,
  error: payload.error ?? null,
  result: payload.result,
  enqueuedAt: payload.enqueued_at,
  startedAt: payload.started_at ?? null,
  finishedAt: payload.finished_at ?? null,
  sourcePath: payload.source_path,
  targetPath: payload.target_path,
});

export const enqueueH5ToZarr = async (
  payload: H5ToZarrRequestPayload
): Promise<ConversionJobInfo> => {
  // In-place convert writes the source; otherwise only the destination is written.
  if (payload.target_path) {
    assertCanWrite(payload.target_path, 'convert data');
  } else {
    assertCanWrite(payload.source_path, 'convert data');
  }
  const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/data/v1/convert`, {
    method: 'POST',
    body: JSON.stringify(payload),
    returnAxiosFormat: true,
  });
  return mapJobPayload(requireAxiosAppPayload(response) as RawConversionJob);
};

export const getConversionJobStatus = async (jobId: string): Promise<ConversionJobInfo> => {
  const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/data/v1/convert/${jobId}`, {
    method: 'GET',
    returnAxiosFormat: true,
  });
  return mapJobPayload(requireAxiosAppPayload(response) as RawConversionJob);
};

// ============================================================================
// Zarr Data Operations
// ============================================================================

// Interfaces
export interface ZarrFileInfo {
  file_path: string;
  file_size: number;
  zarr_version: string;
  root_group_name: string;
  total_groups: number;
  total_arrays: number;
  file_attributes: Record<string, any>;
  last_modified: string;
}

export interface ZarrStructure {
  root: ZarrObject;
  total_groups: number;
  total_arrays: number;
}

export interface ZarrObject {
  name: string;
  full_path: string;
  type: 'group' | 'array';
  attributes?: Record<string, any>;
  children?: ZarrObject[];
  member_count?: number;
  shape?: number[];
  dtype?: string;
  size?: number;
}

export interface ArrayInfo {
  name: string;
  full_path: string;
  type: 'array';
  attributes: Record<string, any>;
  shape: number[];
  dtype: string;
  size: number;
  nbytes: number;
  compression?: string;
  chunks?: number[];
  fillvalue?: any;
  preview?: any;
  preview_shape?: number[];
  preview_total?: number;
  preview_page?: number;
  preview_limit?: number;
  preview_total_pages?: number;
  data?: any;
  class_names?: string[];
}

export interface DatasetData {
  data: any;
  shape: number[];
  dtype: string;
  total_elements: number;
  is_truncated: boolean;
  original_shape: number[];
  original_size: number;
}

export interface SearchResult {
  path: string;
  name: string;
  type: 'group' | 'array';
  match_type: 'name' | 'attribute';
  matched_attribute?: string;
  details?: {
    shape: number[];
    dtype: string;
    size: number;
  };
}

// Internal helper: append ?file_path=<file> (and extra qs) to url  
const addPath = (url: string, filePath: string, extraQS?: string) => {
  const base = `${url}?file_path=${encodeURIComponent(filePath)}`;
  return extraQS ? `${base}&${extraQS}` : base;
};

// Zarr core requests  
export const getZarrFileInfo = async (
  filePath: string
): Promise<ZarrFileInfo> => {
  // View metadata — allowed on Samples/Viewer (BE authorize_read only).
  const response = await apiFetch(
    addPath(`${AI_SERVICE_API_ENDPOINT}/data/v1/info`, filePath),
    {
      method: 'GET',
      returnAxiosFormat: true,
    }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to get Zarr file info');
  }

  return requireAxiosAppPayload(response) as any;
};

export const getZarrStructure = async (
  filePath: string,
  path: string = '/',
  includeAttributes: boolean = true,
  maxDepth: number = -1,
  // Off by default: the server computes it by stat-ing every chunk file of
  // every array, which is most of the request. Ask for it only where a size
  // is actually rendered.
  includeDiskSize: boolean = false
): Promise<ZarrStructure> => {
  // View metadata — allowed on Samples/Viewer (badges / sidebar structure).
  const qs = new URLSearchParams({
    path,
    include_attributes: includeAttributes.toString(),
    max_depth: maxDepth.toString(),
    include_disk_size: includeDiskSize.toString(),
  }).toString();

  const response = await apiFetch(
    addPath(`${AI_SERVICE_API_ENDPOINT}/data/v1/structure`, filePath, qs),
    {
      method: 'GET',
      returnAxiosFormat: true,
    }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to get Zarr structure');
  }

  return requireAxiosAppPayload(response) as any;
};

export const getZarrGroupInfo = async (
  filePath: string,
  groupPath: string,
  includeArrays: boolean = true,
  includeSubgroups: boolean = true
): Promise<ZarrObject> => {
  const qs = new URLSearchParams({
    include_arrays: includeArrays.toString(),
    include_subgroups: includeSubgroups.toString(),
  }).toString();

  const cleanPath = groupPath.startsWith('/') ? groupPath.slice(1) : groupPath;

  const response = await apiFetch(
    addPath(
      `${AI_SERVICE_API_ENDPOINT}/data/v1/groups/${cleanPath}`,
      filePath,
      qs
    ),
    {
      method: 'GET',
      returnAxiosFormat: true,
    }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to get group info');
  }

  return requireAxiosAppPayload(response) as any;
};

export const getZarrArrayInfo = async (
  filePath: string,
  arrayPath: string,
  includePreview: boolean = false,
  previewSize?: number,
  page?: number,
  limit?: number
): Promise<ArrayInfo> => {
  const params = new URLSearchParams({
    include_preview: includePreview.toString(),
  });

  // Use pagination if provided, otherwise use preview_size (legacy mode)
  if (page !== undefined && limit !== undefined) {
    params.append('page', page.toString());
    params.append('limit', limit.toString());
  } else if (previewSize !== undefined) {
    params.append('preview_size', previewSize.toString());
  }

  const qs = params.toString();
  const cleanPath = arrayPath.startsWith('/') ? arrayPath.slice(1) : arrayPath;

  const response = await apiFetch(
    addPath(
      `${AI_SERVICE_API_ENDPOINT}/data/v1/arrays/${cleanPath}`,
      filePath,
      qs
    ),
    {
      method: 'GET',
      returnAxiosFormat: true,
    }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to get array info');
  }

  return requireAxiosAppPayload(response) as any;
};

export const deleteNucleiAnnotation = async (
  filePath: string,
  arrayPath: string,
  cellId: number
): Promise<{ success: boolean; message: string }> => {
  assertCanWrite(filePath, 'delete annotation');
  const cleanPath = arrayPath.startsWith('/') ? arrayPath.slice(1) : arrayPath;

  const response = await apiFetch(
    addPath(
      `${AI_SERVICE_API_ENDPOINT}/data/v1/arrays/${cleanPath}/annotations/${cellId}`,
      filePath,
      ''
    ),
    {
      method: 'DELETE',
      returnAxiosFormat: true,
    }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to delete annotation');
  }

  return requireAxiosAppPayload(response) as any;
};

export const updateNucleiAnnotationClass = async (
  filePath: string,
  arrayPath: string,
  cellId: number,
  newClassName: string
): Promise<{ success: boolean; message: string }> => {
  assertCanWrite(filePath, 'update annotation');
  const cleanPath = arrayPath.startsWith('/') ? arrayPath.slice(1) : arrayPath;

  const response = await apiFetch(
    addPath(
      `${AI_SERVICE_API_ENDPOINT}/data/v1/arrays/${cleanPath}/annotations/${cellId}`,
      filePath,
      ''
    ),
    {
      method: 'PUT',
      body: JSON.stringify({ new_class_name: newClassName }),
      headers: {
        'Content-Type': 'application/json',
      },
      returnAxiosFormat: true,
    }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to update annotation');
  }

  return requireAxiosAppPayload(response) as any;
};

// Alias functions for tissue annotations (same API endpoints, different naming for clarity)
export const deleteTissueAnnotation = deleteNucleiAnnotation;
export const updateTissueAnnotationClass = updateNucleiAnnotationClass;

export const readZarrArrayData = async (
  filePath: string,
  arrayPath: string,
  options: {
    startIndices?: number[];
    endIndices?: number[];
    stepIndices?: number[];
    flatten?: boolean;
    maxElements?: number;
  } = {}
): Promise<DatasetData> => {
  const params = new URLSearchParams();
  if (options.startIndices) params.append('start_indices', options.startIndices.join(','));
  if (options.endIndices) params.append('end_indices', options.endIndices.join(','));
  if (options.stepIndices) params.append('step_indices', options.stepIndices.join(','));
  if (options.flatten !== undefined) params.append('flatten', options.flatten.toString());
  if (options.maxElements !== undefined) params.append('max_elements', options.maxElements.toString());

  const cleanPath = arrayPath.startsWith('/') ? arrayPath.slice(1) : arrayPath;

  const response = await apiFetch(
    addPath(
      `${AI_SERVICE_API_ENDPOINT}/data/v1/arrays/${cleanPath}/data`,
      filePath,
      params.toString()
    ),
    {
      method: 'GET',
      returnAxiosFormat: true,
    }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to read array data');
  }

  return requireAxiosAppPayload(response) as any;
};

export const getZarrObjectAttributes = async (
  filePath: string,
  objectPath: string,
  attributeName?: string
): Promise<Record<string, any>> => {
  const qs = new URLSearchParams();
  if (attributeName) qs.append('attribute_name', attributeName);

  const cleanPath = objectPath.startsWith('/') ? objectPath.slice(1) : objectPath;

  const response = await apiFetch(
    addPath(
      `${AI_SERVICE_API_ENDPOINT}/data/v1/objects/${cleanPath}/attributes`,
      filePath,
      qs.toString()
    ),
    {
      method: 'GET',
      returnAxiosFormat: true,
    }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to get object attributes');
  }

  return requireAxiosAppPayload(response) as any;
};

export const listZarrContents = async (
  filePath: string,
  groupPath: string = '/',
  recursive: boolean = false,
  objectType?: 'group' | 'array'
): Promise<{ contents: ZarrObject[]; count: number }> => {
  const qsParams: Record<string, string> = {
    group_path: groupPath,
    recursive: recursive.toString(),
  };
  if (objectType) qsParams.object_type = objectType;
  const qs = new URLSearchParams(qsParams).toString();

  const response = await apiFetch(
    addPath(`${AI_SERVICE_API_ENDPOINT}/data/v1/contents`, filePath, qs),
    {
      method: 'GET',
      returnAxiosFormat: true,
    }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to list contents');
  }

  return requireAxiosAppPayload(response) as any;
};

export const searchZarrObjects = async (
  filePath: string,
  query: string,
  options: {
    objectType?: 'group' | 'array';
    searchAttributes?: boolean;
    caseSensitive?: boolean;
  } = {}
): Promise<{ results: SearchResult[]; count: number; query: string }> => {
  const qsParams: Record<string, string> = {
    query,
    search_attributes: (options.searchAttributes || false).toString(),
    case_sensitive: (options.caseSensitive || false).toString(),
  };
  if (options.objectType) qsParams.object_type = options.objectType;

  const qs = new URLSearchParams(qsParams).toString();

  const response = await apiFetch(
    addPath(`${AI_SERVICE_API_ENDPOINT}/data/v1/search`, filePath, qs),
    {
      method: 'GET',
      returnAxiosFormat: true,
    }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to search objects');
  }

  return requireAxiosAppPayload(response) as any;
};

export const analyzeZarrFile = async (
  filePath: string,
  includeStatistics: boolean = true,
  sampleSize: number = 1000
): Promise<any> => {
  const qs = new URLSearchParams({
    include_statistics: includeStatistics.toString(),
    sample_size: sampleSize.toString(),
  }).toString();

  const response = await apiFetch(
    addPath(`${AI_SERVICE_API_ENDPOINT}/data/v1/analyze`, filePath, qs),
    {
      method: 'GET',
      returnAxiosFormat: true,
    }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to analyze file');
  }

  return requireAxiosAppPayload(response) as any;
};

export const validateZarrFile = async (
  filePath: string
): Promise<{ is_valid: boolean; file_path: string; error?: string }> => {
  const response = await apiFetch(
    addPath(`${AI_SERVICE_API_ENDPOINT}/data/v1/validate`, filePath),
    {
      method: 'GET',
      returnAxiosFormat: true,
    }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to validate file');
  }

  return requireAxiosAppPayload(response) as any;
};

// ── Whole-.zarr replacement (upload your own preprocessing, incl. nuclei seg) ──

export interface ZarrReplacementValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    top_level_groups?: string[];
    counts?: Record<string, number>;
    nuclei_count?: number | null;
    centroid_min?: number[];
    centroid_max?: number[];
    slide_dimensions?: number[] | null;
  };
}

const STAGING_BATCH_MAX_BYTES = 5 * 1024 * 1024;
const STAGING_BATCH_MAX_FILES = 500;
const STAGING_UPLOAD_MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStagingUploadError(error: unknown): boolean {
  const err = error as { message?: string; status?: number };
  const msg = String(err?.message ?? '').toLowerCase();
  if (msg.includes('cancelled') || msg.includes('canceled')) return false;
  const status = err?.status;
  if (status === 400 || status === 401 || status === 403) return false;
  if (status == null || status === 0) return true;
  return status === 408 || status === 429 || status >= 500;
}

/** POST FormData via XHR so we get real byte-level upload progress (fetch can't). */
function xhrUploadOnce(
  url: string,
  form: FormData,
  onProgress?: (fraction: number) => void
): Promise<any> {
  return new Promise((resolve, reject) => {
    const fail = (message: string, status?: number) => {
      const err: Error & { status?: number } = new Error(message);
      if (status != null) err.status = status;
      reject(err);
    };
    getAuthToken()
      .then((token) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.timeout = 10 * 60 * 1000;
        xhr.setRequestHeader('X-Device-Id', getOrCreateDeviceId());
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.upload.onprogress = (e) => {
          if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
        };
        xhr.onload = () => {
          let data: any = null;
          try {
            data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
          } catch {
            data = xhr.responseText;
          }
          if (typeof data === 'object' && data && typeof data.code === 'number' && data.code !== 0) {
            fail(data.message || data.detail || `Upload failed (${data.code})`, data.code);
            return;
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else fail(data?.detail || data?.message || `Upload failed (${xhr.status})`, xhr.status);
        };
        xhr.onerror = () => fail('Network error during upload', 0);
        xhr.ontimeout = () => fail('Upload timed out. Please try again.', 0);
        xhr.send(form);
      })
      .catch(reject);
  });
}

async function xhrUpload(
  url: string,
  buildForm: () => FormData,
  onProgress?: (fraction: number) => void
): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= STAGING_UPLOAD_MAX_RETRIES; attempt++) {
    try {
      return await xhrUploadOnce(url, buildForm(), onProgress);
    } catch (error) {
      lastErr = error;
      if (attempt >= STAGING_UPLOAD_MAX_RETRIES || !isRetryableStagingUploadError(error)) {
        throw error;
      }
      await sleep(700 * 2 ** attempt);
    }
  }
  throw lastErr;
}

function buildStagingUploadForm(
  uploadPath: string,
  files: File[],
  relativePaths: string[]
): FormData {
  const fd = new FormData();
  fd.append('path', uploadPath);
  for (const f of files) fd.append('files', f);
  fd.append('relative_paths', JSON.stringify(relativePaths));
  fd.append('overwrite', 'true');
  return fd;
}

/** Upload one batch of candidate files into a staging folder via the file-manager
 *  upload. Files land at `<stagingRel>/<relativePath>`. */
export const uploadZarrStagingBatch = async (
  uploadPath: string,
  files: File[],
  relativePaths: string[],
  onProgress?: (fraction: number) => void
): Promise<void> => {
  assertCanWrite(uploadPath, 'upload Zarr data');
  await xhrUpload(
    `${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/upload`,
    () => buildStagingUploadForm(uploadPath, files, relativePaths),
    onProgress
  );
};

async function uploadStagingFileChunked(
  uploadPath: string,
  file: File,
  relativePath: string,
  onProgress?: (fraction: number) => void
): Promise<void> {
  const manager = new ChunkedUploadManager(
    file.name,
    file,
    uploadPath,
    (progress) => onProgress?.(Math.min(1, progress / 100)),
    undefined,
    undefined,
    undefined,
    true,
    relativePath,
    false
  );
  await manager.start();
}

/** Upload a replacement candidate into staging. Large files use chunked upload;
 *  small files go in retried multipart batches. */
export const uploadZarrStaging = async (
  uploadPath: string,
  files: File[],
  relativePaths: string[],
  onProgress?: (fraction: number) => void
): Promise<void> => {
  assertCanWrite(uploadPath, 'upload Zarr data');
  const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0) || 1;
  const small: Array<{ file: File; relativePath: string }> = [];
  const large: Array<{ file: File; relativePath: string }> = [];
  for (let i = 0; i < files.length; i++) {
    const entry = { file: files[i], relativePath: relativePaths[i] };
    if ((files[i].size || 0) >= CHUNK_UPLOAD_MIN_BYTES) large.push(entry);
    else small.push(entry);
  }

  const batches: Array<{ file: File; relativePath: string }[]> = [];
  let current: Array<{ file: File; relativePath: string }> = [];
  let currentBytes = 0;
  for (const entry of small) {
    const size = entry.file.size || 0;
    const wouldExceed =
      current.length > 0 &&
      (currentBytes + size > STAGING_BATCH_MAX_BYTES || current.length >= STAGING_BATCH_MAX_FILES);
    if (wouldExceed) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += size;
  }
  if (current.length) batches.push(current);

  let bytesDone = 0;
  const report = (extra: number) => onProgress?.(Math.min(1, (bytesDone + extra) / totalBytes));

  for (const entry of large) {
    const size = entry.file.size || 0;
    await uploadStagingFileChunked(uploadPath, entry.file, entry.relativePath, (f) => report(f * size));
    bytesDone += size;
    report(0);
  }
  for (const batch of batches) {
    const size = batch.reduce((sum, e) => sum + (e.file.size || 0), 0);
    await uploadZarrStagingBatch(
      uploadPath,
      batch.map((e) => e.file),
      batch.map((e) => e.relativePath),
      (f) => report(f * size)
    );
    bytesDone += size;
    report(0);
  }
};

function _fmPayload(response: any): any {
  const d = response?.data;
  return d && typeof d === 'object' && 'data' in d && !('ok' in d) ? d.data : d;
}

/** Validate a staged candidate .zarr against the slide (dimensions passed from the
 *  viewer). Errors block; warnings are advisory. */
export const validateZarrReplacement = async (
  candidatePath: string,
  targetSlidePath: string,
  slideWidth?: number | null,
  slideHeight?: number | null
): Promise<ZarrReplacementValidation> => {
  assertCanWrite(targetSlidePath, 'validate Zarr replacement');
  const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/zarr/validate_replacement`, {
    method: 'POST',
    body: JSON.stringify({
      candidate_path: candidatePath,
      target_slide_path: targetSlidePath,
      slide_width: slideWidth ?? null,
      slide_height: slideHeight ?? null,
    }),
    returnAxiosFormat: true,
  });
  if (response.status !== 200) {
    throw new Error(response.data?.detail || 'Failed to validate replacement');
  }
  return _fmPayload(response) as ZarrReplacementValidation;
};

/** Replace the slide's sidecar .zarr with the staged candidate (crash-safe swap;
 *  the backend re-validates, refuses on error, and deletes the staging folder). */
export const replaceZarr = async (
  candidatePath: string,
  targetSlidePath: string,
  slideWidth?: number | null,
  slideHeight?: number | null
): Promise<{ ok: boolean; target_zarr: string; nuclei_count?: number | null; warnings?: string[] }> => {
  assertCanWrite(targetSlidePath, 'replace Zarr data');
  const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/zarr/replace`, {
    method: 'POST',
    body: JSON.stringify({
      candidate_path: candidatePath,
      target_slide_path: targetSlidePath,
      slide_width: slideWidth ?? null,
      slide_height: slideHeight ?? null,
    }),
    returnAxiosFormat: true,
  });
  if (response.status !== 200) {
    throw new Error(response.data?.detail || 'Failed to replace Zarr');
  }
  return _fmPayload(response);
};

/** Delete a staging folder (best-effort, on cancel). */
export const deleteZarrStaging = async (stagingRel: string): Promise<void> => {
  if (!stagingRel) return;
  try {
    await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/fm/v1/files/delete`, {
      method: 'POST',
      body: JSON.stringify({ items: [stagingRel] }),
      returnAxiosFormat: true,
    });
  } catch {
    /* best effort */
  }
};

// Endpoints that don't depend on a specific file
export const getZarrVersion = async (): Promise<Record<string, string>> => {
  const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/data/v1/version`, {
    method: 'GET',
    returnAxiosFormat: true,
  });
  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to get version info');
  }
  return requireAxiosAppPayload(response) as any;
};

export const getEnhancedFileAnalysis = async (): Promise<any> => {
  const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/data/v1/enhanced/file_analysis`, {
    method: 'GET',
    returnAxiosFormat: true,
  });
  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to get enhanced analysis');
  }
  return requireAxiosAppPayload(response) as any;
};

export const searchSegmentationArrays = async (
  query: string,
  includeSegmentation: boolean = true
): Promise<{ results: SearchResult[]; total_found: number; query: string }> => {
  const qs = new URLSearchParams({
    query,
    include_segmentation: includeSegmentation.toString(),
  }).toString();

  const response = await apiFetch(
    `${AI_SERVICE_API_ENDPOINT}/data/v1/enhanced/search_arrays?${qs}`,
    {
      method: 'GET',
      returnAxiosFormat: true,
    }
  );
  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to search arrays');
  }
  return requireAxiosAppPayload(response) as any;
};

export const getBatchArrayInfo = async (
  filePath: string,
  arrayPaths: string[],
  includePreview: boolean = false
): Promise<{
  results: Record<string, ArrayInfo>;
  errors: Record<string, string>;
  requested_count: number;
  success_count: number;
  error_count: number;
}> => {
  const response = await apiFetch(
    addPath(`${AI_SERVICE_API_ENDPOINT}/data/v1/batch/array_info`, filePath),
    {
      method: 'POST',
      body: JSON.stringify({ array_paths: arrayPaths, include_preview: includePreview }),
      returnAxiosFormat: true,
    }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to get batch array info');
  }

  return requireAxiosAppPayload(response) as any;
};

export const exportZarrStructure = async (
  filePath: string,
  exportPath: string,
  format: 'json' | 'yaml' = 'json',
  includeAttributes: boolean = true,
  maxDepth: number = -1
): Promise<{
  message: string;
  export_path: string;
  format: string;
  total_groups: number;
  total_arrays: number;
}> => {
  assertCanWrite(filePath, 'export Zarr structure');
  assertCanWrite(exportPath, 'export Zarr structure');
  const response = await apiFetch(
    addPath(`${AI_SERVICE_API_ENDPOINT}/data/v1/export/structure`, filePath),
    {
      method: 'POST',
      body: JSON.stringify({
        export_path: exportPath,
        format,
        include_attributes: includeAttributes,
        max_depth: maxDepth,
      }),
      returnAxiosFormat: true,
    }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to export structure');
  }

  return requireAxiosAppPayload(response) as any;
};

// ============================================================================
// Radiology Mask Operations
// ============================================================================

export const findRadiologyMask = async (
  basePath: string
): Promise<{
  found: boolean;
  zarr_file?: string;
  dataset_path?: string;
  dataset_name?: string;
  shape?: number[];
  dtype?: string;
  size?: number;
  nbytes?: number;
  message?: string;
}> => {
  const response = await apiFetch(
    `${AI_SERVICE_API_ENDPOINT}/radiology/v1/find_mask?base_path=${encodeURIComponent(basePath)}`,
    {
      method: 'GET',
      returnAxiosFormat: true,
    }
  );
  
  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to find radiology mask');
  }
  
  return requireAxiosAppPayload(response) as any;
};

export const loadRadiologyMaskData = async (
  zarrFilePath: string
): Promise<{
  success: boolean;
  data?: any;
  shape?: number[];
  dtype?: string;
  is_subset?: boolean;
  original_size?: number;
  is_merged?: boolean;
  class_info?: Array<{
    class_id: number;
    dataset_name: string;
    dataset_path: string;
    nonzero_count: number;
  }>;
  num_classes?: number;
  message?: string;
}> => {
  // Request binary data with gzip support
  const url = `${AI_SERVICE_API_ENDPOINT}/radiology/v1/load_mask_data?zarr_file_path=${encodeURIComponent(zarrFilePath)}`;
  const res = await apiFetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/octet-stream'
    },
    isReturnResponse: true,
  });

  if (!res.ok) {
    throw new Error(`Failed to load mask data: ${res.status}`);
  }

  const arrayBuffer: ArrayBuffer = await res.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  
  // Parse the structured binary response
  const view = new DataView(arrayBuffer);
  
  // Read metadata header (32 bytes)
  const success = view.getUint32(0, true); // little-endian
  const found = view.getUint32(4, true);
  const shape0 = view.getUint32(8, true);
  const shape1 = view.getUint32(12, true);
  const shape2 = view.getUint32(16, true);
  const isSubset = view.getUint32(20, true);
  const originalSize = view.getUint32(24, true);
  const dtypeLength = view.getUint32(28, true);
  
  if (!success || !found) {
    return {
      success: false,
      message: 'No mask data found or failed to load'
    };
  }
  
  // Read dtype string
  const dtypeBytes = uint8Array.slice(32, 32 + dtypeLength);
  const dtype = new TextDecoder().decode(dtypeBytes);
  
  // Read the actual data
  const dataStart = 32 + dtypeLength;
  const dataBytes = uint8Array.slice(dataStart);
  
  return {
    success: true,
    data: dataBytes,
    shape: [shape0, shape1, shape2],
    dtype: dtype,
    is_subset: isSubset !== 0,
    original_size: originalSize,
    is_merged: false, // Will be determined by the calling code
    message: undefined
  };
};

export const autoFindAndLoadRadiologyMask = async (
  basePath: string
): Promise<{
  success: boolean;
  found: boolean;
  dataset_info?: any;
  data?: any;
  shape?: number[];
  dtype?: string;
  is_subset?: boolean;
  original_size?: number;
  is_merged?: boolean;
  class_info?: Array<{
    class_id: number;
    dataset_name: string;
    dataset_path: string;
    nonzero_count: number;
  }>;
  num_classes?: number;
  message?: string;
}> => {
  // First find the mask info
  const maskInfo = await findRadiologyMask(basePath);
  
  if (!maskInfo.found) {
    return {
      success: false,
      found: false,
      message: maskInfo.message || 'No datasets found'
    };
  }
  
  // Then load the data using the original base path (not the Zarr file path)
  const result = await loadRadiologyMaskData(basePath);
  
  return {
    success: result.success,
    found: true,
    data: result.data,
    shape: result.shape,
    dtype: result.dtype,
    is_subset: result.is_subset,
    original_size: result.original_size,
    is_merged: result.is_merged,
    class_info: result.class_info,
    num_classes: result.num_classes,
    message: result.message
  };
};

// ============================================================================
// Segmentation Mask Operations
// ============================================================================

export interface MaskOption {
  key: string
  label: string
}

export const getMaskOptions = async (filePath: string): Promise<{ success: boolean; options?: MaskOption[]; error?: string }> => {
  try {
    if (!filePath) return { success: false, error: 'No file path' }
    const params = new URLSearchParams({ file_path: filePath })
    const url = `${AI_SERVICE_API_ENDPOINT}/seg/v1/mask_options?${params.toString()}`
    const res = (await apiFetch(url, { method: 'GET' })) as { options?: MaskOption[] }
    const options = res?.options ?? []
    return { success: true, options }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return { success: false, error: message }
  }
}

export const loadSegmentationMask = async (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  filePath: string,
  targetWidth?: number,
  targetHeight?: number,
  maskKey?: string | null,
): Promise<{
  success: boolean;
  data?: Uint8Array;
  shape?: [number, number];
  offset?: [number, number];
  full_shape?: [number, number];
  tissue_class?: string;
  error?: string;
}> => {
  try {
    if (!filePath) {
      return {
        success: false,
        error: 'No file path provided'
      };
    }

    const params = new URLSearchParams({
      x1: x1.toString(),
      y1: y1.toString(),
      x2: x2.toString(),
      y2: y2.toString(),
      file_path: filePath
    });
    
    // Add target dimensions for downsampling if provided
    if (targetWidth && targetHeight && targetWidth > 0 && targetHeight > 0) {
      params.append('target_width', targetWidth.toString());
      params.append('target_height', targetHeight.toString());
    }
    if (maskKey != null && maskKey !== '') {
      params.append('mask_key', maskKey);
    }
    
    const url = `${AI_SERVICE_API_ENDPOINT}/seg/v1/mask?${params.toString()}`;
    
    // Path-only: do not attach X-Instance-ID
    const res = await apiFetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/octet-stream'
      },
      isReturnResponse: true,
    });

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await res.json().catch(() => null);
      if (isApiResponse(body) && body.code !== 0) {
        return {
          success: false,
          error: body.message || 'Failed to load mask'
        };
      }

      if (!res.ok) {
        return {
          success: false,
          error:
            (body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
              ? (body as { message: string }).message
              : null) || `Failed to load mask: ${res.status}`
        };
      }

      return {
        success: false,
        error: 'Invalid mask response format'
      };
    }

    if (!res.ok) {
      const errorText = await res.text().catch(() => 'Unknown error');
      return {
        success: false,
        error: `Failed to load mask: ${res.status} - ${errorText}`
      };
    }

    const arrayBuffer: ArrayBuffer = await res.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    
    // Parse the structured binary response
    const view = new DataView(arrayBuffer);
    
    // Read metadata header (36 bytes: 32 bytes original + 4 bytes tissue_class_len)
    const success = view.getUint32(0, true); // little-endian
    const shape0 = view.getUint32(4, true); // height
    const shape1 = view.getUint32(8, true); // width
    const offsetX = view.getUint32(12, true);
    const offsetY = view.getUint32(16, true);
    const fullShape0 = view.getUint32(20, true); // full height
    const fullShape1 = view.getUint32(24, true); // full width
    const dataLen = view.getUint32(28, true);
    const tissueClassLen = view.getUint32(32, true); // tissue_class length
    
    if (!success) {
      return {
        success: false,
        error: 'Failed to load mask data'
      };
    }
    
    // Read the actual data (starts at byte 36)
    const dataStart = 36;
    const dataBytes = uint8Array.slice(dataStart, dataStart + dataLen);
    
    // Read tissue_class if present (starts after data)
    let tissueClass: string | undefined = undefined;
    if (tissueClassLen > 0) {
      const tissueClassStart = dataStart + dataLen;
      const tissueClassBytes = uint8Array.slice(tissueClassStart, tissueClassStart + tissueClassLen);
      try {
        // Decode UTF-8 string
        tissueClass = new TextDecoder('utf-8').decode(tissueClassBytes);
      } catch (e) {
        // Failed to decode tissue_class, ignore
      }
    }
    
    // Read region_size from response header if available
    let regionSize: [number, number] | undefined = undefined;
    const regionSizeHeader = res.headers.get('X-Mask-Region-Size');
    if (regionSizeHeader) {
      const [width, height] = regionSizeHeader.split(',').map((v: string) => parseInt(v.trim(), 10));
      if (!isNaN(width) && !isNaN(height)) {
        regionSize = [width, height];
      }
    }
    
    const result: {
      success: boolean;
      data?: Uint8Array;
      shape?: [number, number];
      offset?: [number, number];
      full_shape?: [number, number];
      region_size?: [number, number];
      tissue_class?: string;
      error?: string;
    } = {
      success: true,
      data: dataBytes,
      shape: [shape0, shape1] as [number, number],
      offset: [offsetX, offsetY] as [number, number],
      full_shape: [fullShape0, fullShape1] as [number, number]
    };

    if (regionSize) {
      result.region_size = regionSize;
    }

    if (tissueClass) {
      result.tissue_class = tissueClass;
    }

    return result;
  } catch (error: any) {
    return {
      success: false,
      error: error?.message || 'Unknown error loading mask'
    };
  }
};
