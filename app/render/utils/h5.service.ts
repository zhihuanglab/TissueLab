import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import http from './http';

// Interfaces
export interface HDF5FileInfo {
  file_path: string;
  file_size: number;
  hdf5_version: string;
  h5py_version: string;
  root_group_name: string;
  total_groups: number;
  total_datasets: number;
  file_attributes: Record<string, any>;
  last_modified: string;
}

export interface HDF5Structure {
  root: HDF5Object;
  total_groups: number;
  total_datasets: number;
}

export interface HDF5Object {
  name: string;
  full_path: string;
  type: 'group' | 'dataset';
  attributes?: Record<string, any>;
  children?: HDF5Object[];
  member_count?: number;
  shape?: number[];
  dtype?: string;
  size?: number;
}

export interface DatasetInfo {
  name: string;
  full_path: string;
  type: 'dataset';
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
  data?: any;
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
  type: 'group' | 'dataset';
  match_type: 'name' | 'attribute';
  matched_attribute?: string;
  details?: {
    shape: number[];
    dtype: string;
    size: number;
  };
}

// Internal helper: append ?path=<file> (and extra qs) to url
const addPath = (url: string, filePath: string, extraQS?: string) => {
  const base = `${url}?path=${encodeURIComponent(filePath)}`;
  return extraQS ? `${base}&${extraQS}` : base;
};

// HDF5 core requests  
export const getHDF5FileInfo = async (
  filePath: string
): Promise<HDF5FileInfo> => {
  const response = await http.get(
    addPath(`${AI_SERVICE_API_ENDPOINT}/hdf5/v1/info`, filePath)
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to get HDF5 file info');
  }

  const { data } = response.data;
  return data;
};

export const getHDF5Structure = async (
  filePath: string,
  path: string = '/',
  includeAttributes: boolean = true,
  maxDepth: number = -1
): Promise<HDF5Structure> => {
  const qs = new URLSearchParams({
    path,
    include_attributes: includeAttributes.toString(),
    max_depth: maxDepth.toString(),
  }).toString();

  const response = await http.get(
    addPath(`${AI_SERVICE_API_ENDPOINT}/hdf5/v1/structure`, filePath, qs)
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to get HDF5 structure');
  }

  const { data } = response.data;
  return data;
};

export const getHDF5GroupInfo = async (
  filePath: string,
  groupPath: string,
  includeDatasets: boolean = true,
  includeSubgroups: boolean = true
): Promise<HDF5Object> => {
  const qs = new URLSearchParams({
    include_datasets: includeDatasets.toString(),
    include_subgroups: includeSubgroups.toString(),
  }).toString();

  const cleanPath = groupPath.startsWith('/') ? groupPath.slice(1) : groupPath;

  const response = await http.get(
    addPath(
      `${AI_SERVICE_API_ENDPOINT}/hdf5/v1/groups/${cleanPath}`,
      filePath,
      qs
    ),
    { method: 'GET' }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to get group info');
  }

  const { data } = response.data;
  return data;
};

export const getHDF5DatasetInfo = async (
  filePath: string,
  datasetPath: string,
  includePreview: boolean = false,
  previewSize: number = 10
): Promise<DatasetInfo> => {
  const qs = new URLSearchParams({
    include_preview: includePreview.toString(),
    preview_size: previewSize.toString(),
  }).toString();

  const cleanPath = datasetPath.startsWith('/') ? datasetPath.slice(1) : datasetPath;

  const response = await http.get(
    addPath(
      `${AI_SERVICE_API_ENDPOINT}/hdf5/v1/datasets/${cleanPath}`,
      filePath,
      qs
    ),
    { method: 'GET' }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to get dataset info');
  }

  const { data } = response.data;
  return data;
};

export const readHDF5DatasetData = async (
  filePath: string,
  datasetPath: string,
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

  const cleanPath = datasetPath.startsWith('/') ? datasetPath.slice(1) : datasetPath;

  const response = await http.get(
    addPath(
      `${AI_SERVICE_API_ENDPOINT}/hdf5/v1/datasets/${cleanPath}/data`,
      filePath,
      params.toString()
    ),
    { method: 'GET' }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to read dataset data');
  }

  const { data } = response.data;
  return data;
};

export const getHDF5ObjectAttributes = async (
  filePath: string,
  objectPath: string,
  attributeName?: string
): Promise<Record<string, any>> => {
  const qs = new URLSearchParams();
  if (attributeName) qs.append('attribute_name', attributeName);

  const cleanPath = objectPath.startsWith('/') ? objectPath.slice(1) : objectPath;

  const response = await http.get(
    addPath(
      `${AI_SERVICE_API_ENDPOINT}/hdf5/v1/objects/${cleanPath}/attributes`,
      filePath,
      qs.toString()
    ),
    { method: 'GET' }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to get object attributes');
  }

  const { data } = response.data;
  return data;
};

