"use client";
import LocalFileManager from "@/components/dashboard/LocalFileManager";
import StorageFolderCards from "@/components/dashboard/StorageFolderCards";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PlayCircle } from 'lucide-react';
import React, { useEffect, useState } from 'react';

const Dashboard = () => {
  const [isElectron, setIsElectron] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.electron) {
      setIsElectron(true);
    }
  }, []);

  return (
    <div className="box-border h-full w-full flex flex-col overflow-hidden font-sans">
      <div className="dashboard-content flex-1 flex flex-col gap-0 w-full bg-background px-2.5 pb-4 md:px-4 md:pb-5 min-h-0 overflow-hidden">
        {isElectron && (
          <div className="file-manager-container bg-card rounded-xl shadow-sm flex flex-col flex-1 min-h-0 mt-2 md:mt-3">
            <LocalFileManager />
          </div>
        )}
        {!isElectron && (
          <div className="flex flex-col flex-1 min-h-0 gap-2">
            {/* Dashboard header */}
            <div className="flex items-center gap-3 px-1 py-1.5">
              <h1 className="text-lg font-semibold">Dashboard</h1>
              <button
                className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setShowTutorial(true)}
              >
                <PlayCircle className="h-4 w-4 text-red-500" />
                <span className="text-xs">Watch Tutorial</span>
              </button>
            </div>
            {/* File manager takes the full row. */}
            <div className="flex flex-1 min-h-0 flex-col">
              <StorageFolderCards />
            </div>
          </div>
        )}
      </div>

      {/* Tutorial video dialog */}
      <Dialog open={showTutorial} onOpenChange={setShowTutorial}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>How to use this page</DialogTitle>
          </DialogHeader>
          <div className="flex aspect-video w-full items-center justify-center rounded-lg bg-muted">
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <PlayCircle className="h-12 w-12" />
              <p className="text-sm">Tutorial video placeholder</p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default Dashboard
