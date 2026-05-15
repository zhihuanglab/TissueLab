import { Button } from "@/components/ui/button";
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config";
import { useAnnotatorInstance } from "@/contexts/AnnotatorContext";
import { AppDispatch, RootState } from "@/store";
import { setTissueSegmentation } from "@/store/slices/viewer/annotationSlice";
import { ensureValidAnnotation } from "@/utils/annotationUtils";
import { cn } from "@/utils/twMerge";
import { Edit, MoreHorizontal, SquareTerminal, Trash2 } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { apiFetch } from '@/utils/common/apiFetch';
import { useDispatch, useSelector } from "react-redux";
import { panelMap } from "../constants";
import { PanelActionButtonsProps } from "../types";

export const PanelActionButtons: React.FC<PanelActionButtonsProps> = ({
  panel,
  onContentChange,
  onDelete,
  onShowLogs,
  logMetadata,
  compact,
  showEditButton,
  onEditClick,
}) => {
  const dispatch = useDispatch<AppDispatch>();
  const tissueSegmentation = useSelector((state: RootState) => state.annotations.tissue_segmentation);
  const [tissueAnnotationIds, setTissueAnnotationIds] = useState<string[]>(tissueSegmentation);
  const [patchAnnotationIds, setPatchAnnotationIds] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const { annotatorInstance } = useAnnotatorInstance();
  const slideDimensions = useSelector((state: RootState) => state.svsPath.slideInfo.dimensions);

  useEffect(() => {
    setTissueAnnotationIds(tissueSegmentation);
  }, [tissueSegmentation]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);


  // Early return after hooks
  if (!panel) {
    console.warn('PanelActionButtons: panel prop is undefined');
    return null;
  }

  const addTissueAnnotations = async (modelType: string) => {
    console.log('[addTissueAnnotations] annotatorInstance:', annotatorInstance);
    console.log('[addTissueAnnotations] annotatorInstance.viewer:', annotatorInstance?.viewer);
    if (!annotatorInstance) return;

    console.log('Adding new Tissue annotations ...', modelType);

    try {
      //get tissue data
      const tissueResponse = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/tissues?type=${encodeURIComponent(modelType)}`, {
        method: 'GET',
        returnAxiosFormat: true,
      });

      const tissueData = tissueResponse.data;
      console.log('Tissue response data:', tissueData);

      const newIds: string[] = [];

      //add tissue annotations
      for (const annotation of tissueData.tissue_annotations) {
        const uniqueId = `${modelType}-${annotation.id}`;
        const validAnnotation = ensureValidAnnotation({ ...annotation, id: uniqueId });
        annotatorInstance.addAnnotation(validAnnotation);
        newIds.push(uniqueId);
      }

      const updatedIds = [...tissueAnnotationIds, ...newIds];
      setTissueAnnotationIds(updatedIds);
      dispatch(setTissueSegmentation(updatedIds));

      console.log(`Total tissue annotations added. Count = ${newIds.length}`);
    } catch (error) {
      console.error('request fail:', error);
    }
  };

  const removeTissueAnnotations = (modelType: string) => {
    console.log('[removeTissueAnnotations] annotatorInstance:', annotatorInstance);
    if (!annotatorInstance) return;

    const idsToRemove = tissueAnnotationIds.filter(id => id.startsWith(`${modelType}-`));

    if (!idsToRemove.length) {
      console.log(`No Tissue annotations to remove for modelType: ${modelType}.`);
      return;
    }

    console.log('Removing Tissue annotations ...', idsToRemove);

    for (const annId of idsToRemove) {
      try {
        annotatorInstance.removeAnnotation(annId);
      } catch (error) {
        console.warn(`Failed to remove Tissue annotation id=${annId}`, error);
      }
    }

    const updatedIds = tissueAnnotationIds.filter(id => !id.startsWith(`${modelType}-`));
    setTissueAnnotationIds(updatedIds);
    dispatch(setTissueSegmentation(updatedIds));

    console.log(`All Tissue annotations removed for modelType: ${modelType}.`);
  };

  const addPatchAnnotations = async (modelType: string) => {
    if (!annotatorInstance) return;

    console.log('Adding new Patch annotations ...', modelType);

    try {
      //get patches data
      const patchesResponse = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/merged_patches/query?${new URLSearchParams({
        x1: '0',
        y1: '0',
        x2: String(slideDimensions?.[0] ?? 20000),
        y2: String(slideDimensions?.[1] ?? 20000)
      }).toString()}`, {
        method: 'GET',
        returnAxiosFormat: true,
      });

      const patchesData = patchesResponse.data.annotations;
      console.log('Patches response data:', patchesData);

      const newIds: string[] = [];

      //add patches annotations
      if (patchesData && Array.isArray(patchesData)) {
        for (const patch of patchesData) {
          const uniqueId = `${modelType}-patch-${patch.id}`;
          const validPatch = ensureValidAnnotation({ ...patch, id: uniqueId });
          annotatorInstance.addAnnotation(validPatch);
          newIds.push(uniqueId);
        }
      }

      const updatedIds = [...patchAnnotationIds, ...newIds];
      setPatchAnnotationIds(updatedIds);

      console.log(`Total patch annotations added. Count = ${newIds.length}`);
    } catch (error) {
      console.error('Failed to add patch annotations:', error);
    }
  };

  const removePatchAnnotations = (modelType: string) => {
    if (!annotatorInstance) return;

    const idsToRemove = patchAnnotationIds.filter(id => id.startsWith(`${modelType}-patch-`));

    if (!idsToRemove.length) {
      console.log(`No Patch annotations to remove for modelType: ${modelType}.`);
      return;
    }

    console.log('Removing Patch annotations ...', idsToRemove);

    for (const annId of idsToRemove) {
      try {
        annotatorInstance.removeAnnotation(annId);
      } catch (error) {
        console.warn(`Failed to remove Patch annotation id=${annId}`, error);
      }
    }

    const updatedIds = patchAnnotationIds.filter(id => !id.startsWith(`${modelType}-patch-`));
    setPatchAnnotationIds(updatedIds);

    console.log(`All Patch annotations removed for modelType: ${modelType}.`);
  };

  return (
    <div className="flex items-center space-x-1">
      <Button
        variant="outline"
        size="icon"
        className={cn(
          "rounded-[4px] border border-border bg-transparent text-muted-foreground hover:text-foreground hover:bg-card",
          compact ? "h-6 w-6" : "h-7 w-7"
        )}
        onClick={onShowLogs}
        disabled={!logMetadata?.logPath || !onShowLogs}
        title={logMetadata?.logPath ? "View Logs" : "Logs unavailable"}
      >
        <SquareTerminal className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
        <span className="sr-only">View Logs</span>
      </Button>
      <div className="relative" ref={menuRef}>
        <Button
          variant="outline"
          size="icon"
          className={cn(
            "rounded-[4px] border border-border bg-transparent text-muted-foreground hover:text-foreground hover:bg-card",
            compact ? "h-6 w-6" : "h-7 w-7"
          )}
          onClick={() => setMenuOpen((prev) => !prev)}
        >
          <MoreHorizontal className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          <span className="sr-only">More actions</span>
        </Button>
        {menuOpen && (
          <div className="absolute right-0 mt-1 z-20 rounded-sm border border-border bg-card shadow-md overflow-hidden flex flex-col">
            {showEditButton && onEditClick && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-3 text-xs text-foreground hover:bg-accent hover:text-accent-foreground rounded-none justify-start w-full"
                onClick={() => {
                  onEditClick();
                  setMenuOpen(false);
                }}
              >
                <Edit className="h-3.5 w-3.5 mr-1" /> Edit
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-3 text-xs text-destructive hover:text-destructive hover:bg-destructive/5 rounded-none justify-start w-full"
              onClick={() => {
                onDelete(panel.id);
                setMenuOpen(false);
              }}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}; 