export const listHDF5Contents = async (
  filePath: string,
  groupPath: string = '/',
  recursive: boolean = false,
  objectType?: 'group' | 'dataset'
): Promise<{ contents: HDF5Object[]; count: number }> => {
  const qsParams: Record<string, string> = {
    group_path: groupPath,
    recursive: recursive.toString(),
  };
  if (objectType) qsParams.object_type = objectType;
  const qs = new URLSearchParams(qsParams).toString();

  const response = await http.get(
    addPath(`${AI_SERVICE_API_ENDPOINT}/hdf5/v1/contents`, filePath, qs),
    { method: 'GET' }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to list contents');
  }

  const { data } = response.data;
  return data;
};

export const searchHDF5Objects = async (
  filePath: string,
  query: string,
  options: {
    objectType?: 'group' | 'dataset';
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

  const response = await http.get(
    addPath(`${AI_SERVICE_API_ENDPOINT}/hdf5/v1/search`, filePath, qs),
    { method: 'GET' }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to search objects');
  }

  const { data } = response.data;
  return data;
};

export const analyzeHDF5File = async (
  filePath: string,
  includeStatistics: boolean = true,
  sampleSize: number = 1000
): Promise<any> => {
  const qs = new URLSearchParams({
    include_statistics: includeStatistics.toString(),
    sample_size: sampleSize.toString(),
  }).toString();

  const response = await http.get(
    addPath(`${AI_SERVICE_API_ENDPOINT}/hdf5/v1/analyze`, filePath, qs),
    { method: 'GET' }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to analyze file');
  }

  const { data } = response.data;
  return data;
};

export const validateHDF5File = async (
  filePath: string
): Promise<{ is_valid: boolean; file_path: string; error?: string }> => {
  const response = await http.get(
    addPath(`${AI_SERVICE_API_ENDPOINT}/hdf5/v1/validate`, filePath),
    { method: 'GET' }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to validate file');
  }

  const { data } = response.data;
  return data;
};

// Endpoints that don't depend on a specific file
export const getHDF5Version = async (): Promise<Record<string, string>> => {
  const response = await http.get(`${AI_SERVICE_API_ENDPOINT}/hdf5/v1/version`, {
    method: 'GET',
  });
  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to get version info');
  }
  const { data } = response.data;
  return data;
};

export const getEnhancedFileAnalysis = async (): Promise<any> => {
  const response = await http.get(`${AI_SERVICE_API_ENDPOINT}/seg/v1/enhanced/file_analysis`, {
    method: 'GET',
  });
  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to get enhanced analysis');
  }
  const { data } = response.data;
  return data;
};

export const searchSegmentationDatasets = async (
  query: string,
  includeSegmentation: boolean = true
): Promise<{ results: SearchResult[]; total_found: number; query: string }> => {
  const qs = new URLSearchParams({
    query,
    include_segmentation: includeSegmentation.toString(),
  }).toString();

  const response = await http.get(
    `${AI_SERVICE_API_ENDPOINT}/seg/v1/enhanced/search_datasets?${qs}`,
    { method: 'GET' }
  );
  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to search datasets');
  }
  const { data } = response.data;
  return data;
};

export const getBatchDatasetInfo = async (
  filePath: string,
  datasetPaths: string[],
  includePreview: boolean = false
): Promise<{
  results: Record<string, DatasetInfo>;
  errors: Record<string, string>;
  requested_count: number;
  success_count: number;
  error_count: number;
}> => {
  const response = await http.post(
    addPath(`${AI_SERVICE_API_ENDPOINT}/hdf5/v1/batch/dataset_info`, filePath),
    { dataset_paths: datasetPaths, include_preview: includePreview }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to get batch dataset info');
  }

  const { data } = response.data;
  return data;
};

export const exportHDF5Structure = async (
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
  total_datasets: number;
}> => {
  const response = await http.post(
    addPath(`${AI_SERVICE_API_ENDPOINT}/seg/v1/export/hdf5_structure`, filePath),
    {
      export_path: exportPath,
      format,
      include_attributes: includeAttributes,
      max_depth: maxDepth,
    }
  );

  if (response.status !== 200) {
    const errorData = response.data;
    throw new Error(errorData.detail || 'Failed to export structure');
  }

  const { data } = response.data;
  return data;
};
