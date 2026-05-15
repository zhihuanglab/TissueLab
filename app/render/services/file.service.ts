import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import { apiFetch } from '../utils/common/apiFetch';
import { shortHashFromString } from '@/utils/string.utils';

// Instance management
export interface CreateInstanceRequest {
  file_path: string;
}

export interface CreateInstanceResponse {
  instanceId: string;
  message: string;
  file_format: string;
  dimensions: number[][];
  level_count: number;
  total_tiles: number;
  // Additional properties that may be returned
  file_size?: number;
  mpp?: number;
  magnification?: number;
  image_type?: string;
  total_annotations?: number;
  total_cells?: number;
  processing_status?: string;
  total_channels?: number;
}

/** Unwrapped `data` from load/v1/upload_path when AppResponse code === 0 */
export interface UploadPathSlideInfo {
  dimensions?: [number, number] | number[][] | number[] | null;
  mpp?: number | null;
  magnification?: number | string | null;
  imageType?: string;
  fileFormat?: string;
  totalChannels?: number;
}

export interface UploadPathResult {
  fileName: string;
  /** Server path for create_instance when present; else use fileName */
  filePath?: string;
  fileSize?: number | null;
  slideInfo: UploadPathSlideInfo;
}

export const createInstance = async (filePath: string): Promise<CreateInstanceResponse> => {
  try {
    console.log('Creating instance for file:', filePath);

    const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/load/v1/create_instance`, {
      method: 'POST',
      body: JSON.stringify({ file_path: filePath }),
      returnAxiosFormat: true,
    });

    const result = response.data as CreateInstanceResponse;
    console.log('Create instance response (unwrapped):', result);

    if (response.status !== 200) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    if (!result.instanceId) {
      throw new Error('No instanceId returned from server');
    }

    window.dispatchEvent(
      new CustomEvent('slideLoaded', {
        detail: { instanceId: result.instanceId, filePath },
      })
    );

    return result;
  } catch (error) {
    console.error('Error creating instance:', error);
    throw error;
  }
};

export const deleteInstance = async (instanceId: string): Promise<void> => {
  try {
    const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/load/v1/delete_instance`, {
      method: 'DELETE',
      body: JSON.stringify({ instance_id: instanceId }),
      returnAxiosFormat: true,
    });

    if (response.status !== 200) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  } catch (error) {
    console.error('Error deleting instance:', error);
    throw error;
  }
};

// Utility function for making API calls with instance ID header
export const apiCallWithInstanceId = async (
  url: string, 
  options: RequestInit = {}, 
  instanceId?: string | null
): Promise<Response> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (instanceId) {
    headers['X-Instance-ID'] = instanceId;
  }

  return fetch(url, {
    ...options,
    headers,
  });
};

export const uploadFile = async (file: File) => {
  const formData = new FormData();
  formData.append('file', file);


  const result = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/load/v1/upload`, {
    method: 'POST',
    body: formData,
  });
  return (result as any).data || result;
};

export const uploadFolderPath = async (relativeFolderPath: string) => {
  console.log('Uploading folder path:', relativeFolderPath);

  const formData = new FormData();
  formData.append('relative_folder_path', relativeFolderPath);

  const responseJson = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/load/v1/upload_folder`, {
    method: 'POST',
    body: formData,
  });
  console.log('Upload folder path responseJson:', responseJson);
  return (responseJson as any).data || responseJson;
};

export const uploadFilePath = async (relativePath: string) => {
  const formData = new FormData();
  formData.append('relative_path', relativePath);

  const responseJson = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/load/v1/upload_path`, {
    method: 'POST',
    body: formData,
  });
  console.log('[uploadFilePath]: responseJson (unwrapped):', responseJson);

  return responseJson as UploadPathResult;
};

export const loadFileData = async (filename: string) => {
  const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/load/v1/load/${filename}/`, {
    method: 'GET',
    returnAxiosFormat: true,
  });
  if (response.status !== 200) {
    throw new Error('Failed to load slide');
  }
  console.log('loadFileData: response:', response);

  const responseJson = response.data;
  console.log('Full response JSON (unwrapped):', responseJson);

  let data: any =
    responseJson && typeof responseJson === 'object' && (responseJson as any).slideInfo
      ? responseJson
      : (responseJson as any)?.data && (responseJson as any).data.slideInfo
        ? (responseJson as any).data
        : responseJson;

  // print the full data structure for debugging
  console.log('Using data structure:', JSON.stringify(data, null, 2));

  // handle dimensions (unified format - only from slideInfo)
  if (!data.slideInfo || !data.slideInfo.dimensions) {
    throw new Error('Invalid response format: slideInfo.dimensions is required');
  }
  
  console.log('Found dimensions in slideInfo:', data.slideInfo.dimensions);
  data.dimensions = Array.isArray(data.slideInfo.dimensions[0])
    ? data.slideInfo.dimensions
    : [data.slideInfo.dimensions];

  // handle pyramid info (unified format - only from slideInfo)
  if (!data.slideInfo.pyramidInfo || !Array.isArray(data.slideInfo.pyramidInfo)) {
    throw new Error('Invalid response format: slideInfo.pyramidInfo is required');
  }
  
  console.log('Using pyramidInfo from slideInfo:', data.slideInfo.pyramidInfo);
  try {
    data.pyramid = data.slideInfo.pyramidInfo.map((level: any) => level.dimensions);
    console.log('Created pyramid from slideInfo.pyramidInfo:', data.pyramid);
  } catch (error) {
    console.error('Error mapping slideInfo.pyramidInfo:', error);
    throw error;
  }

  // get levelCount from slideInfo (unified format)
  if (!data.slideInfo.levelCount) {
    throw new Error('Invalid response format: slideInfo.levelCount is required');
  }
  data.levelCount = data.slideInfo.levelCount;
  console.log(`Using levelCount from slideInfo: ${data.levelCount}`);

  // add necessary OpenSeadragon configuration information
  data.tileSize = 512; // default tile size
  data.tileOverlap = data.tileOverlap || 0;
  data.minLevel = data.minLevel || 0;
  data.maxLevel = data.maxLevel || (data.levelCount ? data.levelCount - 1 : 0);

  // ensure the file path information is correct
  if (!data.filePath && data.fileName) {
    const pathParts = filename.split('/');
    data.filePath = pathParts.length > 1 ? filename : `${filename}/${data.fileName}`;
    console.log('Set filePath based on filename:', data.filePath);
  }

  console.log('Final processed slide data for viewer:', data);
  return data;
};

