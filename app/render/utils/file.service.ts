import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import { apiFetch } from './apiFetch';
import { shortHashFromString } from '@/utils/string.utils';
import http from './http';

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

export const createInstance = async (filePath: string): Promise<CreateInstanceResponse> => {
  try {
    console.log('Creating instance for file:', filePath);
    
    const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/load/v1/create_instance`, {
      file_path: filePath
    });

    const data = response.data;
    console.log('Create instance response:', data);
    
    // Check if the response indicates an error
    if (data.code && data.code !== 0) {
      throw new Error(data.message || 'Failed to create instance');
    }

    if (response.status !== 200) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const result = data.data || data;
    console.log('Processed result:', result);
    console.log('InstanceId in result:', result.instanceId);
    
    // Validate that instanceId is present
    if (!result.instanceId) {
      throw new Error('No instanceId returned from server');
    }
    
    return result;
  } catch (error) {
    console.error('Error creating instance:', error);
    throw error;
  }
};

export const deleteInstance = async (instanceId: string): Promise<void> => {
  try {
    const response = await http.delete(`${AI_SERVICE_API_ENDPOINT}/load/v1/delete_instance`, {
      data: { instance_id: instanceId }
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
  console.log('[uploadFilePath]: responseJson:', responseJson);
  return (responseJson as any).data || responseJson;
};

export const loadFileData = async (filename: string) => {
  const response = await http.get(`${AI_SERVICE_API_ENDPOINT}/load/v1/load/${filename}/`);
  if (response.status !== 200) {
    throw new Error('Failed to load slide');
  }
  console.log('loadFileData: response:', response);

  const responseJson = response.data;
  console.log('Full response JSON:', responseJson);

  // check if the data is in the data field or directly in the root level
  let data: any = {};
  if (responseJson.data && Object.keys(responseJson.data).length > 0) {
    console.log('Using data from responseJson.data');
    data = responseJson.data;
  } else {
    console.log('Data not found in responseJson.data, using root level');
    data = responseJson;
  }

  // print the full data structure for debugging
  console.log('Using data structure:', JSON.stringify(data, null, 2));

  // handle dimensions (ensure it is a nested array format)
  if (data.dimensions) {
    console.log('Found dimensions:', data.dimensions);
    if (!Array.isArray(data.dimensions[0])) {
      console.log('Converting dimensions to nested array:', data.dimensions);
      data.dimensions = [data.dimensions];
    }
  } else {
    console.warn('No dimensions found in data, checking alternatives');
    // try to find dimensions in other possible locations
    if (responseJson.dimensions) {
      console.log('Found dimensions in root level:', responseJson.dimensions);
      data.dimensions = Array.isArray(responseJson.dimensions[0])
        ? responseJson.dimensions
        : [responseJson.dimensions];
    } else if (data.slideInfo && data.slideInfo.dimensions) {
      console.log('Found dimensions in slideInfo:', data.slideInfo.dimensions);
      data.dimensions = [data.slideInfo.dimensions];
    } else {
      console.warn('Could not find dimensions, using defaults');
      // set default values to avoid errors
      data.dimensions = [[11952, 12145]]; // use the values observed in the data
    }
  }

  // handle pyramid info
  if (data.level_dimensions && Array.isArray(data.level_dimensions)) {
    console.log('Using level_dimensions for pyramid info:', data.level_dimensions);
    data.pyramid = data.level_dimensions;
  } else if (data.pyramid_info && Array.isArray(data.pyramid_info)) {
    console.log('Using pyramid_info for pyramid structure:', data.pyramid_info);
    try {
      data.pyramid = data.pyramid_info.map((level: any) => level.dimensions);
      console.log('Created pyramid from pyramid_info:', data.pyramid);
    } catch (error) {
      console.error('Error mapping pyramid_info:', error);
    }
  } else {
    console.warn('No pyramid info found, creating minimal pyramid');
    // create a basic pyramid structure (only the top level)
    data.pyramid = [data.dimensions[0]];
  }

  // calculate the number of levels (level_count)
  if (!data.level_count && data.pyramid) {
    data.level_count = data.pyramid.length;
    console.log(`Set level_count to ${data.level_count} based on pyramid length`);
  }

  // add necessary OpenSeadragon configuration information
  data.tileSize = 1024; // default tile size
  data.tileOverlap = data.tileOverlap || 0;
  data.minLevel = data.minLevel || 0;
  data.maxLevel = data.maxLevel || (data.level_count ? data.level_count - 1 : 0);

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
    const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/seg/v1/reset`);

    if (response.status !== 200) {
      const errorData = response.data;
      throw new Error(errorData.error || 'Reset segmentation data failed');
    }

    const responseJson = response.data;
    console.log('Reset segmentation data response:', responseJson);
    return responseJson.data || responseJson;
  } catch (error) {
    console.error('Error resetting segmentation data:', error);
    throw error;
  }
};


