import React, { useState, useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { AppDispatch, RootState } from "@/store";
import { ChartBar, FileImage, Trash2, EyeOff, Eye, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setTissueSegmentation, toggleTissueAnnotations, togglePatchAnnotations } from "@/store/slices/annotationSlice";
import { useAnnotatorInstance } from "@/contexts/AnnotatorContext";
import { openPanel } from "@/store/slices/panelSlice";
import { panelMap } from "./constants";
import http from "@/utils/http";
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config";
import { PanelActionButtonsProps } from "./types";

export const PanelActionButtons: React.FC<PanelActionButtonsProps> = ({
  panel,
  onContentChange,
  onDelete,
  onShowLogs,
  logMetadata,
}) => {
  const dispatch = useDispatch<AppDispatch>();
  const showTissueAnnotations = useSelector((state: RootState) => state.annotations.showTissueAnnotations);
  const showPatchAnnotations = useSelector((state: RootState) => state.annotations.showPatchAnnotations);
  const [isTissueVisible, setIsTissueVisible] = useState(showTissueAnnotations);
  const [isPatchVisible, setIsPatchVisible] = useState(showPatchAnnotations);
  const tissueSegmentation = useSelector((state: RootState) => state.annotations.tissue_segmentation);
  const [tissueAnnotationIds, setTissueAnnotationIds] = useState<string[]>(tissueSegmentation);
  const [patchAnnotationIds, setPatchAnnotationIds] = useState<string[]>([]);
  const { annotatorInstance } = useAnnotatorInstance();
  const slideDimensions = useSelector((state: RootState) => state.svsPath.slideInfo.dimensions);

  useEffect(() => {
    setIsTissueVisible(showTissueAnnotations);
  }, [showTissueAnnotations]);

  useEffect(() => {
    setIsPatchVisible(showPatchAnnotations);
  }, [showPatchAnnotations]);

  useEffect(() => {
    setTissueAnnotationIds(tissueSegmentation);
  }, [tissueSegmentation]);

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
      const tissueResponse = await http.get(`${AI_SERVICE_API_ENDPOINT}/seg/v1/tissues`, {
        params: { type: modelType }
      });

      const tissueData = tissueResponse.data.data || tissueResponse.data;
      console.log('Tissue response data:', tissueData);

      const newIds: string[] = [];

      //add tissue annotations
      for (const annotation of tissueData.tissue_annotations) {
        const uniqueId = `${modelType}-${annotation.id}`;
        annotatorInstance.addAnnotation({ ...annotation, id: uniqueId });
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
      const patchesResponse = await http.get(`${AI_SERVICE_API_ENDPOINT}/seg/v1/merged_patches/query`, {
        params: {
          x1: 0,
          y1: 0,
          x2: slideDimensions?.[0] ?? 20000,
          y2: slideDimensions?.[1] ?? 20000
        }
      });

      const patchesData = patchesResponse.data.data.annotations;
      console.log('Patches response data:', patchesData);

      const newIds: string[] = [];

      //add patches annotations
      if (patchesData && Array.isArray(patchesData)) {
        for (const patch of patchesData) {
          const uniqueId = `${modelType}-patch-${patch.id}`;
          annotatorInstance.addAnnotation({ ...patch, id: uniqueId });
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

  const renderActionButton = () => {
    if (!panel?.title) return null;

    switch (panel.title) {
      case panelMap.NucleiSeg.title:
        return (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => {
              dispatch(openPanel('quantification'));
            }}
          >
            <ChartBar className="h-4 w-4" />
            <span className="sr-only">Show Quantification</span>
          </Button>
        );
      case panelMap.TissueClassify.title:
        return (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => {
              dispatch(openPanel('tissue_segmentation'));
            }}
          >
            <FileImage className="h-4 w-4" />
            <span className="sr-only">Show Tissue Classification</span>
          </Button>
        );
      default:
        return null;
    }
  };

  const handleTissueAnnotationVisibility = async () => {
    setIsTissueVisible((prevIsVisible) => {
      const newIsVisible = !prevIsVisible;
      console.log('Tissue visibility:', newIsVisible);

      dispatch(toggleTissueAnnotations());

      if (newIsVisible) {
        http.post(`${AI_SERVICE_API_ENDPOINT}/seg/v1/set_types`, { tissue: panel.type })
          .then(response => {
            const data = response.data;
            console.log('Tissue response data:', data);
            addTissueAnnotations(panel.type);
          })
          .catch(error => {
            console.error('Error fetching tissue annotations:', error);
          });
      } else {
        removeTissueAnnotations(panel.type);
      }

      return newIsVisible;
    });
  };

  const handlePatchAnnotationVisibility = () => {
    setIsPatchVisible((prevIsVisible) => {
      const newIsVisible = !prevIsVisible;
      console.log('Patch visibility:', newIsVisible);
      
      dispatch(togglePatchAnnotations());

      if (newIsVisible) {
        addPatchAnnotations(panel.type);
      } else {
        removePatchAnnotations(panel.type);
      }

      return newIsVisible;
    });
  };

  const renderVisibilityButton = () => {
    if (!panel?.title) return null;

    if (panel.title === panelMap.TissueClassify.title) {
      return (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={handleTissueAnnotationVisibility}
        >
          {isTissueVisible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          <span className="sr-only">{isTissueVisible ? "Hide" : "Show"}</span>
        </Button>
      );
    }

    if (panel.type === 'MuskClassification') {
      return (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={handlePatchAnnotationVisibility}
        >
          {isPatchVisible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          <span className="sr-only">{isPatchVisible ? "Hide" : "Show"}</span>
        </Button>
      );
    }

    return null;
  };

  return (
    <div className="flex items-center space-x-2">
      {renderVisibilityButton()}
      {renderActionButton()}
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0"
        onClick={onShowLogs}
        disabled={!logMetadata?.logPath || !onShowLogs}
        title={logMetadata?.logPath ? "View Logs" : "Logs unavailable"}
      >
        <SquareTerminal className="h-4 w-4" />
        <span className="sr-only">View Logs</span>
      </Button>
      <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => onDelete(panel.id)}>
        <Trash2 className="h-4 w-4 text-red-500" />
        <span className="sr-only">Delete Model</span>
      </Button>
    </div>
  );
}; 
