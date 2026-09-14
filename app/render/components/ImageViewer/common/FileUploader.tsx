import React from 'react';
import { ImageIcon, ArrowRight } from 'lucide-react';
import { useRouter } from 'next/router';

const FileUploader: React.FC = () => {
  const router = useRouter();

  return (
    <div className="flex h-full w-full items-center justify-center p-4">
      <div className="flex h-full w-full flex-col items-center justify-center rounded-md border-2 border-dashed border-border bg-muted/30 dark:bg-black/20">
        <div className="flex flex-col items-center gap-4 text-center max-w-xs">
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-primary/10">
            <ImageIcon className="h-10 w-10 text-primary" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-base font-semibold text-foreground">
              No image open
            </span>
            <span className="text-sm text-muted-foreground leading-relaxed">
              Open an image from the Dashboard to start viewing and analyzing.
            </span>
          </div>
          <button
            type="button"
            onClick={() => router.push('/dashboard')}
            className="flex items-center gap-1.5 text-xs text-primary font-medium mt-1 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm"
          >
            <span>Go to Dashboard</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default FileUploader;
