"use client";

import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Database, PlayCircle } from "lucide-react";
import React, { useState } from "react";

const DatasetsPage: React.FC = () => {
  const [showTutorial, setShowTutorial] = useState(false);

  return (
    <div className="box-border h-full w-full flex flex-col overflow-hidden font-sans">
      <div className="flex-1 flex flex-col gap-6 w-full bg-background sm:px-2.5 sm:py-4 md:px-5 md:py-5 min-h-0 overflow-auto">
        {/* Header */}
        <div className="flex items-center gap-3 px-1">
          <h1 className="text-2xl font-bold">Datasets</h1>
          <button
            className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowTutorial(true)}
          >
            <PlayCircle className="h-4 w-4 text-red-500" />
            <span className="text-xs">Watch Tutorial</span>
          </button>
        </div>

        {/* Dataset cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* TCGA */}
          <Card className="border-border/50 hover:border-primary/40 hover:bg-accent/50 transition-colors cursor-pointer">
            <CardContent className="flex items-center gap-4 p-5">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                <Database className="h-6 w-6 text-primary" />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold">TCGA</span>
                <span className="text-xs text-muted-foreground">
                  The Cancer Genome Atlas dataset
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Tutorial video dialog (same placeholder as /dashboard) */}
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
  );
};

export default DatasetsPage;
