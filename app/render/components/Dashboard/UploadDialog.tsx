import React, { useState, useCallback } from 'react';
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

// Extended File type with relative path info for folder uploads
export interface FileWithPath extends File {
  _relativePath?: string;
}

// Upload dialog props
interface UploadDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onUpload: (files: FileList, relativePaths?: string[]) => void;
  isUploading: boolean;
  uploadProgress: number;
  uploadTotalFiles?: number;
  uploadStatus?: Map<string, FileUploadStatus>;
  onCancelChunkedUpload?: (fileId: string) => void;
  onPauseChunkedUpload?: (fileId: string) => void;
  onResumeChunkedUpload?: (fileId: string) => void;
  onCancelAllUploads?: () => void;
  uploadInterrupted?: boolean;
  hideFileSelection?: boolean; // when true, do not show drag/select area
  /** Called whenever the dialog's minimized state changes (true = minimized to widget). */
  onMinimizedChange?: (isMinimized: boolean) => void;
  /** When true, show a brief "upload complete" notice above the file-selection area. */
  uploadJustCompleted?: boolean;
}

export const UploadDialog: React.FC<UploadDialogProps> = ({
  isOpen,
  onClose,
  onUpload,
  isUploading,
  uploadProgress,
  uploadTotalFiles = 0,
  uploadStatus,
  onCancelChunkedUpload,
  onCancelAllUploads,
  uploadInterrupted,
  hideFileSelection,
  onMinimizedChange,
  uploadJustCompleted,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isProcessingDrop, setIsProcessingDrop] = useState(false);

  // Reset minimized state whenever the dialog is closed so the next time it
  // opens it starts in the normal (expanded) view, not still minimized.
  // Also notify the parent so it can reset its isDialogMinimizedRef.
  React.useEffect(() => {
    if (!isOpen) {
      setIsMinimized(false);
      onMinimizedChange?.(false);
    }
  }, [isOpen]);

  // Recursively read all files from a dropped directory entry
  const readDirectoryEntries = useCallback(async (
    dirEntry: FileSystemDirectoryEntry,
    basePath: string
  ): Promise<{ file: File; relativePath: string }[]> => {
    const results: { file: File; relativePath: string }[] = [];
    const reader = dirEntry.createReader();

    // Must call readEntries in a loop — Chrome returns max 100 per call
    const readBatch = (): Promise<FileSystemEntry[]> =>
      new Promise((resolve, reject) => reader.readEntries(resolve, reject));

    let batch: FileSystemEntry[];
    do {
      batch = await readBatch();
      for (const entry of batch) {
        const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;
        if (entry.isFile) {
          const fileEntry = entry as FileSystemFileEntry;
          const file = await new Promise<File>((resolve, reject) =>
            fileEntry.file(resolve, reject)
          );
          results.push({ file, relativePath: entryPath });
        } else if (entry.isDirectory) {
          const subResults = await readDirectoryEntries(
            entry as FileSystemDirectoryEntry,
            entryPath
          );
          results.push(...subResults);
        }
      }
    } while (batch.length > 0);

    return results;
  }, []);

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
    onMinimizedChange?.(true);
  };

  // Handle maximize
  const handleMaximize = () => {
    setIsMinimized(false);
    onMinimizedChange?.(false);
  };

  // File selection handlers
  const handleFileSelect = (files: FileList | null, relativePaths?: string[]) => {
    if (!files || files.length === 0) return;
    onUpload(files, relativePaths);
    // Reset input so the same files can be re-selected
    const input = document.getElementById('file-upload-input') as HTMLInputElement;
    if (input) input.value = '';
  };

  // Handle folder selection via webkitdirectory input
  const handleFolderSelect = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const relativePaths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      // webkitRelativePath gives us the path like "folderName/sub/file.txt"
      relativePaths.push(files[i].webkitRelativePath || files[i].name);
    }
    onUpload(files, relativePaths);
    // Reset input so the same folder can be re-selected
    const input = document.getElementById('folder-upload-input') as HTMLInputElement;
    if (input) input.value = '';
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

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const items = e.dataTransfer.items;
    if (!items || items.length === 0) {
      handleFileSelect(e.dataTransfer.files);
      return;
    }

    // Check if any dropped item is a directory
    const entries: FileSystemEntry[] = [];
    let hasDirectory = false;
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.();
      if (entry) {
        entries.push(entry);
        if (entry.isDirectory) hasDirectory = true;
      }
    }

    if (!hasDirectory) {
      // No directories — use simple file upload
      handleFileSelect(e.dataTransfer.files);
      return;
    }

    // Has directories — recursively enumerate all files
    setIsProcessingDrop(true);
    try {
      const allFiles: { file: File; relativePath: string }[] = [];
      for (const entry of entries) {
        if (entry.isFile) {
          const fileEntry = entry as FileSystemFileEntry;
          const file = await new Promise<File>((resolve, reject) =>
            fileEntry.file(resolve, reject)
          );
          allFiles.push({ file, relativePath: file.name });
        } else if (entry.isDirectory) {
          const dirFiles = await readDirectoryEntries(
            entry as FileSystemDirectoryEntry,
            entry.name
          );
          allFiles.push(...dirFiles);
        }
      }

      if (allFiles.length === 0) return;

      // Create a DataTransfer to build a FileList
      const dt = new DataTransfer();
      const relativePaths: string[] = [];
      for (const { file, relativePath } of allFiles) {
        // Skip zero-byte files (empty files / directory entries)
        if (file.size === 0) continue;
        dt.items.add(file);
        relativePaths.push(relativePath);
      }

      if (dt.files.length > 0) {
        onUpload(dt.files, relativePaths);
      }
    } catch (err) {
      console.error('Error processing dropped folder:', err);
      // Fallback to simple file upload
      handleFileSelect(e.dataTransfer.files);
    } finally {
      setIsProcessingDrop(false);
    }
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
  // IMPORTANT: Do NOT return early - render minimized widget alongside the full dialog (hidden).
  // Returning early unmounts the full dialog and can cause upload to pause (e.g. browser throttling
  // when component tree changes). Keeping both in DOM ensures upload continues in background.
  const renderMinimizedWidget = () => {
    if (!isMinimized || !isOpen) return null;
    return (
      <div className="fixed bottom-4 right-4 z-[60] bg-card border border-border rounded-lg shadow-xl p-4 min-w-[320px] backdrop-blur-sm bg-card/95">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <UploadCloud className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-medium text-foreground">Upload Progress</h3>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleMaximize}
              className="p-1.5 hover:bg-muted rounded transition-colors"
              title="Maximize"
            >
              <Maximize2 className="h-4 w-4 text-muted-foreground" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-muted rounded transition-colors"
              title="Close"
            >
              <X className="h-4 w-4 text-muted-foreground" />
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
                <div className="flex items-center gap-2 text-foreground bg-muted p-2 rounded">
                  <AlertTriangle className="h-4 w-4" />
                  <span className="text-xs font-medium">Upload in progress</span>
                </div>
              );
            }
            
            return (
              <div className="flex items-center gap-2 text-foreground bg-muted p-2 rounded">
                <CheckCircle2 className="h-4 w-4" />
                <span className="text-xs font-medium">Upload complete!</span>
              </div>
            );
          })()
        ) : (
          <div className="space-y-2">
            <Progress value={uploadProgress} className="w-full h-2" />
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Uploading...</p>
              <p className="text-xs font-medium text-foreground">{uploadProgress.toFixed(0)}%</p>
            </div>
          </div>
        )}
      </div>
    );
  };

 
  // isUploading=false (which takes a moment after the last cancel resolves).
  const hasActiveItems = uploadStatus && uploadStatus.size > 0
    ? Array.from(uploadStatus.values()).some(
        s => s.status !== 'Cancelled' && s.status !== 'Error' && s.status !== 'Completed'
      )
    : isUploading; // no status entries yet → rely on isUploading flag

  // Render upload progress (Google Drive style)
  const renderUploadProgress = () => {
    if (!isUploading || !hasActiveItems) return null;

    // Compute counts directly from uploadStatus so the label updates in real-time
    // when individual files are cancelled (uploadTotalFiles in Redux is fixed at
    // upload-start and never decreases, so it can't be used as the denominator).
    const completedCount = uploadStatus
      ? Array.from(uploadStatus.values()).filter(s => s.status === 'Completed').length
      : 0;
    const activeCount = uploadStatus
      ? Array.from(uploadStatus.values()).filter(s => s.status !== 'Cancelled').length
      : (uploadTotalFiles > 0 ? uploadTotalFiles : 0);

    return (
      <div className="space-y-4">
        {/* Overall Progress Bar */}
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {activeCount > 0
                ? `Uploading ${completedCount} of ${activeCount} files`
                : 'Uploading files...'}
            </span>
            <span className="font-medium text-foreground">{uploadProgress.toFixed(0)}%</span>
          </div>
          <Progress value={uploadProgress} className="w-full h-2" />
        </div>

        {/* Per-file list - Google Drive style, scrollable */}
        {uploadStatus && uploadStatus.size > 0 && (
          <div className="space-y-2 max-h-[360px] overflow-y-auto overflow-x-hidden pr-1">
            {Array.from(uploadStatus.entries())
              .filter(([_, status]) => status.status !== 'Cancelled')
              .map(([fileId, status]) => (
                <div key={fileId} className="flex items-center gap-3 p-2 rounded-lg bg-muted/50 flex-shrink-0">
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className="text-sm text-foreground break-all leading-tight"
                        title={status.fileName || 'Unknown file'}
                      >
                        {status.fileName || 'Unknown file'}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {status.fileSize && formatFileSize(status.fileSize)}
                      </span>
                    </div>

                    {/* Per-file progress bar (chunk-weighted, shown while uploading) */}
                    {status.status === 'Uploading' && (
                      <div className="mt-1.5 space-y-0.5">
                        <Progress value={status.progress} className="w-full h-1.5" />
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>{status.progress.toFixed(0)}%</span>
                          <span>Uploading</span>
                        </div>
                      </div>
                    )}

                    {status.status === 'Paused' && (
                      <div className="mt-1.5 space-y-0.5">
                        <Progress value={status.progress} className="w-full h-1.5" />
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>{status.progress.toFixed(0)}%</span>
                          <span>Paused</span>
                        </div>
                      </div>
                    )}
                    
                    {status.status === 'Completed' && (
                      <div className="mt-1 text-xs text-foreground">
                        ✓ Completed
                      </div>
                    )}
                    
                    {status.status === 'Error' && (
                      <div className="mt-1 text-xs text-destructive">
                        ✗ {status.error || 'Upload failed'}
                      </div>
                    )}
                  </div>
                  
                  {/* Cancel button for active uploads */}
                  {(status.status === 'Uploading' || status.status === 'Paused') && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onCancelChunkedUpload?.(fileId)}
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive flex-shrink-0"
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
        <CheckCircle2 className="mx-auto h-12 w-12 text-foreground mb-3" />
        <h3 className="text-lg font-medium text-foreground mb-2">Upload complete!</h3>
        <p className="text-sm text-muted-foreground mb-4">Your files have been uploaded successfully.</p>
        <Button onClick={handleMinimize}>
          Minimize
        </Button>
      </div>
    );
  };

  // Render file selection area (Google Drive style)
  const renderFileSelection = () => {
    // Show immediately when all files have been cancelled/finished,
    // even if isUploading is still true in the background.
    if (isUploading && hasActiveItems) return null;
    if (hideFileSelection) return null;

    return (
      <>
        {/* Completion notice — only shown right after an upload finishes */}
        {uploadJustCompleted && (
          <div className="mb-4 flex items-center gap-2 px-4 py-3 rounded-lg bg-muted border border-border text-foreground text-sm">
            <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-primary" />
            <span>Upload complete</span>
          </div>
        )}
      <div
        className={`relative border-2 border-dashed rounded-xl p-12 pb-16 text-center transition-all duration-200
          ${isDragging 
            ? 'border-primary bg-primary/10' 
            : 'border-border hover:border-border hover:bg-muted/50'
          }`
        }
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <UploadCloud className={`mx-auto h-16 w-16 mb-4 transition-colors ${
          isDragging ? 'text-primary' : 'text-muted-foreground'
        }`} />
        
        <h3 className="text-xl font-medium text-foreground mb-2">
          {isProcessingDrop ? 'Processing folder...' : isDragging ? 'Drop files or folders here' : 'Upload files or folders'}
        </h3>

        <p className="text-muted-foreground mb-6">
          {isProcessingDrop
            ? 'Reading folder contents...'
            : isDragging
            ? 'Release to upload your files or folders'
            : 'Drag and drop files or folders here, or click to select'
          }
        </p>

        <input
          id="file-upload-input"
          type="file"
          multiple
          className="hidden"
          onChange={(e) => handleFileSelect(e.target.files)}
        />

        {/* Hidden input for folder selection via webkitdirectory */}
        <input
          id="folder-upload-input"
          type="file"
          // @ts-ignore — webkitdirectory is not in React's type definitions
          webkitdirectory=""
          multiple
          className="hidden"
          onChange={(e) => handleFolderSelect(e.target.files)}
        />

        <div className="flex justify-center gap-3">
          <Button
            className="min-w-[120px]"
            onClick={() => document.getElementById('file-upload-input')?.click()}
          >
            Select files
          </Button>
          <Button
            className="min-w-[120px]"
            variant="outline"
            onClick={() => document.getElementById('folder-upload-input')?.click()}
          >
            Select folder
          </Button>
        </div>
      </div>
      </>
    );
  };

  return (
    <>
      {renderMinimizedWidget()}
      {/* When minimized, NEVER render the full overlay regardless of isUploading state.
          Previously !(isMinimized && isUploading) allowed the overlay to flash in for
          one render when isUploading flipped to false before isOpen was closed. */}
      {isOpen && !isMinimized && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop — minimize (not cancel) when an upload is in progress */}
          <div 
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
            onClick={isUploading ? handleMinimize : handleClose}
          />
          
          {/* Dialog Content - flex layout for scrollable content */}
          <div className="relative bg-card rounded-lg shadow-xl max-w-md max-h-[85vh] overflow-hidden w-full mx-4 border border-border flex flex-col">
            {/* Header */}
            <div className="flex-shrink-0 flex items-center justify-between p-6 pb-4">
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
              <div className="flex-shrink-0 mx-6 mb-4 p-3 bg-muted border border-border rounded-lg">
                <div className="flex items-center gap-2 text-foreground">
                  <AlertTriangle className="w-4 h-4" />
                  <span className="text-sm">Upload interrupted</span>
                </div>
              </div>
            )}

            {/* Content - flex-1 min-h-0 enables overflow scroll */}
            <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
              {renderUploadProgress()}
              {renderFileSelection()}
            </div>
          </div>
        </div>
      )}
    </>
  );
};