'use client';

// Dialog component imports
import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/twMerge";
import { FileText, ChevronRight, ArrowLeft, Info } from "lucide-react";
import { marked } from "marked";

// Type definitions
interface AnnouncementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface AnnouncementItem {
  file: string;
  title: string;
  date: string;
}

// Configure markdown parser
marked.setOptions({
  breaks: true,
  gfm: true,
});

// Convert markdown content to HTML
const markdownToHtml = (markdown: string): string => {
  try {
    const html = marked.parse(markdown) as string;
    return html;
  } catch (error) {
    console.error('Error parsing markdown:', error);
    return markdown;
  }
};

export const AnnouncementDialog: React.FC<AnnouncementDialogProps> = ({
  open,
  onOpenChange,
}) => {
  // State management
  const [announcementList, setAnnouncementList] = useState<AnnouncementItem[]>([]);
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<AnnouncementItem | null>(null);
  const [announcementContent, setAnnouncementContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);

  // Load announcements when dialog opens
  useEffect(() => {
    if (!open) {
      setSelectedAnnouncement(null);
      setAnnouncementContent('');
      return;
    }

    const loadAnnouncementList = async () => {
      setLoading(true);
      setError(null);
      
      try {
        const response = await fetch('/announcements/announcements.json');
        if (response.ok) {
          const data: AnnouncementItem[] = await response.json();
          setAnnouncementList(data);
        } else {
          setError('Failed to load announcements list');
        }
      } catch (err) {
        setError('Failed to load announcements');
        console.error('Error loading announcements:', err);
      } finally {
        setLoading(false);
      }
    };

    loadAnnouncementList();
  }, [open]);

  // Handle announcement item click to load content
  const handleAnnouncementClick = async (item: AnnouncementItem) => {
    setSelectedAnnouncement(item);
    setContentLoading(true);
    setError(null); // Clear previous error before loading new content
    
    try {
      const response = await fetch(`/announcements/${item.file}`);
      if (response.ok) {
        const text = await response.text();
        setAnnouncementContent(text);
      } else {
        setError('Failed to load announcement content');
      }
    } catch (err) {
      setError('Failed to load announcement content');
      console.error('Error loading announcement content:', err);
    } finally {
      setContentLoading(false);
    }
  };

  // Navigate back to announcement list
  const handleBackToList = () => {
    setSelectedAnnouncement(null);
    setAnnouncementContent('');
    setError(null); // Clear error state when returning to list
  };

  // Make external links open in new window and add security attributes
  useEffect(() => {
    if (contentRef.current && announcementContent) {
      const links = contentRef.current.querySelectorAll('a');
      links.forEach((link) => {
        const href = link.getAttribute('href');
        if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
          link.setAttribute('target', '_blank');
          link.setAttribute('rel', 'noopener noreferrer');
        }
      });
    }
  }, [announcementContent]);

  return (
    <>
      {/* Announcements list dialog */}
      <Dialog open={open && !selectedAnnouncement} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl w-[90vw] max-h-[85vh] overflow-hidden bg-card border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold text-foreground">
              Announcements
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Latest updates and important information
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-[calc(85vh-120px)] pr-4">
            {/* Loading state */}
            {loading && (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                Loading announcements...
              </div>
            )}

            {/* Error state */}
            {error && (
              <div className="px-3">
                <div className="mx-auto flex max-w-xl items-center justify-center gap-2 rounded-md border border-primary/30 bg-primary/10 p-3 text-sm text-primary">
                  <Info className="w-4 h-4" />
                  <span>{error}</span>
                </div>
              </div>
            )}

            {/* Empty state */}
            {!loading && !error && announcementList.length === 0 && (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                No announcements available
              </div>
            )}

            {/* Announcement list */}
            {!loading && !error && announcementList.length > 0 && (
              <div className="space-y-2 py-2">
                {announcementList.map((item, index) => (
                  <Button
                    key={index}
                    variant="ghost"
                    className="w-full justify-between h-auto py-4 px-4 hover:bg-accent"
                    onClick={() => handleAnnouncementClick(item)}
                  >
                    <div className="flex items-start gap-3 flex-1 text-left">
                      <FileText className="h-5 w-5 text-muted-foreground mt-0.5 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-foreground">{item.title}</div>
                        <div className="text-sm text-muted-foreground mt-1">{item.date}</div>
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  </Button>
                ))}
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Announcement detail dialog */}
      <Dialog open={!!selectedAnnouncement} onOpenChange={(open) => {
        if (!open) {
          handleBackToList();
        }
      }}>
        <DialogContent className="max-w-3xl w-[90vw] max-h-[85vh] overflow-hidden bg-card border-border text-foreground">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                onClick={handleBackToList}
                aria-label="Back to announcements list"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div className="flex-1">
                <DialogTitle className="text-xl font-semibold text-foreground">
                  {selectedAnnouncement?.title}
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  {selectedAnnouncement?.date}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <ScrollArea className="max-h-[calc(85vh-120px)] pr-4">
            {/* Content loading state */}
            {contentLoading && (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                Loading content...
              </div>
            )}

            {/* Content error state */}
            {!contentLoading && error && (
              <div className="px-3">
                <div className="mx-auto flex max-w-xl items-center justify-center gap-2 rounded-md border border-primary/30 bg-primary/10 p-3 text-sm text-primary">
                  <Info className="w-4 h-4" />
                  <span>{error}</span>
                </div>
              </div>
            )}

            {/* Rendered markdown content */}
            {!contentLoading && !error && announcementContent && (
              // Markdown styles - headings, text, lists, code blocks, tables
              <div
                ref={contentRef}
                className={cn(
                  "text-foreground py-2",
                  "[&_h1]:text-xl [&_h1]:font-bold [&_h1]:mb-4 [&_h1]:mt-6 [&_h1]:first:mt-0",
                  "[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mb-3 [&_h2]:mt-5",
                  "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:mb-2 [&_h3]:mt-4",
                  "[&_p]:mb-3 [&_p]:leading-relaxed",
                  "[&_strong]:font-semibold [&_strong]:text-foreground",
                  "[&_em]:italic",
                  "[&_a]:text-primary [&_a]:underline [&_a]:hover:text-primary/80",
                  "[&_ul]:list-disc [&_ul]:ml-6 [&_ul]:mb-3",
                  "[&_ol]:list-decimal [&_ol]:ml-6 [&_ol]:mb-3",
                  "[&_li]:mb-1",
                  "[&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm [&_code]:font-mono",
                  "[&_pre]:bg-muted [&_pre]:p-4 [&_pre]:rounded [&_pre]:overflow-x-auto [&_pre]:my-3",
                  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
                  "[&_blockquote]:border-l-4 [&_blockquote]:border-muted-foreground [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:my-3",
                  "[&_img]:max-w-full [&_img]:rounded [&_img]:my-3",
                  "[&_table]:w-full [&_table]:border-collapse [&_table]:my-3",
                  "[&_th]:border [&_th]:border-border [&_th]:px-4 [&_th]:py-2 [&_th]:bg-muted [&_th]:font-semibold",
                  "[&_td]:border [&_td]:border-border [&_td]:px-4 [&_td]:py-2"
                )}
                dangerouslySetInnerHTML={{ __html: markdownToHtml(announcementContent) }}
              />
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
};

