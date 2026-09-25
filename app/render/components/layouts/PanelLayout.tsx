import React from 'react';

interface PanelLayoutProps {
  children: React.ReactNode;
}

export const PanelLayout: React.FC<PanelLayoutProps> = ({ children }) => {
  return (
    <div className="h-screen w-screen bg-background p-4 transition-all transition-colors duration-300">
      <div className="h-full flex flex-col overflow-hidden transition-all duration-300">
        {children}
      </div>
    </div>
  );
};