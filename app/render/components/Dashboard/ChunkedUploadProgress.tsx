import React from 'react';
import { Card, Progress, Space, Button, Tag } from 'antd';
import { 
  PauseOutlined, 
  PlayCircleOutlined, 
  CloseOutlined,
  ExclamationCircleOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined
} from '@ant-design/icons';

interface UploadStatus {
  progress: number;
  status: 'Uploading' | 'Paused' | 'Completed' | 'Error' | 'Cancelled';
  error?: string;
  uploadTime?: number;
  estimatedTimeRemaining?: number;
  retryCount?: number;
  startTime?: number;
  fileSize?: number;
  fileName?: string; // Added for saving the full file name
}

interface ChunkedUploadProgressProps {
  uploadStatus: Map<string, UploadStatus>;
  onCancel: (fileId: string) => void;
  onPause?: (fileId: string) => void;
  onResume?: (fileId: string) => void;
}

const ChunkedUploadProgress: React.FC<ChunkedUploadProgressProps> = ({
  uploadStatus,
  onCancel,
  onPause,
  onResume
}) => {
  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatTime = (milliseconds: number): string => {
    if (milliseconds < 0) return '--';
    
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'Completed': return 'success';
      case 'Error': return 'error';
      case 'Cancelled': return 'default';
      case 'Paused': return 'warning';
      case 'Uploading': return 'processing';
      default: return 'default';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Completed': return <CheckCircleOutlined />;
      case 'Error': return <ExclamationCircleOutlined />;
      case 'Cancelled': return <CloseOutlined />;
      case 'Paused': return <ClockCircleOutlined />;
      case 'Uploading': return <PlayCircleOutlined />;
      default: return null;
    }
  };

  const renderActionButtons = (fileId: string, status: UploadStatus) => {
    const buttons = [];

    // Pause/Resume buttons
    if (status.status === 'Uploading' && onPause) {
      buttons.push(
        <Button 
          key="pause"
          type="text" 
          size="small" 
          icon={<PauseOutlined />}
          onClick={() => onPause(fileId)}
          title="Pause upload"
        />
      );
    }
    
    if (status.status === 'Paused' && onResume) {
      buttons.push(
        <Button 
          key="resume"
          type="text" 
          size="small" 
          icon={<PlayCircleOutlined />}
          onClick={() => onResume(fileId)}
          title="Resume upload"
        />
      );
    }

    // Cancel button (always available)
    buttons.push(
      <Button 
        key="cancel"
        type="text" 
        size="small" 
        icon={<CloseOutlined />}
        onClick={() => onCancel(fileId)}
        danger={status.status === 'Uploading' || status.status === 'Paused'}
        title={status.status === 'Completed' ? 'Remove from list' : 'Cancel upload'}
      />
    );

    // Cleanup button for completed/failed uploads - removed as requested
    // if ((status.status === 'Completed' || status.status === 'Error' || status.status === 'Cancelled') && onCleanup) {
    //   buttons.push(
    //     <Button 
    //       key="cleanup"
    //       type="text" 
    //       size="small" 
    //       icon={<CloseOutlined />}
    //       onClick={() => onCleanup(fileId)}
    //       title="Clean up temporary files"
    //     />
    //   );
    // }

    return buttons;
  };

  const renderProgressInfo = (status: UploadStatus) => {
    const info = [];

    // Upload time
    if (status.uploadTime !== undefined) {
      info.push(
        <span key="time" className="text-xs text-gray-500">
          Time: {formatTime(status.uploadTime)}
        </span>
      );
    }

    // Estimated time remaining
    if (status.estimatedTimeRemaining !== undefined && status.status === 'Uploading' && status.estimatedTimeRemaining > 0) {
      info.push(
        <span key="eta" className="text-xs text-gray-500">
          ETA: {formatTime(status.estimatedTimeRemaining)}
        </span>
      );
    }

    // Retry count
    if (status.retryCount !== undefined && status.retryCount > 0) {
      info.push(
        <span key="retries" className="text-xs text-orange-500">
          Retries: {status.retryCount}
        </span>
      );
    }

    return info;
  };

  if (uploadStatus.size === 0) {
    return null;
  }

  // Filter out cancelled files to avoid showing them
  const filteredUploadStatus = new Map(
    Array.from(uploadStatus.entries()).filter(([_, status]) => status.status !== 'Cancelled')
  );

  if (filteredUploadStatus.size === 0) {
    return null;
  }

  return (
    <div className="chunked-upload-progress">
      <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
        {Array.from(filteredUploadStatus.entries()).map(([fileId, status]) => {
          // Use the saved fileName if available, otherwise fall back to extracting from fileId
          const fileName = status.fileName || fileId.split('_')[0];

          return (
            <Card 
              key={fileId} 
              size="small" 
              className="upload-item-card"
              style={{ 
                borderLeft: `4px solid ${
                  status.status === 'Completed' ? '#52c41a' :
                  status.status === 'Error' ? '#ff4d4f' :
                  status.status === 'Cancelled' ? '#d9d9d9' :
                  status.status === 'Paused' ? '#faad14' :
                  '#1890ff'
                }`
              }}
            >
              <div className="flex justify-between items-start">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className="font-medium text-sm break-words leading-tight"
                      title={fileName}
                      style={{
                        wordBreak: 'break-word',
                        lineHeight: '1.2',
                        maxWidth: '250px',
                        overflowWrap: 'break-word',
                        hyphens: 'auto'
                      }}
                    >
                      {fileName}
                    </span>
                    <Tag 
                      color={getStatusColor(status.status)} 
                      icon={getStatusIcon(status.status)}
                    >
                      {status.status}
                    </Tag>
                    {status.fileSize && (
                      <span className="text-xs text-gray-500">
                        ({formatFileSize(status.fileSize)})
                      </span>
                    )}
                  </div>

                  {/* Progress bar */}
                  {status.status !== 'Completed' && status.status !== 'Cancelled' && (
                    <Progress 
                      percent={Number(status.progress.toFixed(2))} 
                      size="small" 
                      status={
                        status.status === 'Error' ? 'exception' :
                        status.status === 'Paused' ? 'active' :
                        'active'
                      }
                      strokeColor={
                        status.status === 'Error' ? '#ff4d4f' :
                        status.status === 'Paused' ? '#faad14' :
                        '#1890ff'
                      }
                    />
                  )}

                  {/* Progress info */}
                  <div className="flex gap-4 mt-1">
                    {renderProgressInfo(status)}
                  </div>

                  {/* Error message */}
                  {status.error && (
                    <div className="mt-2 text-xs text-red-500 bg-red-50 p-2 rounded">
                      <ExclamationCircleOutlined className="mr-1" />
                      {status.error}
                    </div>
                  )}
                </div>
                
                {/* Action buttons */}
                <Space>
                  {renderActionButtons(fileId, status)}
                </Space>
              </div>
            </Card>
          );
        })}
      </Space>
    </div>
  );
};

export default ChunkedUploadProgress;
