import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { 
  UploadCloud, 
  X, 
  CheckCircle2, 
  AlertTriangle,
  Minimize2,
  Maximize2
} from 'lucide-react';

// Upload status types
type UploadStatus = 'Uploading' | 'Completed' | 'Error' | 'Cancelled' | 'Paused';

// File upload status interface
interface FileUploadStatus {
  progress: number;
  status: UploadStatus;
  error?: string;
  uploadTime?: number;
  estimatedTimeRemaining?: number;
  retryCount?: number;
  startTime?: number;
  fileSize?: number;
  fileName?: string;
}

// Upload dialog props
interface UploadDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onUpload: (files: FileList) => void;
  isUploading: boolean;
  uploadProgress: number;
  uploadStatus?: Map<string, FileUploadStatus>;
  onCancelChunkedUpload?: (fileId: string) => void;
  onPauseChunkedUpload?: (fileId: string) => void;
  onResumeChunkedUpload?: (fileId: string) => void;
  onCancelAllUploads?: () => void;
  uploadInterrupted?: boolean;
  hideFileSelection?: boolean; // when true, do not show drag/select area
}

export const UploadDialog: React.FC<UploadDialogProps> = ({
  isOpen,
  onClose,
  onUpload,
  isUploading,
  uploadProgress,
  uploadStatus,
  onCancelChunkedUpload,
  onCancelAllUploads,
  uploadInterrupted,
  hideFileSelection
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);

  // Handle dialog close
  const handleClose = () => {
    if (isUploading && uploadStatus) {
      const ongoingUploads = Array.from(uploadStatus.entries())
        .filter(([_, status]) => status.status === 'Uploading' || status.status === 'Paused');
      
      if (ongoingUploads.length > 0) {
        if (onCancelAllUploads) {
          onCancelAllUploads();
        }
      }
    }
    
    onClose();
  };

  // Handle minimize
  const handleMinimize = () => {
    setIsMinimized(true);
  };

  // Handle maximize
  const handleMaximize = () => {
    setIsMinimized(false);
  };

  // File selection handlers
  const handleFileSelect = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    onUpload(files);
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    handleFileSelect(e.dataTransfer.files);
  };

  // Format file size
  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  // Render minimized upload progress (bottom-right corner)
  if (isMinimized && isUploading) {
    return (
      <div className="fixed bottom-4 right-4 z-50 bg-white border border-gray-200 rounded-lg shadow-xl p-4 min-w-[320px] backdrop-blur-sm bg-white/95">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <UploadCloud className="h-4 w-4 text-blue-500" />
            <h3 className="text-sm font-medium text-gray-700">Upload Progress</h3>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleMaximize}
              className="p-1.5 hover:bg-gray-100 rounded transition-colors"
              title="Maximize"
            >
              <Maximize2 className="h-4 w-4 text-gray-600" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-gray-100 rounded transition-colors"
              title="Close"
            >
              <X className="h-4 w-4 text-gray-600" />
            </button>
          </div>
        </div>
        
        {uploadProgress === 100 ? (
          (() => {
            const hasIncompleteUploads = uploadStatus && Array.from(uploadStatus.values()).some(
              status => status.status === 'Uploading' || status.status === 'Paused' || status.status === 'Error'
            );
            
            if (hasIncompleteUploads) {
              return (
                <div className="flex items-center gap-2 text-yellow-600 bg-yellow-50 p-2 rounded">
                  <AlertTriangle className="h-4 w-4" />
                  <span className="text-xs font-medium">Upload in progress</span>
                </div>
              );
            }
            
            return (
              <div className="flex items-center gap-2 text-green-600 bg-green-50 p-2 rounded">
                <CheckCircle2 className="h-4 w-4" />
                <span className="text-xs font-medium">Upload complete!</span>
              </div>
            );
          })()
        ) : (
          <div className="space-y-2">
            <Progress value={uploadProgress} className="w-full h-2" />
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-600">Uploading...</p>
              <p className="text-xs font-medium text-gray-700">{uploadProgress.toFixed(0)}%</p>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Render upload progress (Google Drive style)
  const renderUploadProgress = () => {
    if (!isUploading) return null;

    return (
      <div className="space-y-4">
        {/* Simple Progress Bar */}
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-600">Uploading files...</span>
            <span className="font-medium text-gray-900">{uploadProgress.toFixed(0)}%</span>
          </div>
          <Progress value={uploadProgress} className="w-full h-2" />
        </div>

        {/* Simple File List - Google Drive style */}
        {uploadStatus && uploadStatus.size > 0 && (
          <div className="space-y-2">
            {Array.from(uploadStatus.entries())
              .filter(([_, status]) => status.status !== 'Cancelled') // Filter out cancelled files
              .map(([fileId, status]) => (
                <div key={fileId} className="flex items-center gap-3 p-2 rounded-lg bg-gray-50">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-900 break-words leading-tight" style={{ wordBreak: 'break-word' }}>
                        {status.fileName || 'Unknown file'}
                      </span>
                      <span className="text-xs text-gray-500">
                        {status.fileSize && formatFileSize(status.fileSize)}
                      </span>
                    </div>
                    
                    {status.status === 'Uploading' && (
                      <div className="mt-1">
                        <div className="flex items-center justify-between text-xs text-gray-500">
                          <span>{status.progress.toFixed(0)}%</span>
                          <span>{status.status}</span>
                        </div>
                      </div>
                    )}
                    
                    {status.status === 'Completed' && (
                      <div className="mt-1 text-xs text-green-600">
                        ✓ Completed
                      </div>
                    )}
                    
                    {status.status === 'Error' && (
                      <div className="mt-1 text-xs text-red-600">
                        ✗ {status.error || 'Upload failed'}
                      </div>
                    )}
                  </div>
                  
                  {/* Minimal Action Buttons */}
                  {status.status === 'Uploading' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onCancelChunkedUpload?.(fileId)}
                      className="h-6 w-6 p-0 text-gray-400 hover:text-red-600"
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  )}
                </div>
              ))}
          </div>
        )}
      </div>
    );
  };

  // Render upload completion (Google Drive style)
  const renderUploadCompletion = () => {
    if (!isUploading || uploadProgress !== 100) return null;
    
    if (!uploadStatus) return null;
    
    const hasIncompleteUploads = Array.from(uploadStatus.values()).some(
      status => status.status === 'Uploading' || status.status === 'Paused' || status.status === 'Error'
    );
    
    if (hasIncompleteUploads) return null;
    
    return (
      <div className="text-center py-8">
        <CheckCircle2 className="mx-auto h-12 w-12 text-green-500 mb-3" />
        <h3 className="text-lg font-medium text-gray-900 mb-2">Upload complete!</h3>
        <p className="text-sm text-gray-600 mb-4">Your files have been uploaded successfully.</p>
        <Button onClick={handleMinimize} className="bg-green-600 hover:bg-green-700">
          Minimize
        </Button>
      </div>
    );
  };

  // Render file selection area (Google Drive style)
  const renderFileSelection = () => {
    if (isUploading) return null;
    if (hideFileSelection) return null;

    return (
      <div
        className={`relative border-2 border-dashed rounded-xl p-12 pb-16 text-center transition-all duration-200
          ${isDragging 
            ? 'border-blue-500 bg-blue-50' 
            : 'border-gray-300 hover:border-gray-400 hover:bg-gray-50'
          }`
        }
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <UploadCloud className={`mx-auto h-16 w-16 mb-4 transition-colors ${
          isDragging ? 'text-blue-500' : 'text-gray-400'
        }`} />
        
        <h3 className="text-xl font-medium text-gray-900 mb-2">
          {isDragging ? 'Drop files here' : 'Upload files'}
        </h3>
        
        <p className="text-gray-600 mb-6">
          {isDragging 
            ? 'Release to upload your files'
            : 'Drag and drop files here, or click to select files'
          }
        </p>
        
        <input
          id="file-upload-input"
          type="file"
          multiple
          className="hidden"
          onChange={(e) => handleFileSelect(e.target.files)}
        />
        
        <Button 
          onClick={() => document.getElementById('file-upload-input')?.click()}
          className="bg-blue-600 hover:bg-blue-700 px-6 py-2"
        >
          Select files
        </Button>
      </div>
    );
  };

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div 
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={handleClose}
          />
          
          {/* Dialog Content */}
          <div className="relative bg-white rounded-lg shadow-xl max-w-md max-h-[85vh] overflow-hidden w-full mx-4">
            {/* Header */}
            <div className="flex items-center justify-between p-6 pb-4">
              <h2 className="text-lg font-semibold">Upload files</h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={isUploading ? handleMinimize : handleClose}
                className="h-8 w-8 p-0"
                title={isUploading ? "Minimize" : "Close"}
              >
                {isUploading ? <Minimize2 className="h-4 w-4" /> : <X className="h-4 w-4" />}
              </Button>
            </div>

            {/* Interruption Warning */}
            {uploadInterrupted && (
              <div className="mx-6 mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                <div className="flex items-center gap-2 text-yellow-800">
                  <AlertTriangle className="w-4 h-4" />
                  <span className="text-sm">Upload interrupted</span>
                </div>
              </div>
            )}

            {/* Content */}
            <div className="px-6 pb-6 overflow-y-auto">
              {renderUploadCompletion()}
              {renderUploadProgress()}
              {renderFileSelection()}
            </div>
          </div>
        </div>
      )}
    </>
  );
};