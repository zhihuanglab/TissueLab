import React, { useState } from 'react';
import { DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import http from '@/utils/http';

interface DownloadDialogContentProps {
  format: 'json' | 'csv';
  layerName: string;
  record: any;
}

const DownloadDialogContent: React.FC<DownloadDialogContentProps> = ({
  format,
  layerName,
  record
}) => {
  const [fileName, setFileName] = useState(`annotations.${format}`);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);


  const triggerBrowserDownload = (data: any, filename: string, mimeType: string) => {
    const blob = new Blob([data], { type: mimeType });
    const url = window.URL.createObjectURL(blob);
    
    // Create temporary download link
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    
    // Add to DOM, trigger download, then clean up
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // Release URL object
    setTimeout(() => window.URL.revokeObjectURL(url), 100);
  };

  const handleDownload = async () => {
    try {
      setIsLoading(true);
      setError(null);
      setSuccess(null);
      
      let data: any;
      let mimeType: string;
      
      if (layerName === "User-generated annotations") {
        // Directly handle user-generated annotations
        data = JSON.stringify(record, null, 2);
        mimeType = 'application/json';
        triggerBrowserDownload(data, `${record.layer_name}.json`, mimeType);
        setSuccess(`Successfully downloaded annotations!`);
        return;
      }
      
      // Handle AI-generated annotations
      let response;
      
      if (layerName === "AI-generated annotations") {
        response = await http.post(`${AI_SERVICE_API_ENDPOINT}/seg/v1/export/classifications`, {
          format: format
        });
      } else if (layerName === "AI-generated patches") {
        response = await http.post(`${AI_SERVICE_API_ENDPOINT}/seg/v1/export/patch_classification`, {
          format: format
        });
      } else {
        throw new Error('Unknown layer type');
      }
      
      if (response.status === 200) {
        const responseData = response.data;
        
        if (format === 'json') {
          data = JSON.stringify(responseData, null, 2);
          mimeType = 'application/json';
        } else if (format === 'csv') {
          data = responseData; // The backend has already returned the CSV string
          mimeType = 'text/csv';
        } else {
          throw new Error(`Unsupported format: ${format}`);
        }
        
        // Use the unified download function
        triggerBrowserDownload(data, fileName, mimeType);
        setSuccess(`Successfully downloaded annotations!`);
      } else {
        throw new Error(response.data?.message || 'Failed to download annotations');
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to download annotations');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Download {layerName} as {format.toUpperCase()}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-4 py-4">
        {/* File name input */}
        <div className="grid grid-cols-4 items-center gap-4">
          <Label htmlFor="file-name" className="text-right">
            Filename
          </Label>
          <Input
            id="file-name"
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            className="col-span-3"
            placeholder={`Enter filename (e.g., annotations.${format})`}
          />
        </div>
        

        {error && (
          <div className="text-red-500 text-sm mt-2">
            {error}
          </div>
        )}
        {success && (
          <div className="text-green-500 text-sm mt-2">
            {success}
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2">
        {success ? (
          <DialogClose asChild>
            <Button type="button">
              Close
            </Button>
          </DialogClose>
        ) : (
          <Button
            type="button"
            onClick={handleDownload}
            disabled={!fileName || isLoading}
          >
            {isLoading ? 'Downloading...' : 'Download'}
          </Button>
        )}
      </div>
    </>
  );
};

export default DownloadDialogContent; 