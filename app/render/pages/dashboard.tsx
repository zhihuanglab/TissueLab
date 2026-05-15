"use client";
import LocalFileManager from "@/components/dashboard/LocalFileManager";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PlayCircle } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type DownloadStep = 'behavior' | 'audio';

const Dashboard = () => {
  const [showTutorial, setShowTutorial] = useState(false);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
  const [downloadInfo, setDownloadInfo] = useState<{
    step: DownloadStep;
    fileName: string;
    eventCount?: number;
    imageName?: string;
    hasAudio?: boolean;
  } | null>(null);
  /** When true, we are switching to the audio step; onOpenChange(false) must not clear state */
  const pendingAudioStepRef = useRef(false);

  // Listen for download request events from view-act logger (first step: behavior)
  useEffect(() => {
    const handleDownloadRequest = (event: CustomEvent<{ fileName: string; eventCount: number; imageName: string; hasAudio?: boolean }>) => {
      const detail = event.detail;
      console.log('[Dashboard] viewact-log-download-request received:', {
        fileName: detail.fileName,
        hasAudio: detail.hasAudio,
        hasData: !!(window as any).__viewActDownloadData,
        hasAudioBlob: !!(window as any).__viewActDownloadAudio,
      });
      setDownloadInfo({
        step: 'behavior',
        fileName: detail.fileName,
        eventCount: detail.eventCount,
        imageName: detail.imageName,
        hasAudio: detail.hasAudio,
      });
      setShowDownloadDialog(true);
    };

    window.addEventListener('viewact-log-download-request', handleDownloadRequest as EventListener);
    return () => {
      window.removeEventListener('viewact-log-download-request', handleDownloadRequest as EventListener);
    };
  }, []);

  const handleDownloadConfirm = () => {
    console.log('[Dashboard] handleDownloadConfirm called', { downloadInfo: downloadInfo ?? null });
    if (!downloadInfo) {
      console.warn('[Dashboard] handleDownloadConfirm: no downloadInfo, returning');
      return;
    }

    if (downloadInfo.step === 'behavior') {
      const storedData = (window as any).__viewActDownloadData;
      const sessionId = storedData?.metadata?.sessionId ?? String(Date.now());
      if (storedData) {
        const jsonString = JSON.stringify(storedData, null, 2);
        const viewActBlob = new Blob([jsonString], { type: 'application/json' });
        const fileName = `viewact_log_${sessionId}.json`;
        const url = URL.createObjectURL(viewActBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        delete (window as any).__viewActDownloadData;
        console.log(`[Dashboard] Downloaded behavior log: ${fileName}`);
      }

      const audioBlob = (window as any).__viewActDownloadAudio as Blob | null | undefined;
      console.log('[Dashboard] after behavior download:', {
        hasAudio: downloadInfo.hasAudio,
        hasAudioBlob: !!audioBlob,
        audioBlobSize: audioBlob?.size,
        willShowAudioStep: !!(downloadInfo.hasAudio && audioBlob),
      });
      if (downloadInfo.hasAudio && audioBlob) {
        pendingAudioStepRef.current = true;
        setDownloadInfo({
          step: 'audio',
          fileName: `voice_${sessionId}.webm`,
        });
        setShowDownloadDialog(true);
        console.log('[Dashboard] Set state for audio step, dialog should show');
        return;
      }
      setShowDownloadDialog(false);
      setDownloadInfo(null);
      return;
    }

    if (downloadInfo.step === 'audio') {
      const audioBlob = (window as any).__viewActDownloadAudio as Blob | null | undefined;
      if (audioBlob) {
        const url = URL.createObjectURL(audioBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = downloadInfo.fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        delete (window as any).__viewActDownloadAudio;
        console.log(`[Dashboard] Downloaded voice recording: ${downloadInfo.fileName}`);
      }
      setShowDownloadDialog(false);
      setDownloadInfo(null);
    }
  };

  const handleDownloadCancel = () => {
    console.log('[Dashboard] handleDownloadCancel', {
      step: downloadInfo?.step,
      hasAudio: downloadInfo?.hasAudio,
      hasAudioBlob: !!(window as any).__viewActDownloadAudio,
    });
    if (downloadInfo?.step === 'behavior' && downloadInfo?.hasAudio && (window as any).__viewActDownloadAudio) {
      const storedData = (window as any).__viewActDownloadData;
      const sessionId = storedData?.metadata?.sessionId ?? String(Date.now());
      delete (window as any).__viewActDownloadData;
      pendingAudioStepRef.current = true;
      setDownloadInfo({
        step: 'audio',
        fileName: `voice_${sessionId}.webm`,
      });
      setShowDownloadDialog(true);
      console.log('[Dashboard] Cancel -> switching to audio step dialog');
      return;
    }
    setShowDownloadDialog(false);
    if ((window as any).__viewActDownloadData) delete (window as any).__viewActDownloadData;
    if ((window as any).__viewActDownloadAudio) delete (window as any).__viewActDownloadAudio;
    setDownloadInfo(null);
  };

  return (
    <div className="box-border h-full w-full flex flex-col overflow-hidden font-sans">
      <div className="dashboard-content flex-1 flex flex-col gap-0 w-full bg-background px-2.5 pb-4 md:px-4 md:pb-5 min-h-0 overflow-hidden">
        <div className="file-manager-container bg-card rounded-xl shadow-sm flex flex-col flex-1 min-h-0 mt-2 md:mt-3">
          <LocalFileManager />
        </div>
      </div>
      <AlertDialog
        open={showDownloadDialog}
        onOpenChange={(open) => {
          console.log('[Dashboard] onOpenChange', { open, pendingAudioStepRef: pendingAudioStepRef.current });
          if (!open && pendingAudioStepRef.current) {
            console.log('[Dashboard] onOpenChange: skipping clear (transitioning to audio step)');
            pendingAudioStepRef.current = false;
            return;
          }
          if (!open) pendingAudioStepRef.current = false;
          setShowDownloadDialog(open);
          if (!open) setDownloadInfo(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {downloadInfo?.step === 'audio' ? 'Download Voice Recording' : 'Download Behavior Log'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-sm text-muted-foreground">
                {downloadInfo && downloadInfo.step === 'behavior' && (
                  <>
                    <div className="mt-2 space-y-1">
                      <div><strong>File:</strong> {downloadInfo.fileName}</div>
                      <div><strong>Events:</strong> {downloadInfo.eventCount}</div>
                      <div><strong>Image:</strong> {downloadInfo.imageName}</div>
                    </div>
                    <div className="mt-4">
                      Do you want to download this behavior log file?
                    </div>
                  </>
                )}
                {downloadInfo && downloadInfo.step === 'audio' && (
                  <div className="mt-4">
                    Do you want to download this voice recording? <strong>{downloadInfo.fileName}</strong>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleDownloadCancel}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDownloadConfirm}>Download</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
