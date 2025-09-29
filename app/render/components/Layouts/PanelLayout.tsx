import React from 'react';

interface PanelLayoutProps {
  children: React.ReactNode;
}

export const PanelLayout: React.FC<PanelLayoutProps> = ({ children }) => {
  return (
    <div className="h-screen w-screen bg-white p-4">
      <div className="h-full overflow-auto">
        {children}
      </div>
    </div>
  );
};