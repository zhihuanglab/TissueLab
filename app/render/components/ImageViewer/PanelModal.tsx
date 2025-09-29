import React from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '@/store';
import { closePanel } from '@/store/slices/panelSlice';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import NucleiTab from './Sidebar/SidebarAITabs/NucleiTab';
import TissueSegmentation from './Sidebar/SidebarAITabs/TissueSegmentation';

const PanelModal: React.FC = () => {
  const dispatch = useDispatch();
  const { isOpen, activePanelType } = useSelector((state: RootState) => state.panel);

  if (!isOpen || !activePanelType) {
    return null;
  }

  const handleClose = () => {
    dispatch(closePanel());
  };

  const renderPanelContent = () => {
    switch (activePanelType) {
      case 'quantification':
        return <NucleiTab />;
      case 'tissue_segmentation':
        return <TissueSegmentation />;
      default:
        return null;
    }
  };

  const getPanelTitle = () => {
    switch (activePanelType) {
      case 'quantification':
        return 'Quantification Panel';
      case 'tissue_segmentation':
        return 'Tissue Classification Panel';
      default:
        return 'Panel';
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black bg-opacity-50 z-40"
        onClick={handleClose}
      />
      
      {/* Modal */}
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-lg shadow-xl max-w-6xl w-full max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-gray-200">
            <h2 className="text-xl font-semibold text-gray-900">
              {getPanelTitle()}
            </h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClose}
              className="h-8 w-8 p-0"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          
          {/* Content */}
          <div className="flex-1 overflow-y-auto" style={{ minHeight: 0, paddingBottom: '20px' }}>
            <div style={{ height: 'calc(90vh - 180px)', overflow: 'auto'}}>
              {renderPanelContent()}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default PanelModal; 
