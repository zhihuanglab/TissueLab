import React, { useState } from 'react';
import { CButton, CSpinner, CListGroupItem } from '@coreui/react';
import { uploadFolderPath, uploadFilePath, loadFileData, createInstance } from '@/utils/file.service';
import { useDispatch, useSelector } from "react-redux";
import { RootState } from "@/store";
import path from 'path';
// import {updateFiles, updateProject} from "@/store/slices/uploadedFilesSlice";
import { setFileTree, updateFiles, setFolderName } from '@/store/slices/uploadedFilesSlice';
import { setImageLoaded } from '@/store/slices/sidebarSlice';
import { addWSIInstance, updateInstanceWSIInfo, replaceCurrentInstance } from '@/store/slices/wsiSlice';
import { setCurrentPath, setSlideInfo } from '@/store/slices/svsPathSlice';

interface FolderUploadProps {
  onFolderSelect: (folderPath: string) => void;
  onWsiUploadComplete: (dimensions: any) => void;
}

const FolderUpload: React.FC<FolderUploadProps> = ({ onFolderSelect, onWsiUploadComplete }) => {
  const dispatch = useDispatch();
  const folderName = useSelector((state: RootState) => state.uploadedFiles.currentFolder?.folderName);
  const fileTree = useSelector((state: RootState) => state.uploadedFiles.currentFolder?.fileTree);
  const wsiFiles = useSelector((state: RootState) => state.uploadedFiles.currentFolder?.wsiFiles);


  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');

  const handleFolderSelect = async () => {
    let response
    let selected_path
    try {
      const result = await window.electron.invoke('open-folder-dialog');
      if (result.filePaths && result.filePaths.length > 0) {
        console.log('Selected folder:', result.filePaths[0]);
        selected_path = result.filePaths[0]
        response = await uploadFolderPath(selected_path)
        console.log('FolderUpload: Upload folder path response:', response)

        // ensure we have the correct data structure, check if file_tree_dict exists
        if (!response || !response.file_tree_dict) {
          console.error('Error: Invalid response structure', response);
          setUploadStatus('Error: Server returned invalid data structure');
          return;
        }

        dispatch(setFolderName(selected_path))
        dispatch(setFileTree(response.file_tree_dict))
        dispatch(updateFiles(response.wsi_files || []));
      }
    } catch (error: any) {
      console.error('Error selecting folder:', error);
      setUploadStatus(`Error: ${error.message || 'Failed to upload folder'}`);
    }
  };

  const isWSI = (fileName: string) => {
    const supportedExtensions = ['.svs', '.qptiff', '.tif', '.ndpi', '.tiff',
      '.jpeg', '.png', '.jpg', '.dcm', '.bmp', '.czi', '.isyntax'];

    return supportedExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
  };

  const renderFileTreeDict = (treeDict: any, basePath: string = '') => {
    return Object.entries(treeDict).map(([name, content], index) => {
      const currentPath = basePath ? `${basePath}/${name}` : name;
      const isDirectory = typeof content === 'object';
      const isWsiFile = !isDirectory && isWSI(name);
      const relativePath = currentPath;

      return (
        <div key={index} style={{ marginLeft: '20px' }}>
          {isDirectory ? (
            <>
              <span>📂 {name}</span>
              {renderFileTreeDict(content as any, currentPath)}
            </>
          ) : (
            <span
              onClick={() => isWsiFile && handleWsiUpload(relativePath)}
              style={{
                cursor: isWsiFile ? 'pointer' : 'default',
                color: isWsiFile ? 'blue' : 'inherit',
                textDecoration: isWsiFile ? 'underline' : 'none'
              }}
            >
              📄 {name}
            </span>
          )}
        </div>
      );
    });
  };

  const handleWsiUpload = async (relativePath: string) => {
    setIsUploading(true);
    setUploadStatus(`Uploading ${relativePath}...`);

    try {
      const uploadData = await uploadFilePath(relativePath);
      setUploadStatus('WSI file uploaded successfully. Loading slide...');

      const loadData = await loadFileData(uploadData.filename);
      
      // Create instance for the WSI
      const instanceData = await createInstance(uploadData.filename);
      
      let fileInfo = {
        fileName: path.basename(relativePath.replace(/\\/g, '/')), // Normalize path separators
        filePath: relativePath
      };

      // Replace current instance with new WSI data (overwrite current window)
      dispatch(replaceCurrentInstance({
        instanceId: instanceData.instanceId,
        wsiInfo: {
          ...loadData,
          instanceId: instanceData.instanceId
        },
        fileInfo: fileInfo
      }));
      
      console.log('FolderUpload: loadData:', loadData);
      console.log('FolderUpload: fileInfo:', fileInfo);
      dispatch(setImageLoaded(true));
      setUploadStatus('Slide loaded successfully.');
      onWsiUploadComplete(loadData.dimensions);
    } catch (error) {
      console.error('Error:', error);
      setUploadStatus(`An error occurred while uploading ${relativePath}`);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div>
      {/*@ts-ignore*/}
      <CButton onClick={handleFolderSelect} disabled={isUploading}>
        {/*@ts-ignore*/}
        {isUploading ? <CSpinner size="sm" /> : 'Select Folder'}
      </CButton>
      {folderName && <p>Selected folder: {folderName}</p>}
      {uploadStatus && <p>{uploadStatus}</p>}
      <div style={{ display: 'flex', marginTop: '20px' }}>
        <div style={{ flex: 1, marginRight: '10px' }}>
          <h4>Folder Structure:</h4>
          <div style={{
            height: '400px',
            overflowY: 'auto',
            overflowX: 'auto',
            border: '1px solid #ccc',
            padding: '10px'
          }}>
            {/* {fileTreeString && renderFileTreeString(fileTreeString)} */}
            {fileTree && renderFileTreeDict(fileTree)}
          </div>
        </div>

        <div style={{ flex: 1, marginLeft: '10px' }}>
          <h4>Files:</h4>
          <div style={{
            height: '400px',
            overflowY: 'auto',
            overflowX: 'auto',
            border: '1px solid #ccc',
            padding: '10px'
          }}>
            {wsiFiles?.map((relativePath, index) => (
              // @ts-ignore
              <CListGroupItem
                key={index}
                onClick={() => handleWsiUpload(relativePath)}
                style={{ cursor: 'pointer', marginBottom: '5px', whiteSpace: 'nowrap' }}
              >
                {relativePath.split('/').pop()}
              </CListGroupItem>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default FolderUpload;