// New function to reset segmentation data
export const resetSegmentationData = async () => {
  try {
    const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/reset`, {
      method: 'POST',
      returnAxiosFormat: true,
    });

    if (response.status !== 200) {
      const errorData = response.data;
      throw new Error(errorData.error || 'Reset segmentation data failed');
    }

    const responseJson = response.data;
    console.log('Reset segmentation data response:', responseJson);
    return responseJson;
  } catch (error) {
    console.error('Error resetting segmentation data:', error);
    throw error;
  }
};


// New function for batch thumbnail generation
export const generateBatchThumbnails = async (sessionIds: string[], size: number = 200) => {
  try {
    console.log('API call - generateBatchThumbnails:', { sessionIds, size });
    
    const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/thumbnail/v1/batch/thumbnails`, {
      method: 'POST',
      body: JSON.stringify({ session_ids: sessionIds, size: size }),
      returnAxiosFormat: true,
    });
    
    if (response.status !== 200) {
      const errorData = response.data;
      throw new Error(errorData.error || 'Failed to generate batch thumbnails');
    }
    
    const result = response.data;
    console.log('Batch thumbnails response:', result);
    return result;
  } catch (error) {
    console.error('Error generating batch thumbnails:', error);
    throw error;
  }
};

// New function for batch preview generation
export const generateBatchPreviews = async (requests: Array<{session_id: string, preview_type: string, size?: number, request_id: string}>) => {
  try {
    // Validate that all requests have request_id
    for (const req of requests) {
      if (!req.request_id) {
        throw new Error('request_id is required for all batch preview requests');
      }
    }
    
    console.log('API call - generateBatchPreviews:', { requests });
    
    const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/thumbnail/v1/batch/previews`, {
      method: 'POST',
      body: JSON.stringify({ requests: requests }),
      returnAxiosFormat: true,
    });
    
    if (response.status !== 200) {
      const errorData = response.data;
      throw new Error(errorData.error || 'Failed to generate batch previews');
    }
    
    const result = response.data;
    console.log('Batch previews response:', result);
    return result;
  } catch (error) {
    console.error('Error generating batch previews:', error);
    throw error;
  }
};

// New Celery-based async thumbnail service functions
export const submitThumbnailTask = async (sessionId: string, size: number = 200, requestId: string) => {
  try {
    if (!requestId) {
      throw new Error('requestId is required for submitThumbnailTask');
    }
    
    console.log('API call - submitThumbnailTask:', { sessionId, size, requestId });
    
    const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/thumbnail/v1/thumbnails`, {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, size: size, request_id: requestId }),
      returnAxiosFormat: true,
    });
    
    if (response.status !== 200) {
      const errorData = response.data;
      throw new Error(errorData.error || 'Failed to submit thumbnail task');
    }
    
    const result = response.data;
    console.log('Submit thumbnail task response:', result);
    return result;
  } catch (error) {
    console.error('Error submitting thumbnail task:', error);
    throw error;
  }
};

