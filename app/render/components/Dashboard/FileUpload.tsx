import React, { useState, useCallback, useEffect } from 'react';
import { useDispatch } from 'react-redux';

import { uploadFile, createInstance } from '../../utils/file.service';
import { useInstanceCleanup } from '../../hooks/useInstanceCleanup';
import { addWSIInstance, updateInstanceWSIInfo } from '../../store/slices/wsiSlice';
import { setCurrentPath, setSlideInfo } from '../../store/slices/svsPathSlice';
import { setImageLoaded } from '../../store/slices/sidebarSlice';
import { message } from 'antd';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  onUploadComplete: (dimensions: any) => void;
  onInstanceCreated?: (instanceId: string) => void;
}

const FileUpload: React.FC<FileUploadProps> = ({ onFileSelect, onUploadComplete, onInstanceCreated }) => {
  const dispatch = useDispatch();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  
  // Use instance cleanup hook
  useInstanceCleanup();
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadInterrupted, setUploadInterrupted] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  const handleFileChange = (file: File) => {
    console.log('File selected:', file);
    setSelectedFile(file);
    setUploadError(null);
    setUploadProgress(0);
    setUploadInterrupted(false);
    onFileSelect(file);
  };

  const handleButtonClick = () => {
    const fileInput = document.getElementById('file-upload');
    if (fileInput) {
      (fileInput as HTMLInputElement).click();
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      setUploadStatus('Please select a file first.');
      return;
    }

    setIsUploading(true);
    setUploadStatus('Uploading...');
    setUploadError(null);
    setUploadProgress(0);
    setUploadInterrupted(false);

    // Create new AbortController for this upload
    const controller = new AbortController();
    setAbortController(controller);

    // Declare progressInterval outside try block so it's accessible in catch
    let progressInterval: NodeJS.Timeout | null = null;

    try {
      console.log('WSI file (single file):', selectedFile);

      // Simulate upload progress (since the actual API doesn't provide progress)
      progressInterval = setInterval(() => {
        setUploadProgress(prev => {
          if (prev >= 90) {
            if (progressInterval) {
              clearInterval(progressInterval);
            }
            return 90;
          }
          return prev + 10;
        });
      }, 500);

      const uploadData = await uploadFile(selectedFile);

      if (progressInterval) {
        clearInterval(progressInterval);
      }
      setUploadProgress(100);
      setUploadStatus('File uploaded successfully. Creating instance...');

      // Create instance for the uploaded file
      const instanceData = await createInstance(uploadData.filename);
      
      let fileInfo = {
        fileName: selectedFile.name,
        // @ts-ignore
        filePath: selectedFile.path
      };

      // Use instance data as WSI info
      const loadData = {
        dimensions: instanceData.dimensions,
        level_count: instanceData.level_count,
        total_tiles: instanceData.total_tiles,
        file_format: instanceData.file_format
      };

      // Create WSI instance with proper data
      dispatch(addWSIInstance({
        instanceId: instanceData.instanceId,
        wsiInfo: {
          ...loadData,
          instanceId: instanceData.instanceId
        },
        fileInfo: fileInfo
      }));
      
      dispatch(setImageLoaded(true));
      console.log('FileUpload: loadData:', loadData);
      console.log('FileUpload: fileInfo:', fileInfo);
      console.log('FileUpload: instanceId:', instanceData.instanceId);

      // Notify parent component about instance creation
      if (onInstanceCreated) {
        onInstanceCreated(instanceData.instanceId);
      }

      setUploadStatus('Slide loaded successfully.');
      message.success('File uploaded and loaded successfully!');
      
      onUploadComplete(loadData.dimensions);
    } catch (error: any) {
      if (progressInterval) {
        clearInterval(progressInterval);
      }
      console.error('Error:', error);
      
      // Check if it's an abort error
      if (error.name === 'AbortError' || error.message?.includes('cancelled')) {
        setUploadInterrupted(true);
        setUploadStatus('Upload was cancelled.');
        message.warning('Upload was cancelled.');
      } else {
        const errorMessage = error.message || 'An unknown error occurred';
        setUploadError(errorMessage);
        setUploadStatus(`Upload failed: ${errorMessage}`);
        message.error(`Upload failed: ${errorMessage}`);
      }
    } finally {
      if (progressInterval) {
        clearInterval(progressInterval);
      }
      setIsUploading(false);
      setAbortController(null);
    }
  };

  const handleCancelUpload = () => {
    if (abortController) {
      abortController.abort();
      setUploadInterrupted(true);
      setUploadStatus('Upload cancelled.');
      message.info('Upload cancelled.');
    }
  };

  const handleRetryUpload = () => {
    if (selectedFile) {
      setUploadError(null);
      setUploadProgress(0);
      setUploadInterrupted(false);
      handleUpload();
    }
  };

  const handleClearFile = () => {
    setSelectedFile(null);
    setUploadStatus('');
    setUploadError(null);
    setUploadProgress(0);
    setUploadInterrupted(false);
    setAbortController(null);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = () => {
    setDragging(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) {
      handleFileChange(file);
    }
  };

  const renderUploadProgress = () => {
    if (!isUploading && !uploadInterrupted) return null;

    return (
      <div className="mt-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-gray-600">Upload Progress</span>
          {isUploading && (
            <button
              onClick={handleCancelUpload}
              className="text-xs px-2 py-1 bg-red-500 text-white rounded hover:bg-red-600"
            >
              <X className="w-3 h-3 mr-1 inline" />
              Cancel
            </button>
          )}
        </div>
        
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div 
            className={`h-2 rounded-full transition-all duration-300 ${
              uploadInterrupted ? 'bg-yellow-500' : 
              uploadError ? 'bg-red-500' : 
              'bg-blue-500'
            }`}
            style={{ width: `${uploadProgress}%` }}
          />
        </div>
        
        <div className="flex justify-between text-xs text-gray-500 mt-1">
          <span>{uploadProgress}%</span>
          <span>{uploadStatus}</span>
        </div>
      </div>
    );
  };

  const renderInterruptionWarning = () => {
    if (!uploadInterrupted) return null;

    return (
      <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
        <div className="flex items-center gap-2 text-yellow-800">
          <AlertTriangle className="w-4 h-4" />
          <span className="text-sm font-medium">Upload Interrupted</span>
        </div>
        <p className="text-sm text-yellow-700 mt-1">
          The upload was interrupted. You can retry or select a different file.
        </p>
        <div className="flex gap-2 mt-2">
          <button
            onClick={handleRetryUpload}
            className="text-xs px-2 py-1 bg-yellow-500 text-white rounded hover:bg-yellow-600"
          >
            <RefreshCw className="w-3 h-3 mr-1 inline" />
            Retry Upload
          </button>
          <button
            onClick={handleClearFile}
            className="text-xs px-2 py-1 bg-gray-500 text-white rounded hover:bg-gray-600"
          >
            <X className="w-3 h-3 mr-1 inline" />
            Clear File
          </button>
        </div>
      </div>
    );
  };

  const renderErrorDisplay = () => {
    if (!uploadError) return null;

    return (
      <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg">
        <div className="flex items-center gap-2 text-red-800">
          <AlertTriangle className="w-4 h-4" />
          <span className="text-sm font-medium">Upload Error</span>
        </div>
        <p className="text-sm text-red-700 mt-1">{uploadError}</p>
        <div className="flex gap-2 mt-2">
          <button
            onClick={handleRetryUpload}
            className="text-xs px-2 py-1 bg-red-500 text-white rounded hover:bg-red-600"
          >
            <RefreshCw className="w-3 h-3 mr-1 inline" />
            Retry Upload
          </button>
          <button
            onClick={handleClearFile}
            className="text-xs px-2 py-1 bg-gray-500 text-white rounded hover:bg-gray-600"
          >
            <X className="w-3 h-3 mr-1 inline" />
            Clear File
          </button>
        </div>
      </div>
    );
  };

  return (
    <div>
      <input
        type="file"
        id="file-upload"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = e.target.files;
          if (files && files.length > 0) {
            handleFileChange(files[0]);
          }
        }}
        accept=".svs,.tif,.tiff,.ndpi,.btf,.jpg,.jpeg,.png,.bmp,.dcm,.nii,.czi,.isyntax,.qptiff"
      />
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          border: dragging ? '2px dashed #007bff' : '2px dashed #cccccc',
          padding: '20px',
          textAlign: 'center',
          marginBottom: '20px',
          borderRadius: '5px',
          backgroundColor: dragging ? '#e9f7ff' : '#ffffff',
        }}
      >
        {selectedFile ? (
          <div>
            <p className="mb-2">Selected file: {selectedFile.name}</p>
            <div className="flex gap-2 justify-center">
              <button
                onClick={handleUpload}
                disabled={isUploading}
                className="px-3 py-1 bg-green-500 text-white rounded hover:bg-green-600 disabled:bg-gray-400"
              >
                {isUploading ? <span className="animate-spin">⟳</span> : 'Upload'}
              </button>
              {!isUploading && (
                <button
                  onClick={handleClearFile}
                  className="px-3 py-1 bg-gray-500 text-white rounded hover:bg-gray-600"
                >
                  <X className="w-4 h-4 mr-1 inline" />
                  Clear
                </button>
              )}
            </div>
          </div>
        ) : (
          <p>
            Drag & drop a file here, or{' '}
            <span style={{ textDecoration: 'underline', cursor: 'pointer' }} onClick={handleButtonClick}>
              browse
            </span>{' '}
            to select a file.
          </p>
        )}
      </div>

      {renderUploadProgress()}
      {renderInterruptionWarning()}
      {renderErrorDisplay()}
      
      {uploadStatus && !isUploading && !uploadInterrupted && !uploadError && (
        <p className="text-sm text-gray-600 mt-2">{uploadStatus}</p>
      )}
    </div>
  );
};

export default FileUpload;
