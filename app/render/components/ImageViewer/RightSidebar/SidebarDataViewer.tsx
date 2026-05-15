import { ScrollArea } from '@/components/ui/scroll-area';
import { RootState } from '@/store';
import dynamic from 'next/dynamic';
import React from 'react';
import { useSelector } from 'react-redux';

// Import the DataCard component (previously SidebarZarrCard)
const DataCard = dynamic(() => import('./SidebarDataCard'), { ssr: false });

const SidebarDataViewer: React.FC = () => {
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);

  return (
    <ScrollArea className="h-[calc(100vh-64px)]">
      <div className="px-2 pt-2">
        <DataCard currentPath={currentPath} />
      </div>
    </ScrollArea>
  );
};

export default SidebarDataViewer;