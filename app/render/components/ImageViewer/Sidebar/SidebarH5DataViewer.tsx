import React from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '@/store';
import dynamic from 'next/dynamic';
import { ScrollArea } from '@/components/ui/scroll-area';

// Import the H5Card component from the existing SidebarH5Card.tsx file
const H5Card = dynamic(() => import('./SidebarH5Card'), { ssr: false });

const SidebarH5DataViewer: React.FC = () => {
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);

  return (
    <ScrollArea className="h-[calc(100vh-64px)]">
      <H5Card currentPath={currentPath} />
    </ScrollArea>
  );
};

export default SidebarH5DataViewer;