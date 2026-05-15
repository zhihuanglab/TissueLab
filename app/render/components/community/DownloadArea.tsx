import React, { useState, useEffect } from 'react';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { X, Download, CheckCircle, AlertCircle, Pause, Play } from 'lucide-react';
import { toast } from 'sonner';
import { getErrorMessage } from '@/utils/common/apiResponse';

interface DownloadItem {
  id: string;
  name: string;
  type: 'classifier' | 'bundle';
  url: string;
  receivedBytes: number;
  totalBytes: number;
  percent: number;
  state: 'progressing' | 'extracting' | 'completed' | 'failed' | 'cancelled' | 'paused';
  filePath?: string;
  canCancel?: boolean;
  error?: string;
  startTime?: number;
}

interface DownloadAreaProps {
  className?: string;
}

export const DownloadArea: React.FC<DownloadAreaProps> = ({ className = '' }) => {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);

  // listen to download progress event
  useEffect(() => {
    const handler = (payload: any) => {
      try {
        if (!payload) return;
        const { state, receivedBytes, totalBytes, url, filePath, error } = payload || {};
        
        // generate download item ID based on URL
        const downloadId = url ? `download_${url.split('/').pop() || Date.now()}` : `download_${Date.now()}`;
        
        // determine download type and name
        const isBundle = url?.includes('tasknodes');
        const fileName = url?.split('/').pop() || 'Unknown';
        // truncate long file name
        const truncatedFileName = fileName.length > 30 ? fileName.substring(0, 30) + '...' : fileName;
        const downloadName = isBundle 
          ? `Bundle ${truncatedFileName}`
          : `Classifier ${truncatedFileName}`;
        
        if (state === 'progressing') {
          const percent = totalBytes ? Math.floor((receivedBytes / totalBytes) * 100) : 0;
          
          setDownloads(prev => {
            const existingIndex = prev.findIndex(d => d.url === url);
            const newItem: DownloadItem = {
              id: downloadId,
              name: downloadName,
              type: isBundle ? 'bundle' : 'classifier',
              url,
              receivedBytes: receivedBytes || 0,
              totalBytes: totalBytes || 0,
              percent,
              state: 'progressing',
              canCancel: payload?.canCancel && isBundle,
              startTime: prev[existingIndex]?.startTime || Date.now()
            };
            
            if (existingIndex >= 0) {
              const updated = [...prev];
              updated[existingIndex] = newItem;
              return updated;
            } else {
              return [...prev, newItem];
            }
          });
        }
        
        if (state === 'extracting') {
          setDownloads(prev => {
            const existingIndex = prev.findIndex(d => d.url === url);
            if (existingIndex >= 0) {
              const updated = [...prev];
              updated[existingIndex] = {
                ...updated[existingIndex],
                state: 'extracting',
                percent: 100 // Show as complete progress since download is done
              };
              return updated;
            }
            return prev;
          });
        }
        
        if (state === 'completed') {
          setDownloads(prev => {
            const existingIndex = prev.findIndex(d => d.url === url);
            if (existingIndex >= 0) {
              const updated = [...prev];
              updated[existingIndex] = {
                ...updated[existingIndex],
                state: 'completed',
                filePath,
                percent: 100
              };
              return updated;
            }
            return prev;
          });
          
          toast.success('Download completed', { 
            description: filePath ? `Saved to: ${filePath.length > 50 ? filePath.substring(0, 50) + '...' : filePath}` : undefined 
          } as any);
        }
        
        if (state === 'interrupted' || state === 'cancelled' || state === 'failed') {
          setDownloads(prev => {
            const existingIndex = prev.findIndex(d => d.url === url);
            if (existingIndex >= 0) {
              const updated = [...prev];
              updated[existingIndex] = {
                ...updated[existingIndex],
                state: state as any,
                error: error || 'Download interrupted'
              };
              return updated;
            }
            return prev;
          });
          
          if (state === 'cancelled') {
            toast.info('Download cancelled');
          } else {
            toast.error(getErrorMessage({ message: error }, 'Download interrupted'));
          }
        }
      } catch (err) {
        console.error('Download progress handler error', err);
      }
    };
    
    (window as any).electron?.on?.('download-progress', handler);
    return () => {
      try { (window as any).electron?.off?.('download-progress', handler); } catch {}
    };
  }, []);

  // cancel download
  const handleCancelDownload = async (download: DownloadItem) => {
    try {
      await (window as any).electron.invoke('cancel-download', download.url);
    } catch (e) {
      console.error('Failed to cancel download:', e);
    }
  };

  // remove download entry
  const handleRemoveDownload = (downloadId: string) => {
    setDownloads(prev => prev.filter(d => d.id !== downloadId));
  };

  // format file size
  const formatBytes = (bytes: number) => {
    return Math.floor(bytes / (1024 * 1024));
  };

  // format download speed
  const getDownloadSpeed = (download: DownloadItem) => {
    if (!download.startTime || download.state !== 'progressing') return '';
    const elapsed = (Date.now() - download.startTime) / 1000; // seconds
    const speed = download.receivedBytes / elapsed; // bytes per second
    return `${formatBytes(speed)} MB/s`;
  };

  // get status icon
  const getStatusIcon = (state: DownloadItem['state']) => {
    switch (state) {
      case 'completed':
        return <CheckCircle className="h-4 w-4 text-primary" />;
      case 'failed':
        return <AlertCircle className="h-4 w-4 text-destructive" />;
      case 'cancelled':
        return <X className="h-4 w-4 text-muted-foreground" />;
      case 'paused':
        return <Pause className="h-4 w-4 text-accent-foreground" />;
      case 'extracting':
        return <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-primary" />;
      default:
        return <Download className="h-4 w-4 text-primary" />;
    }
  };

  // get status color
  const getStatusColor = (state: DownloadItem['state']) => {
    switch (state) {
      case 'completed':
        return 'border border-primary/30 bg-primary/10 text-primary';
      case 'failed':
        return 'border border-destructive/40 bg-destructive/10 text-destructive';
      case 'cancelled':
        return 'border border-border bg-muted text-muted-foreground';
      case 'paused':
        return 'border border-accent/40 bg-accent/15 text-accent-foreground';
      case 'extracting':
        return 'border border-primary/30 bg-primary/10 text-primary';
      default:
        return 'border border-primary/25 bg-primary/10 text-primary';
    }
  };

  const activeDownloads = downloads.filter(d => d.state === 'progressing' || d.state === 'extracting');
  const completedDownloads = downloads.filter(d => d.state === 'completed');
  const failedDownloads = downloads.filter(d => d.state === 'failed' || d.state === 'cancelled');

  if (downloads.length === 0) {
    return null;
  }

  return (
    <Card className={`w-full ${className}`}>
      <CardHeader 
        className="pb-3 cursor-pointer" 
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <CardTitle className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4" />
            Downloads
            {activeDownloads.length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {activeDownloads.length} active
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {activeDownloads.length > 0 && (
              <Badge variant="outline" className="text-xs">
                {Math.round(activeDownloads.reduce((sum, d) => sum + d.percent, 0) / activeDownloads.length)}% avg
              </Badge>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
            >
              {isExpanded ? '−' : '+'}
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      
      {isExpanded && (
        <CardContent className="pt-0 space-y-3">
          {/* Active downloads */}
          {activeDownloads.map((download) => (
            <div
              key={download.id}
              className={`space-y-2 rounded-lg border border-border p-3 ${
                download.state === 'extracting' ? 'bg-accent/10' : 'bg-primary/5'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {getStatusIcon(download.state)}
                  <span className="truncate text-sm font-medium text-foreground">{download.name}</span>
                  <Badge className={`flex-shrink-0 text-xs ${getStatusColor(download.state)}`}>
                    {download.state === 'extracting' ? 'Extracting' : download.type}
                  </Badge>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  {download.canCancel && download.state === 'progressing' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleCancelDownload(download)}
                      className="h-6 px-2 text-xs text-destructive hover:text-destructive/80"
                    >
                      Cancel
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveDownload(download.id)}
                    className="h-6 w-6 p-0"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              
              <div className="space-y-1">
                {download.state === 'extracting' ? (
                  <>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Extracting files...</span>
                      <span className="font-medium text-primary">Extracting</span>
                    </div>
                    <Progress value={100} className="h-2 bg-primary/10" />
                  </>
                ) : (
                  <>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>
                        {formatBytes(download.receivedBytes)} MB / {formatBytes(download.totalBytes)} MB
                      </span>
                      <span>{download.percent}%</span>
                    </div>
                    <Progress value={download.percent} className="h-2" />
                    {download.state === 'progressing' && (
                      <div className="text-xs text-muted-foreground">
                        {getDownloadSpeed(download)}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}

          {/* Completed downloads */}
          {completedDownloads.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Completed ({completedDownloads.length})
              </h4>
              {completedDownloads.map((download) => (
                <div key={download.id} className="flex items-center justify-between rounded border border-border bg-primary/5 p-2">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    {getStatusIcon(download.state)}
                    <span className="truncate text-sm text-foreground">{download.name}</span>
                    <Badge className={`flex-shrink-0 text-xs ${getStatusColor(download.state)}`}>
                      {download.type}
                    </Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveDownload(download.id)}
                    className="flex-shrink-0 h-6 w-6 p-0"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Failed downloads */}
          {failedDownloads.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Failed ({failedDownloads.length})
              </h4>
              {failedDownloads.map((download) => (
                <div key={download.id} className="space-y-1 rounded border border-border bg-destructive/10 p-2">
                  <div className="flex items-center justify-between">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      {getStatusIcon(download.state)}
                      <span className="truncate text-sm text-foreground">{download.name}</span>
                      <Badge className={`flex-shrink-0 text-xs ${getStatusColor(download.state)}`}>
                        {download.type}
                      </Badge>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemoveDownload(download.id)}
                      className="flex-shrink-0 h-6 w-6 p-0"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                  {download.error && (
                    <div className="ml-6 text-xs text-destructive break-words">
                      {download.error.length > 100 ? download.error.substring(0, 100) + '...' : download.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
};

export default DownloadArea;
