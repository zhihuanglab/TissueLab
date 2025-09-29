import React, { createContext, useContext, useState, ReactNode } from 'react';
import OpenSeadragon from 'openseadragon';

interface AnnotatorContextType {
  annotatorInstance: any;
  setAnnotatorInstance: (instance: any) => void;
  viewerInstance: OpenSeadragon.Viewer | null;
  setViewerInstance: (instance: OpenSeadragon.Viewer | null) => void;
  instanceId: string | null;
  setInstanceId: (id: string | null) => void;
}

const AnnotatorContext = createContext<AnnotatorContextType | undefined>(undefined);

export const useAnnotatorInstance = () => {
  const context = useContext(AnnotatorContext);
  if (context === undefined) {
    throw new Error('useAnnotatorInstance must be used within an AnnotatorProvider');
  }
  return context;
};

interface AnnotatorProviderProps {
  children: ReactNode;
}

export const AnnotatorProvider: React.FC<AnnotatorProviderProps> = ({ children }) => {
  const [annotatorInstance, setAnnotatorInstance] = useState<any>(null);
  const [viewerInstance, setViewerInstance] = useState<OpenSeadragon.Viewer | null>(null);
  const [instanceId, setInstanceId] = useState<string | null>(null);

  // Add cleanup effect for hot reload
  React.useEffect(() => {
    return () => {
      // Clean up on unmount (including hot reload)
      setAnnotatorInstance(null);
      setViewerInstance(null);
      setInstanceId(null);
    };
  }, []);

  return (
    <AnnotatorContext.Provider value={{ 
      annotatorInstance, 
      setAnnotatorInstance,
      viewerInstance,
      setViewerInstance,
      instanceId,
      setInstanceId
    }}>
      {children}
    </AnnotatorContext.Provider>
  );
}; 