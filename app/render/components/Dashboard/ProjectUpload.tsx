import React, { useState } from 'react';
import { CListGroup, CListGroupItem } from '@coreui/react';
import { uploadFilePath, loadFileData, createInstance } from '@/utils/file.service';
import { useDispatch, useSelector } from "react-redux";
import { RootState } from "@/store";
import { updateFiles } from "@/store/slices/uploadedFilesSlice";
import { setImageLoaded } from '@/store/slices/sidebarSlice';
import { addWSIInstance, replaceCurrentInstance } from '@/store/slices/wsiSlice';

interface ProjectUploadProps {
  onProjectSelect: (project: File) => void;
  onWsiUploadComplete: (dimensions: any) => void;
}

const ProjectUpload: React.FC<ProjectUploadProps> = ({ onProjectSelect, onWsiUploadComplete }) => {
  const dispatch = useDispatch();
  const [selectedProject, setSelectedProject] = useState<File | null>(null);
  const wsiFiles = useSelector((state: RootState) => state.uploadedFiles.projectWsiFiles.wsiFiles);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [dragging, setDragging] = useState(false);

  const handleProjectChange = (file: File) => {
    console.log('Project file selected:', file);
    setSelectedProject(file);
    onProjectSelect(file);
    parseProjectFile(file);
  };

  const parseProjectFile = async (file: File) => {
    try {
      const content = await file.text();
      const projectData = JSON.parse(content);
      dispatch(updateFiles(projectData.wsiFiles || []));
      let loadData = {
        project: projectData,
        projectFileName: file.name
      }

    } catch (error) {
      console.error('Error parsing project file:', error);
      setUploadStatus('Error parsing project file. Please ensure it\'s a valid .tlproj file.');
    }
  };

  const handleWsiUpload = async (wsiPath: string) => {
    setIsUploading(true);
    setUploadStatus(`Uploading ${wsiPath}...`);

    try {
      const uploadData = await uploadFilePath(wsiPath);
      setUploadStatus('WSI file uploaded successfully. Loading slide...');

      const loadData = await loadFileData(uploadData.filename);
      
      // Create instance for the WSI
      const instanceData = await createInstance(uploadData.filename);
      
      let fileInfo = {
        fileName: wsiPath.split('/').pop(),
        filePath: wsiPath
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
      
      console.log('ProjectUpload: loadData:', loadData);
      console.log('ProjectUpload: fileInfo:', fileInfo);
      dispatch(setImageLoaded(true));
      setUploadStatus('Slide loaded successfully.');
      onWsiUploadComplete(loadData.dimensions);
    } catch (error) {
      console.error('Error:', error);
      setUploadStatus(`An error occurred while uploading ${wsiPath}`);
    } finally {
      setIsUploading(false);
    }
  };

  // Drag and drop handlers (reused from FileUpload.tsx)
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
    if (file && file.name.endsWith('.tlproj')) {
      handleProjectChange(file);
    } else {
      setUploadStatus('Please upload a valid .tlproj file.');
    }
  };

  return (
    <div>
      <input
        type="file"
        id="project-upload"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = e.target.files;
          if (files && files.length > 0 && files[0].name.endsWith('.tlproj')) {
            handleProjectChange(files[0]);
          } else {
            setUploadStatus('Please select a valid .tlproj file.');
          }
        }}
        accept=".tlproj"
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
        {selectedProject ? (
          <p>Selected project: {selectedProject.name}</p>
        ) : (
          <p>
            Drag & drop a .tlproj file here, or{' '}
            <span
              style={{ textDecoration: 'underline', cursor: 'pointer' }}
              onClick={() => document.getElementById('project-upload')?.click()}
            >
              browse
            </span>{' '}
            to select a project file.
          </p>
        )}
      </div>
      {uploadStatus && <p>{uploadStatus}</p>}
      {wsiFiles.length > 0 && (
        // @ts-ignore
        <CListGroup>
          {wsiFiles.map((wsiPath, index) => (
            // @ts-ignore
            <CListGroupItem
              key={index}
              onClick={() => handleWsiUpload(wsiPath)}
              style={{ cursor: 'pointer' }}
            >
              {wsiPath.split('/').pop()}
            </CListGroupItem>
          ))}
        </CListGroup>
      )}
    </div>
  );
};

export default ProjectUpload;