export const submitPreviewTask = async (sessionId: string, previewType: string, size: number = 200, requestId: string) => {
  try {
    if (!requestId) {
      throw new Error('requestId is required for submitPreviewTask');
    }
    
    console.log('API call - submitPreviewTask:', { sessionId, previewType, size, requestId });
    
    const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/thumbnail/v1/previews`, {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, preview_type: previewType, size: size, request_id: requestId }),
      returnAxiosFormat: true,
    });
    
    if (response.status !== 200) {
      const errorData = response.data;
      throw new Error(errorData.error || 'Failed to submit preview task');
    }
    
    const result = response.data;
    console.log('Submit preview task response:', result);
    return result;
  } catch (error) {
    console.error('Error submitting preview task:', error);
    throw error;
  }
};

export const getTaskStatus = async (taskId: string) => {
  try {
    if (!taskId || taskId === 'undefined') {
      throw new Error('taskId is required and cannot be undefined');
    }
    
    console.log('API call - getTaskStatus:', { taskId });
    
    const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/thumbnail/v1/status/${taskId}`, {
      method: 'GET',
      returnAxiosFormat: true,
    });
    
    if (response.status !== 200) {
      const errorData = response.data;
      throw new Error(errorData.error || 'Failed to get task status');
    }
    
    const result = response.data;
    console.log('Get task status response:', result);
    return result;
  } catch (error) {
    console.error('Error getting task status:', error);
    throw error;
  }
};

export const submitBatchThumbnailTasks = async (sessionIds: string[], size: number = 200) => {
  try {
    console.log('API call - submitBatchThumbnailTasks:', { sessionIds, size });
    
    const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/thumbnail/v1/batch/thumbnails`, {
      method: 'POST',
      body: JSON.stringify({ session_ids: sessionIds, size: size }),
      returnAxiosFormat: true,
    });
    
    if (response.status !== 200) {
      const errorData = response.data;
      throw new Error(errorData.error || 'Failed to submit batch thumbnail tasks');
    }
    
    const result = response.data;
    console.log('Submit batch thumbnail tasks response:', result);
    return result;
  } catch (error) {
    console.error('Error submitting batch thumbnail tasks:', error);
    throw error;
  }
};

export const submitBatchPreviewTasks = async (requests: Array<{session_id: string, preview_type: string, size?: number}>) => {
  try {
    console.log('API call - submitBatchPreviewTasks:', { requests });
    
    const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/thumbnail/v1/batch/previews`, {
      method: 'POST',
      body: JSON.stringify({ requests: requests }),
      returnAxiosFormat: true,
    });
    
    if (response.status !== 200) {
      const errorData = response.data;
      throw new Error(errorData.error || 'Failed to submit batch preview tasks');
    }
    
    const result = response.data;
    console.log('Submit batch preview tasks response:', result);
    return result;
  } catch (error) {
    console.error('Error submitting batch preview tasks:', error);
    throw error;
  }
};

// Async version of getPreview that uses Celery service
export const getPreviewAsync = async (filePath: string, previewType: string = 'all', size: number = 200, requestId?: string) => {
  try {
    console.log('API call - getPreviewAsync (Celery):', { filePath, previewType, size, requestId });
    
    // Submit the preview task to Celery using file path directly
    const taskResult = await submitPreviewTaskByPath(filePath, previewType, size, requestId);
    const taskId = taskResult.task_id;
    
    if (!taskId || taskId === 'undefined') {
      throw new Error('Failed to get valid task_id from submitPreviewTaskByPath');
    }
    
    console.log('Preview task submitted:', { taskId, filePath });
    
    // Poll for task completion
    // Increased timeout for large files or slow operations
    let attempts = 0;
    const maxAttempts = 60; // 60 seconds timeout (increased from 10 seconds)
    const pollInterval = 1000; // 1 second
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      
      const status = await getTaskStatus(taskId);
      
      if (status.status === 'completed') {
        console.log('Preview task completed:', status);
        return status.result;
      } else if (status.status === 'error') {
        throw new Error(status.error || 'Preview generation failed');
      }
      
      attempts++;
    }
    
    throw new Error('Preview generation timeout after 60 seconds');
    
  } catch (error) {
    console.error('getPreviewAsync error:', error);
    throw error;
  }
};

// Submit preview task by file path
export const submitPreviewTaskByPath = async (filePath: string, previewType: string = 'all', size: number = 200, requestId?: string) => {
  try {
    // Generate unique request ID if not provided
    let finalRequestId = requestId;
    if (!finalRequestId) {
      const timestamp = Date.now();
      const randomId = Math.random().toString(36).substr(2, 9);
      const pathHash = shortHashFromString(filePath, 8);
      finalRequestId = `preview_path_${pathHash}_${timestamp}_${randomId}`;
    }
    
    console.log('API call - submitPreviewTaskByPath:', { filePath, previewType, size, requestId: finalRequestId });
    
    const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/thumbnail/v1/previews`, {
      method: 'POST',
      body: JSON.stringify({ file_path: filePath, preview_type: previewType, size: size, request_id: finalRequestId }),
      returnAxiosFormat: true,
    });
    
    if (response.status !== 200) {
      const errorData = response.data;
      throw new Error(errorData.error || 'Failed to submit preview task');
    }
    
    const result = response.data;
    console.log('Submit preview task by path response:', result);
    return result;
  } catch (error) {
    console.error('Error submitting preview task by path:', error);
    throw error;
  }
};