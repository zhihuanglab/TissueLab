import React from 'react';
import { MdOutlineFileUpload } from 'react-icons/md';

const FileUploader: React.FC = () => {
  return (
    <div className="h-full w-full p-2 flex items-center justify-center">
      <div className="relative w-full h-full border-gray-300">
        <div className="flex items-center justify-center w-full h-full">
          <div className="flex flex-col justify-center items-center w-full h-full px-4 bg-gray-200 border-2 border-dashed rounded-md cursor-default select-none">
            <div className="mb-4">
              <MdOutlineFileUpload size={140} className="text-gray-400" />
            </div>
            <span className="font-medium text-gray-600">Please open images from Dashboard</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FileUploader;