// New function for batch thumbnail generation
export const generateBatchThumbnails = async (sessionIds: string[], size: number = 200) => {
  try {
    console.log('API call - generateBatchThumbnails:', { sessionIds, size });
    
    const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/load/v1/batch/thumbnails`, {
      session_ids: sessionIds,
      size: size
    });
    
    if (response.status !== 200) {
      const errorData = response.data;
      throw new Error(errorData.error || 'Failed to generate batch thumbnails');
    }
    
    const result = response.data;
    console.log('Batch thumbnails response:', result);
    return result.data || result;
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
    
    const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/load/v1/batch/previews`, {
      requests: requests
    });
    
    if (response.status !== 200) {
      const errorData = response.data;
      throw new Error(errorData.error || 'Failed to generate batch previews');
    }
    
    const result = response.data;
    console.log('Batch previews response:', result);
    return result.data || result;
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
    
    const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/v1/celery/thumbnails`, {
      session_id: sessionId,
      size: size,
      request_id: requestId
    });
    
    if (response.status !== 200) {
      const errorData = response.data;
      throw new Error(errorData.error || 'Failed to submit thumbnail task');
    }
    
    const result = response.data;
    console.log('Submit thumbnail task response:', result);
    return result.data || result;
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
    
    const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/v1/celery/previews`, {
      session_id: sessionId,
      preview_type: previewType,
      size: size,
      request_id: requestId
    });
    
    if (response.status !== 200) {
      const errorData = response.data;
      throw new Error(errorData.error || 'Failed to submit preview task');
    }
    
    const result = response.data;
    console.log('Submit preview task response:', result);
    return result.data || result;
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
    
    const response = await http.get(`${AI_SERVICE_API_ENDPOINT}/v1/celery/status/${taskId}`);
    
    if (response.status !== 200) {
      const errorData = response.data;
      throw new Error(errorData.error || 'Failed to get task status');
    }
    
    const result = response.data;
    console.log('Get task status response:', result);
    return result.data || result;
  } catch (error) {
    console.error('Error getting task status:', error);
    throw error;
  }
};

export const submitBatchThumbnailTasks = async (sessionIds: string[], size: number = 200) => {
  try {
    console.log('API call - submitBatchThumbnailTasks:', { sessionIds, size });
    
    const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/v1/celery/batch/thumbnails`, {
      session_ids: sessionIds,
      size: size
    });
    
    if (response.status !== 200) {
      const errorData = response.data;
      throw new Error(errorData.error || 'Failed to submit batch thumbnail tasks');
    }
    
    const result = response.data;
    console.log('Submit batch thumbnail tasks response:', result);
    return result.data || result;
  } catch (error) {
    console.error('Error submitting batch thumbnail tasks:', error);
    throw error;
  }
};

export const submitBatchPreviewTasks = async (requests: Array<{session_id: string, preview_type: string, size?: number}>) => {
  try {
    console.log('API call - submitBatchPreviewTasks:', { requests });
    
    const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/v1/celery/batch/previews`, {
      requests: requests
    });
    
    if (response.status !== 200) {
      const errorData = response.data;
      throw new Error(errorData.error || 'Failed to submit batch preview tasks');
    }
    
    const result = response.data;
    console.log('Submit batch preview tasks response:', result);
    return result.data || result;
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
    let attempts = 0;
    const maxAttempts = 10; // 30 seconds timeout
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
    
    throw new Error('Preview generation timeout');
    
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
    
    const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/v1/celery/previews`, {
      file_path: filePath,
      preview_type: previewType,
      size: size,
      request_id: finalRequestId
    });
    
    if (response.status !== 200) {
      const errorData = response.data;
      throw new Error(errorData.error || 'Failed to submit preview task');
    }
    
    const result = response.data;
    console.log('Submit preview task by path response:', result);
    return result.data || result;
  } catch (error) {
    console.error('Error submitting preview task by path:', error);
    throw error;
  }
};