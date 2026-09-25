"use client";
import { usePathWriteAccess } from "@/hooks/usePathWriteAccess"
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AI_SERVICE_API_ENDPOINT } from '@/config/api.config';
import { AppDispatch, RootState, store } from "@/store";
import { clearSelectedModelForPath, selectSelectedModelForPath } from "@/store/slices/chat/modelSelectionSlice";
import { setPatchClassifierPath, setPatchClassifierSavePath, setUpdateClassifier, setUpdatePatchAfterEveryAnnotation } from "@/store/slices/chat/workflowSlice";
import {
  clearPatchOverrides,
  PatchClassificationData,
  selectPatchClassificationData,
  setPatchClassificationData,
} from "@/store/slices/viewer/annotationSlice";
import { useRefreshGtHighlightIndices } from '@/hooks/viewer/useRefreshGtHighlightIndices';
import eventBus from '@/utils/common/eventBus';
import { apiFetch } from '@/utils/common/apiFetch'
import { segFetch } from '@/utils/common/segFetch';
import { getErrorMessage } from '@/utils/common/apiResponse';
import { isNegativeControl, mergePatchClassificationData, NEGATIVE_CONTROL_CLASS_NAME, NEGATIVE_CONTROL_COLOR, normalizePatchClassificationData } from "@/utils/agent/patchClassification.utils";
import { formatPath } from "@/utils/common/path.utils";
;
import {
  getDefaultOutputPath,
  prepareAndStartClassificationWorkflow,
  registerPatchClassOperationsBridge,
  normalizePendingClassOperations,
} from '@/utils/agent/workflow/workflow.utils';
import { PatchReviewDialog } from "@/components/imageViewer/review/PatchReviewDialog";
import { setReviewSession } from "@/store/slices/reviewSlice";
import type { AnnotationClass } from "@/store/slices/viewer/annotationSlice";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useActiveSlidePath } from "@/utils/viewer/slidePath";
import { toast } from 'sonner';
import { ClassificationFooter } from "./card/ClassificationFooter";
import { ClassificationHeader } from "./card/ClassificationHeader";
import { ClassifierStatusBanner } from "./card/ClassifierStatusBanner";
import { PatchClassRow } from "./card/Patch-ClassRow";
import { cellTypeOptions } from "@/constants/workflow.constants";
import {
  getClassifierDisplayBasename,
  getContentStringValue,
  hasClassifierLoaded,
  removeClassifierPathContent,
} from "@/utils/agent/workflow/panelContent";
import { PatchClassificationPanelProps } from "@/types/workflow.types";
import { InlineSpinner } from '@/components/assets/PageLoading';

const DEFAULT_PATCH_CLASS_NAME = NEGATIVE_CONTROL_CLASS_NAME;
// Negative control must always use the fixed color
const getDefaultPatchClassColor = (): string => {
  return NEGATIVE_CONTROL_COLOR;
};
// Initialize default patch data dynamically
const getDefaultPatchData = () => ({
  class_id: [0],
  class_name: [DEFAULT_PATCH_CLASS_NAME],
  class_hex_color: [getDefaultPatchClassColor()],
  class_counts: [0],
});

export const PatchClassificationPanel: React.FC<PatchClassificationPanelProps> = ({
  panel,
  onContentChange,
  modelId,
  clearTissueSegmentationOnReset,
  graphStartWorkflow,
  classifierMode = "multiclass",
  onOvrLoadClass,
  onClearLoadedClassifier,
}) => {
  // Route the "Update" run to the active patch classifier node; fall back to
  // MUSK for older callers that don't pass modelId.
  const patchClassifyNodeId = modelId || "MuskClassification";

  // One-vs-rest: per-class attached .tlcls, stored as JSON in panel.content under
  // `classifier_paths` ({className: absolutePath}). Mirrors the cell panel.
  const ovrClassifierPaths = useMemo<Record<string, string>>(() => {
    const v = panel.content.find(item => item.key === 'classifier_paths')?.value;
    if (typeof v === 'string' && v) {
      try { return JSON.parse(v) as Record<string, string>; } catch { return {}; }
    }
    return {};
  }, [panel.content]);
  const clearOvrClassifier = useCallback((className: string) => {
    const map = { ...ovrClassifierPaths };
    delete map[className];
    const newContent = panel.content.some(it => it.key === 'classifier_paths')
      ? panel.content.map(it => it.key === 'classifier_paths' ? { ...it, value: JSON.stringify(map) } : it)
      : [...panel.content, { key: 'classifier_paths', type: 'input', value: JSON.stringify(map) }];
    onContentChange(panel.id, { ...panel, content: newContent });
  }, [ovrClassifierPaths, panel, onContentChange]);
  // One-vs-rest: per-class TRAIN+SAVE destinations, stored as JSON in panel.content
  // under `save_classifier_paths` ({className: absolutePath}). Assembled by the OvR
  // Save dialog; each class configured here will be trained + written on the next run.
  const ovrSaveClassifierPaths = useMemo<Record<string, string>>(() => {
    const v = panel.content.find(item => item.key === 'save_classifier_paths')?.value;
    if (typeof v === 'string' && v) {
      try { return JSON.parse(v) as Record<string, string>; } catch { return {}; }
    }
    return {};
  }, [panel.content]);
  const clearOvrSaveClassifier = useCallback((className: string) => {
    const map = { ...ovrSaveClassifierPaths };
    delete map[className];
    const newContent = panel.content.some(it => it.key === 'save_classifier_paths')
      ? panel.content.map(it => it.key === 'save_classifier_paths' ? { ...it, value: JSON.stringify(map) } : it)
      : [...panel.content, { key: 'save_classifier_paths', type: 'input', value: JSON.stringify(map) }];
    onContentChange(panel.id, { ...panel, content: newContent });
  }, [ovrSaveClassifierPaths, panel, onContentChange]);
  const isOvrModePatch = classifierMode === "one-vs-rest";
  const dispatch = useDispatch<AppDispatch>();
  const patchClassificationData = useSelector(selectPatchClassificationData);
  const updatePatchAfterEveryAnnotation = useSelector((state: any) => state.workflow.updatePatchAfterEveryAnnotation as boolean);
  const patchClassifierPath = useSelector((state: any) => state.workflow.patchClassifierPath as string | null);
  const patchClassifierSavePath = useSelector((state: any) => state.workflow.patchClassifierSavePath as string | null);
  const updateClassifier = useSelector((state: any) => state.workflow.updateClassifier as boolean);
  const [showModal, setShowModal] = useState(false);
  const [newClassName, setNewClassName] = useState(cellTypeOptions[0]);
  const [newClassColor, setNewClassColor] = useState('#' + Math.floor(Math.random()*16777215).toString(16));
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [selectedClassIndex, setSelectedClassIndex] = useState<number>(0);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [showPatchReview, setShowPatchReview] = useState(false);
  const promptInitRef = useRef<string | null>(null);
  const debounceTimeoutId = useRef<NodeJS.Timeout | null>(null);
  const pendingRenameOpsRef = useRef<Array<{ from: string; to: string }>>([]);
  const pendingAddOpsRef = useRef<Array<{ name: string; color?: string }>>([]);

  // Expose pending class ops to Graph-owned auto-update while this panel is mounted.
  useEffect(() => {
    registerPatchClassOperationsBridge(
      () => ({
        renames: pendingRenameOpsRef.current,
        adds: pendingAddOpsRef.current,
      }),
      () => {
        pendingRenameOpsRef.current = [];
        pendingAddOpsRef.current = [];
      }
    );
    return () => registerPatchClassOperationsBridge(null, null);
  }, []);
  
  const currentPath = useActiveSlidePath();
  const selectedFolder = useSelector((state: RootState) => state.fileManager.selectedFolder);
  const { assertWritable, allowed: pathWritable, tooltip: writeBlockTitle } = usePathWriteAccess(currentPath || selectedFolder);

  const [formattedPath, setFormattedPath] = useState(formatPath(currentPath ?? ""));
  
  // Get current path and selected model from FileBrowserSidebar
  const activeInstanceId = useSelector((state: RootState) => state.wsi.activeInstanceId);

  const isWebMode = useSelector((state: RootState) => {
    const activeInstanceId = state.wsi.activeInstanceId;
    const instances = state.wsi.instances;
    const activeInstance = activeInstanceId ? instances[activeInstanceId] : undefined;
    const source = activeInstance?.fileInfo?.source as string | undefined;
    return source === 'web';
  });
  
  // Get selected model for current path from FileBrowserSidebar
  const selectedModelForCurrentPath = useSelector((state: RootState) => {
    // Use selectedFolder if available, otherwise try to get parent directory from currentPath
    let targetPath = selectedFolder || '';
    if (!targetPath && currentPath) {
      const separator = isWebMode ? '/' : (currentPath.includes('\\') ? '\\' : '/');
      const lastIndex = currentPath.lastIndexOf(separator);
      targetPath = lastIndex !== -1 ? currentPath.substring(0, lastIndex) : (isWebMode ? '' : currentPath);
    }
    // In web mode, empty string means root directory
    if (isWebMode && targetPath === '') {
      targetPath = '';
    }
    return selectSelectedModelForPath(state, targetPath);
  });

  const normalizedPatchData = normalizePatchClassificationData(patchClassificationData as PatchClassificationData);
  // Patch classes in the shape the review panel (kind="patch") expects
  const patchReviewClasses: AnnotationClass[] = useMemo(
    () => (normalizedPatchData?.class_name || []).map((name: string, i: number) => ({
      name,
      color: normalizedPatchData.class_hex_color?.[i] || '#aaaaaa',
      count: normalizedPatchData.class_counts?.[i] ?? 0,
    })),
    [normalizedPatchData],
  );
  const refreshGtHighlightIndices = useRefreshGtHighlightIndices();
  const classifierLoadPath = useMemo(() => {
    const value = panel.content.find(item => item.key === "classifier_path")?.value;
    return typeof value === "string" ? value.trim() : "";
  }, [panel.content]);
  const hasClassifierApplied = Boolean(selectedModelForCurrentPath) || Boolean(classifierLoadPath);

  const ensureHash = (hex: string | undefined | null): string => {
    if (!hex) return '#000000';
    return hex.startsWith('#') ? hex : `#${hex}`;
  };

  // When a classifier is applied, force panel classes/colors/counts to follow backend
  // so all classes inside classifier are always visible in panel.
  const syncPatchClassesFromBackendIfClassifier = useCallback(async () => {
    if (!formattedPath || !hasClassifierApplied) return;
    try {
      const resp = await segFetch(activeInstanceId, `${AI_SERVICE_API_ENDPOINT}/seg/v1/patch_classification`, {
        method: 'GET',
        
        returnAxiosFormat: true,
      });
      const payload = resp?.data?.data ?? resp?.data;
      if (!payload || !Array.isArray(payload.class_name) || payload.class_name.length === 0) {
        return;
      }

      const coerceCounts = (values: unknown, targetLength: number): number[] => {
        if (!Array.isArray(values)) return new Array(targetLength).fill(0);
        return values.map((value) => {
          const numeric = Number(value);
          return Number.isFinite(numeric) ? numeric : 0;
        });
      };

      const names = payload.class_name.map((nameVal: unknown) => String(nameVal ?? ""));
      const colors = names.map((name: string, i: number) => {
        if (isNegativeControl(name)) return NEGATIVE_CONTROL_COLOR;
        const raw = Array.isArray(payload.class_hex_color) ? payload.class_hex_color[i] : undefined;
        return ensureHash(typeof raw === "string" ? raw : "#aaaaaa");
      });
      const classIds = Array.isArray(payload.class_id)
        ? payload.class_id.map((idVal: unknown, i: number) => {
            const n = Number(idVal);
            return Number.isFinite(n) ? n : i;
          })
        : names.map((_: string, i: number) => i);
      const counts = coerceCounts(payload.class_counts, names.length);

      dispatch(setPatchClassificationData({
        class_id: classIds,
        class_name: names,
        class_hex_color: colors,
        class_counts: counts,
      } as any));
    } catch (e) {
      console.warn('[PatchClassificationPanel] Failed to sync patch classes from backend in classifier mode', e);
    }
  }, [formattedPath, hasClassifierApplied, dispatch, activeInstanceId]);

  useEffect(() => {
    if (isWebMode) {
      // In web mode, always use forward slashes
      setFormattedPath((currentPath ?? "").replace(/\\/g, "/"));
    } else {
      // In desktop mode, use formatPath for OS-specific formatting
      setFormattedPath(formatPath(currentPath ?? ""));
    }
  }, [currentPath, isWebMode]);

  useEffect(() => {
    void syncPatchClassesFromBackendIfClassifier();
  }, [formattedPath, hasClassifierApplied, syncPatchClassesFromBackendIfClassifier]);

  useEffect(() => {
    const refreshHandler = () => {
      void syncPatchClassesFromBackendIfClassifier();
    };
    eventBus.on('refresh-patches', refreshHandler);
    eventBus.on('refresh-websocket-path', refreshHandler);
    return () => {
      eventBus.off('refresh-patches', refreshHandler);
      eventBus.off('refresh-websocket-path', refreshHandler);
    };
  }, [syncPatchClassesFromBackendIfClassifier]);

  // Auto-update panel content when selected model changes in FileBrowserSidebar (same rules as nuclei panel + graph load).
  // If a classifier is already loaded (path set), the file browser does NOT silently override it.
  useEffect(() => {
    if (selectedModelForCurrentPath) {
      let modelPath;
      if (isWebMode) {
        modelPath = `${selectedFolder || ''}/${selectedModelForCurrentPath}`.replace(/\/+/g, '/');
      } else {
        modelPath = `${selectedFolder || ''}\\${selectedModelForCurrentPath}`.replace(/\\+/g, '\\');
      }

      let newContent = [...panel.content];
      const loadIndex = newContent.findIndex((item) => item.key === "classifier_path");
      const saveIndex = newContent.findIndex((item) => item.key === "save_classifier_path");

      if (loadIndex > -1) {
        newContent[loadIndex] = { ...newContent[loadIndex], value: modelPath };
      } else {
        newContent.push({ key: "classifier_path", type: "input", value: modelPath });
      }

      if (updateClassifier) {
        if (saveIndex > -1) {
          newContent[saveIndex] = { ...newContent[saveIndex], value: modelPath };
        } else {
          newContent.push({ key: "save_classifier_path", type: "input", value: modelPath });
        }
      } else if (saveIndex > -1) {
        newContent.splice(saveIndex, 1);
      }

      dispatch(setPatchClassifierPath(modelPath));
      dispatch(setPatchClassifierSavePath(updateClassifier ? modelPath : null));
      onContentChange(panel.id, { ...panel, content: newContent });
      return;
    }

    if (hasClassifierLoaded(panel.content)) {
      return;
    }

    let newContent = [...panel.content];
    const loadIndex = newContent.findIndex((item) => item.key === "classifier_path");
    const saveIndex = newContent.findIndex((item) => item.key === "save_classifier_path");
    if (loadIndex > -1) {
      newContent.splice(loadIndex, 1);
    }
    if (saveIndex > -1) {
      const adjustedSaveIndex = saveIndex > loadIndex ? saveIndex - 1 : saveIndex;
      newContent.splice(adjustedSaveIndex, 1);
    }
    dispatch(setPatchClassifierPath(null));
    dispatch(setPatchClassifierSavePath(null));
    onContentChange(panel.id, { ...panel, content: newContent });
  }, [selectedModelForCurrentPath, selectedFolder, isWebMode, updateClassifier]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ensure Negative Control class exists
  useEffect(() => {
    if (!patchClassificationData || !Array.isArray(patchClassificationData.class_name) || patchClassificationData.class_name.length === 0) {
      dispatch(setPatchClassificationData(getDefaultPatchData() as any));
      return;
    }

    const normalized = normalizePatchClassificationData(patchClassificationData as PatchClassificationData);
    if (normalized.class_name.length !== patchClassificationData.class_name.length) {
      dispatch(setPatchClassificationData(normalized as any));
    }
  }, [patchClassificationData, dispatch]);

  useEffect(() => {
    try {
      const promptValue = panel.content.find(item => item.key === "prompt")?.value;
      const promptKey = `${panel.id}::${typeof promptValue === 'string' ? promptValue : JSON.stringify(promptValue ?? '')}`;
      if (promptInitRef.current === promptKey) {
        return;
      }
      promptInitRef.current = promptKey;

      let promptContent: { tissue_classes?: string[] } | undefined = undefined;
      if (promptValue) {
        if (typeof promptValue === 'string') {
          try {
            promptContent = JSON.parse(promptValue) as { tissue_classes?: string[] };
          } catch (e) {
            let classString = promptValue;
            if (classString.includes('=')) {
              classString = classString.substring(classString.indexOf('=') + 1).trim();
              // Remove surrounding quotes if present (handles various quote types)
              classString = classString.replace(/^["'`](.*)["'`]$/, '$1');
            }
            
            const classes = classString
              .split(',')
              .map(s => s.trim())
              .filter(Boolean);
            if (classes.length > 0) {
              promptContent = { tissue_classes: classes };
            }
          }
        } else {
          promptContent = promptValue as { tissue_classes?: string[] };
        }
      }

      if (promptContent && Array.isArray(promptContent.tissue_classes)) {
        const normalizedPromptClasses = promptContent.tissue_classes
          .map(className => (typeof className === 'string' ? className.trim() : ''))
          .filter(Boolean);

        if (normalizedPromptClasses.length === 0) {
          return;
        }

        const normalized = normalizePatchClassificationData(patchClassificationData as PatchClassificationData);
        const hasBackendClasses = normalized.class_counts && 
          normalized.class_counts.some((count: number) => count > 0);

        if (hasBackendClasses) {
          const currentClassNames = normalized.class_name.map((n: string) => n.toLowerCase());
          const newClasses: string[] = [];
          
          normalizedPromptClasses.forEach((className: string) => {
            if (!currentClassNames.includes(className.toLowerCase())) {
              newClasses.push(className);
            }
          });
          
          if (newClasses.length > 0) {
            const incoming: PatchClassificationData = {
              class_id: newClasses.map((_, idx) => normalized.class_id.length + idx),
              class_name: newClasses,
              class_hex_color: newClasses.map(name =>
                isNegativeControl(name)
                  ? getDefaultPatchClassColor()
                  : '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')
              ),
            };
            
            const merged = mergePatchClassificationData(patchClassificationData as PatchClassificationData, incoming);
            dispatch(setPatchClassificationData(merged as any));
          }
        } else {
          const currentClassNames = normalized.class_name.map((n: string) => n.toLowerCase());
          const toAdd: string[] = [];
          const toKeep = new Set<string>();
          
          normalizedPromptClasses.forEach((className: string) => {
            const lowerName = className.toLowerCase();
            toKeep.add(lowerName);
            if (!currentClassNames.includes(lowerName)) {
              toAdd.push(className);
            }
          });
          
          const toRemoveIndices: number[] = [];
          normalized.class_name.forEach((name: string, idx: number) => {
            if (!toKeep.has(name.toLowerCase())) {
              toRemoveIndices.push(idx);
            }
          });
          
          let finalData = normalized;
          
          if (toRemoveIndices.length > 0) {
            finalData = {
              class_id: normalized.class_id.filter((_: any, idx: number) => !toRemoveIndices.includes(idx)),
              class_name: normalized.class_name.filter((_: any, idx: number) => !toRemoveIndices.includes(idx)),
              class_hex_color: normalized.class_hex_color.filter((_: any, idx: number) => !toRemoveIndices.includes(idx)),
              ...(normalized.class_counts ? {
                class_counts: normalized.class_counts.filter((_: any, idx: number) => !toRemoveIndices.includes(idx))
              } : {})
            };
          }
          
          if (toAdd.length > 0) {
            const incoming: PatchClassificationData = {
              class_id: toAdd.map((_, idx) => finalData.class_id.length + idx),
              class_name: toAdd,
              class_hex_color: toAdd.map(name =>
                isNegativeControl(name)
                  ? getDefaultPatchClassColor()
                  : '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')
              ),
            };
            
            finalData = mergePatchClassificationData(finalData, incoming);
          }
          
          if (
            !patchClassificationData ||
            finalData.class_name.length !== normalized.class_name.length ||
            finalData.class_name.some((name: string, idx: number) => name !== normalized.class_name[idx])
          ) {
            dispatch(setPatchClassificationData(finalData as any));
          }
        }
      }
    } catch (error) {
      console.error('Error in workflow input processing:', error);
    }
  }, [panel, dispatch, patchClassificationData]);

  // Cleanup debounce timeout on unmount
  useEffect(() => {
    return () => {
      if (debounceTimeoutId.current) {
        clearTimeout(debounceTimeoutId.current);
      }
    };
  }, []);

  const handleAddClass = () => {
    const currentData = normalizePatchClassificationData(patchClassificationData as PatchClassificationData);
    const nextData: PatchClassificationData = {
      class_id: [...currentData.class_id],
      class_name: [...currentData.class_name],
      class_hex_color: [...currentData.class_hex_color],
      ...(currentData.class_counts ? { class_counts: [...currentData.class_counts] } : {}),
    };
    
    if (editingIndex !== null) {
      const oldName = String(nextData.class_name[editingIndex] ?? "").trim();
      nextData.class_name[editingIndex] = newClassName;
      nextData.class_hex_color[editingIndex] = newClassColor;
      const newName = String(newClassName ?? "").trim();
      if (oldName && newName && oldName !== newName) {
        pendingRenameOpsRef.current.push({ from: oldName, to: newName });
      }
    } else {
      const newId = nextData.class_id.length > 0 ? Math.max(...nextData.class_id) + 1 : 0;
      nextData.class_id.push(newId);
      nextData.class_name.push(newClassName);
      nextData.class_hex_color.push(newClassColor);
      pendingAddOpsRef.current.push({ name: String(newClassName ?? "").trim(), color: newClassColor });
      if (nextData.class_counts) {
        nextData.class_counts.push(0);
      }
    }

    dispatch(setPatchClassificationData(nextData as any));
    
    setShowModal(false);
    setNewClassName(cellTypeOptions[0]);
    setNewClassColor('#' + Math.floor(Math.random()*16777215).toString(16));
    setEditingIndex(null);
  };
  
  const openAddClassModal = () => {
    setShowModal(true);
  };
  
  const editClass = (index: number) => {
    if (patchClassificationData) {
      const normalized = normalizePatchClassificationData(patchClassificationData as PatchClassificationData);
      setNewClassName(normalized.class_name[index]);
      setNewClassColor(normalized.class_hex_color[index]);
      setEditingIndex(index);
      setShowModal(true);
    }
  };
  
  const deleteClass = (index: number) => {
    if (!assertWritable('delete a patch classification')) {
      return;
    }
    if (patchClassificationData) {
      const normalized = normalizePatchClassificationData(patchClassificationData as PatchClassificationData);
      const removedName = String(normalized.class_name[index] ?? "").trim();
      const nextData: PatchClassificationData = {
        class_id: normalized.class_id.filter((_, i) => i !== index),
        class_name: normalized.class_name.filter((_, i) => i !== index),
        class_hex_color: normalized.class_hex_color.filter((_, i) => i !== index),
        ...(normalized.class_counts
          ? { class_counts: normalized.class_counts.filter((_, i) => i !== index) }
          : {}),
      };

      if (removedName) {
        pendingAddOpsRef.current = pendingAddOpsRef.current.filter(op => op.name !== removedName);
        pendingRenameOpsRef.current = pendingRenameOpsRef.current.filter(op => op.from !== removedName && op.to !== removedName);
      }
      
      dispatch(setPatchClassificationData(nextData as any));
      
      if (selectedClassIndex === index) {
        setSelectedClassIndex(0);
      } else if (selectedClassIndex > index) {
        setSelectedClassIndex(selectedClassIndex - 1);
      }
    }
  };
  
  const handleReset = async () => {
    if (!assertWritable('reset patch classification')) {
      setShowResetConfirm(false);
      return;
    }
    setIsResetting(true);
    try {
      // Backend cleanup: remove Patch-Classification datasets and /user_annotation
      const zarrPath = getDefaultOutputPath(currentPath || '');
      if (!zarrPath) {
        toast.warning('No Zarr path resolved for cleanup. UI reset only.');
        const snap = normalizePatchClassificationData(patchClassificationData as PatchClassificationData);
        const baseline: PatchClassificationData =
          snap.class_name.length > 0
            ? {
                class_id: [...snap.class_id],
                class_name: [...snap.class_name],
                class_hex_color: [...snap.class_hex_color],
                class_counts: snap.class_name.map(() => 0),
              }
            : getDefaultPatchData();
        dispatch(setPatchClassificationData(baseline as PatchClassificationData));
        dispatch(clearPatchOverrides()); // wipe persisted manual-annotation color overrides, else refetch re-applies them
        refreshGtHighlightIndices(currentPath);
        eventBus.emit('refresh-patches');
        setIsResetting(false);
        return;
      }
      
      try {
        const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/reset_patch_classification`, {
          method: 'POST',
          body: JSON.stringify({
            zarr_path: zarrPath
          }),
          returnAxiosFormat: true,
        });

        // VISTA reuses this panel: its tissue masks are downstream of the patch
        // classification we just reset, so clear Tissue-Segmentation too (separate
        // endpoint — the MUSK/H-optimus/Virchow panels do NOT clear it).
        if (clearTissueSegmentationOnReset) {
          try {
            await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/reset_tissue_segmentation`, {
              method: 'POST',
              body: JSON.stringify({ zarr_path: zarrPath }),
              returnAxiosFormat: true,
            });
          } catch (e) {
            console.error('Failed to reset tissue segmentation:', e);
          }
        }

        const json = response.data;
        if (json && (json.code === 0 || json.status === 'success')) {
          toast.success('Cleared patch classification data in Zarr.');

          const snap = normalizePatchClassificationData(patchClassificationData as PatchClassificationData);
          const baselineSnapshot: PatchClassificationData =
            snap.class_name.length > 0
              ? {
                  class_id: [...snap.class_id],
                  class_name: [...snap.class_name],
                  class_hex_color: [...snap.class_hex_color],
                  class_counts: snap.class_name.map(() => 0),
                }
              : getDefaultPatchData();
          dispatch(setPatchClassificationData(baselineSnapshot));
          dispatch(clearPatchOverrides()); // wipe persisted manual-annotation color overrides, else refetch re-applies them
          refreshGtHighlightIndices(currentPath);

          // Request fresh viewport patches from the clean handler.
          eventBus.emit('refresh-patches');

          // Secondary path notification for other listeners; do not gate reset UI on it.
          const wsPath = zarrPath.replace(/\.(zarr)$/i, '');
          eventBus.emit('refresh-websocket-path', { path: wsPath, forceReload: true });
          setIsResetting(false);
        } else {
          toast.error(json?.message || 'Failed to clear patch classification in Zarr');
          setIsResetting(false);
        }
      } catch (error) {
        console.error('Network error while clearing patch classification:', error);
        toast.error(getErrorMessage(error, 'Failed to clear patch classification in Zarr'));
        setIsResetting(false);
      }
    } catch (e) {
      console.error('Error in handleReset:', e);
      setIsResetting(false);
      // no-op for UI safety
    } finally {
      setShowResetConfirm(false);
    }
  };

  const handleClassSelect = (index: number) => {
    setSelectedClassIndex(index);
  };

  // Handle color change with optimistic update (no API call, will be saved on Update button click)
  const handleColorChange = (index: number, newColor: string) => {
    const normalized = normalizePatchClassificationData(patchClassificationData as PatchClassificationData);
    const originalClass = normalized.class_name[index];
    
    // Prevent color change for 'Negative control' - it must always use the fixed color
    if (isNegativeControl(originalClass)) {
      return; // Do not allow color changes for Negative control
    }
    
    const newColors = [...normalized.class_hex_color];
    newColors[index] = newColor;
    const updated: PatchClassificationData = {
      ...normalized,
      class_hex_color: newColors,
    };
    
    // Optimistic update: dispatch immediately for instant UI feedback
    dispatch(setPatchClassificationData(updated as any));
    
    // Note: No API call here - color will be saved to backend via workflow payload when Update is clicked
    // This matches the desired behavior: frontend updates immediately, backend updates on Update button click
  };

  // Path management is now handled entirely by FileBrowserSidebar
  const handlePathChange = (type: 'load' | 'save', value: string | null) => {
    // Update Redux state for patch classification
    if (type === 'save') {
      dispatch(setPatchClassifierSavePath(value));
    } else {
      dispatch(setPatchClassifierPath(value));
    }

    // Update panel content with FileBrowserSidebar selected path
    let newContent = [...panel.content];
    const key = type === 'save' ? "save_classifier_path" : "classifier_path";
    const itemIndex = newContent.findIndex(item => item.key === key);
    
    if (value) {
      if (itemIndex > -1) {
        newContent[itemIndex] = { ...newContent[itemIndex], value };
      } else {
        newContent.push({ key, type: 'input', value });
      }
    } else {
      if (itemIndex > -1) {
        newContent.splice(itemIndex, 1);
      }
    }

    onContentChange(panel.id, { ...panel, content: newContent });
  };

  // Rename only the request path shown in the status banner (classifier_path /
  // save_classifier_path) — does NOT rename the on-disk .tlcls file. Keeps the
  // original directory + extension and swaps the basename.
  const renamePathBasename = (oldPath: string, newName: string): string => {
    const sep = oldPath.includes("\\") ? "\\" : "/";
    const idx = oldPath.lastIndexOf(sep);
    const dir = idx >= 0 ? oldPath.slice(0, idx + 1) : "";
    const stem = newName.replace(/\.tlcls$/i, "").trim();
    return `${dir}${stem}.tlcls`;
  };
  const handleClassifierRename = (newName: string) => {
    const old = getContentStringValue(panel.content, "classifier_path");
    if (!old || !newName.trim()) return;
    handlePathChange("load", renamePathBasename(old, newName));
  };
  const handleSaveClassifierRename = (newName: string) => {
    const old = getContentStringValue(panel.content, "save_classifier_path");
    if (!old || !newName.trim()) return;
    handlePathChange("save", renamePathBasename(old, newName));
  };

  // Clear the "Selected Classifier" banner: drop classifier_* keys from the
  // panel content AND clear the FileBrowser-side Redux selection for the same
  // path the selector above reads from.
  const handleClassifierClear = useCallback(() => {
    let targetPath = selectedFolder || '';
    if (!targetPath && currentPath) {
      const separator = isWebMode ? '/' : (currentPath.includes('\\') ? '\\' : '/');
      const lastIndex = currentPath.lastIndexOf(separator);
      targetPath = lastIndex !== -1 ? currentPath.substring(0, lastIndex) : (isWebMode ? '' : currentPath);
    }
    dispatch(clearSelectedModelForPath(targetPath));
    // The update target is the selected classifier; clearing one clears both.
    dispatch(setUpdateClassifier(false));
    const stripped = removeClassifierPathContent(panel.content).filter(
      (item) => item.key !== "classifier_display_name"
    );
    onContentChange(panel.id, { ...panel, content: stripped });
    // Graph nodes cache the load in node.loadedClassifier (dock "Loaded: …" chip).
    onClearLoadedClassifier?.();
  }, [dispatch, selectedFolder, currentPath, isWebMode, panel, onContentChange, onClearLoadedClassifier]);

  // Handle update classifier checkbox change
  const handleUpdateClassifierChange = (checked: boolean) => {
    dispatch(setUpdateClassifier(checked));

    if (checked && selectedModelForCurrentPath) {
      let modelPath;
      if (isWebMode) {
        modelPath = `${selectedFolder || ''}/${selectedModelForCurrentPath}`.replace(/\/+/g, '/');
      } else {
        modelPath = `${selectedFolder || ''}\\${selectedModelForCurrentPath}`.replace(/\\+/g, '\\');
      }
      handlePathChange('load', modelPath);
      handlePathChange('save', modelPath);
    } else if (checked) {
      const load = getContentStringValue(panel.content, "classifier_path");
      if (load) {
        handlePathChange('save', load);
      }
    } else if (!checked) {
      handlePathChange('save', null);
    }
  };

  const patchPanelClassifierLoadPath = getContentStringValue(panel.content, "classifier_path");
  const patchClassifierResolvedForUpdate =
    Boolean(selectedModelForCurrentPath) || Boolean(patchPanelClassifierLoadPath?.trim());

  const handlePatchUpdate = useCallback(async () => {
    if (store.getState().workflow.isRunning) {
      toast.message('A workflow is already running. Wait for it to finish, or stop it first.');
      return;
    }
    // Check if in samples directory
    if (!assertWritable('update panel')) {
      return;
    }

    try {
      const zarrPath = getDefaultOutputPath(formattedPath);
      if (!zarrPath) {
        toast.warning('No Zarr path resolved.');
        return;
      }
      if (!patchClassificationData || !patchClassificationData.class_name || patchClassificationData.class_name.length === 0) {
        toast.warning('Please add at least one tissue class before updating.');
        return;
      }

      let finalLoadPath = getContentStringValue(panel.content, "classifier_path");
      let finalSavePath = getContentStringValue(panel.content, "save_classifier_path");

      if (!updateClassifier) {
        finalSavePath = null;
      }

      finalLoadPath = finalLoadPath ?? null;
      finalSavePath = finalSavePath ?? null;

      const classOperations = normalizePendingClassOperations({
        renames: pendingRenameOpsRef.current,
        adds: pendingAddOpsRef.current,
      });

      // One-vs-rest: derive a per-class save destination ({class: <dir>/<class>.tlcls})
      // from the single save path so the tasknode trains one binary per class.
      // Negative control is never an OvR target.
      const isOvr = classifierMode === "one-vs-rest";
      // Prefer an explicit scoped map written by the One-vs-Rest Save dialog (train
      // only the chosen classes); otherwise derive one path per class.
      const explicitOvrSavePaths = (() => {
        const v = panel.content.find(it => it.key === 'save_classifier_paths')?.value;
        if (typeof v === 'string' && v) {
          try { const o = JSON.parse(v); if (o && typeof o === 'object' && Object.keys(o).length) return o as Record<string, string>; } catch { /* ignore */ }
        }
        return undefined;
      })();
      const ovrSavePaths = !isOvr
        ? undefined
        : explicitOvrSavePaths ?? (finalSavePath
            ? (() => {
                const norm = finalSavePath.replace(/\\/g, "/");
                const dir = norm.includes("/") ? norm.slice(0, norm.lastIndexOf("/")) : "";
                const out: Record<string, string> = {};
                for (const name of normalizedPatchData.class_name) {
                  if (String(name).trim().toLowerCase() === "negative control") continue;
                  const safe = String(name).replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_").slice(0, 120) || "class";
                  out[name] = dir ? `${dir}/${safe}.tlcls` : `${safe}.tlcls`;
                }
                return Object.keys(out).length ? out : undefined;
              })()
            : undefined);
      // Explicit per-class attachments the user Loaded onto rows (skip NC / blank).
      const ovrLoadPaths = isOvr
        ? (() => {
            const out: Record<string, string> = {};
            for (const [name, p] of Object.entries(ovrClassifierPaths)) {
              if (!p || String(name).trim().toLowerCase() === "negative control") continue;
              out[name] = p;
            }
            return Object.keys(out).length ? out : undefined;
          })()
        : undefined;

      const workflowPayload = {
        zarr_path: zarrPath,
        step1: {
          nodeId: patchClassifyNodeId,
          input: {
            tissue_classes: normalizedPatchData.class_name,
            tissue_colors: normalizedPatchData.class_hex_color,
            classifier_path: finalLoadPath,
            save_classifier_path: finalSavePath,
            classifier_mode: classifierMode,
            ...(ovrSavePaths ? { save_classifier_paths: ovrSavePaths } : {}),
            ...(ovrLoadPaths ? { classifier_paths: ovrLoadPaths } : {}),
            ...(classOperations ? { class_operations: classOperations } : {}),
          },
        },
      };

      if (!graphStartWorkflow) {
        toast.error('Workflow starter is unavailable. Open this panel from the workflow graph.');
        return;
      }
      await prepareAndStartClassificationWorkflow({
        dispatch,
        startWorkflow: graphStartWorkflow,
        payload: workflowPayload as Record<string, unknown>,
        refreshTissuePatches: true,
      });

      pendingRenameOpsRef.current = [];
      pendingAddOpsRef.current = [];
    } catch (e) {
      console.error('Failed to trigger patch classification workflow:', e);
      toast.error(getErrorMessage(e, 'Failed to start patch classification update'));
    }
  }, [
    currentPath,
    selectedFolder,
    formattedPath,
    patchClassificationData,
    panel.content,
    updateClassifier,
    dispatch,
    normalizedPatchData.class_name,
    normalizedPatchData.class_hex_color,
    graphStartWorkflow,
    patchClassifyNodeId,
  ]);

  return (
    <div className="bg-card overflow-hidden">
      {/* Section header: title + primary actions + toggle */}
      <ClassificationHeader
        title="Tissue"
        titleId="Tissues"
        updateClassifierId={`updateClassifier-${panel.id}`}
        updateClassifierChecked={updateClassifier}
        onUpdateClassifierChange={handleUpdateClassifierChange}
        updateClassifierDisabled={!patchClassifierResolvedForUpdate}
        updateClassifierTitle={
          selectedModelForCurrentPath
            ? "Update the selected classifier"
            : patchPanelClassifierLoadPath
              ? "Update the classifier file loaded into this node (same path as load)"
              : "No classifier selected"
        }
        onAddClass={openAddClassModal}
        onReset={() => setShowResetConfirm(true)}
        newClassVariant="outline"
        resetVariant="outline"
        writeDisabled={!pathWritable}
        writeDisabledTitle={writeBlockTitle}
      />

 
      <div className="pt-1 space-y-1">
        <ClassifierStatusBanner
          selectedModelForCurrentPath={selectedModelForCurrentPath}
          updateClassifier={updateClassifier}
          actualClassifierPath={getContentStringValue(panel.content, "classifier_path")}
          actualSaveClassifierPath={getContentStringValue(panel.content, "save_classifier_path")}
          actualClassifierName={getClassifierDisplayBasename(panel.content)}
          onClear={handleClassifierClear}
          onClearSave={() => handleUpdateClassifierChange(false)}
          onRename={handleClassifierRename}
          onRenameSave={handleSaveClassifierRename}
        />

        {/* Class list: stacked rows with bottom border */}
        <div className="border-t border-border/40 pt-0">
          {normalizedPatchData.class_name.map((className: string, index: number) => (
            <PatchClassRow
              key={index}
              name={className}
              index={index}
              count={normalizedPatchData.class_counts?.[index] ?? 0}
              color={ensureHash(normalizedPatchData.class_hex_color[index])}
              isSelected={selectedClassIndex === index}
              isDeletable={pathWritable && !isNegativeControl(className)}
              onSelect={handleClassSelect}
              onEdit={editClass}
              onDelete={deleteClass}
              onColorChange={(rowIndex, newColor) => {
                // Prevent color change for 'Negative control' - it must always use the fixed color
                const className = normalizedPatchData.class_name[rowIndex];
                if (isNegativeControl(className)) {
                  return; // Do not allow color changes for Negative control
                }
                const newColors = [...normalizedPatchData.class_hex_color];
                newColors[rowIndex] = newColor;
                const updated: PatchClassificationData = {
                  ...normalizedPatchData,
                  class_hex_color: newColors,
                };
                dispatch(setPatchClassificationData(updated as any));
              }}
              writeDisabled={!pathWritable}
              writeDisabledTitle={writeBlockTitle}
              ovrEnabled={pathWritable && isOvrModePatch && !isNegativeControl(className)}
              ovrClassifierName={
                ovrClassifierPaths[className]
                  ? (ovrClassifierPaths[className].replace(/\\/g, '/').split('/').pop() || null)
                  : null
              }
              onOvrLoad={onOvrLoadClass ? () => onOvrLoadClass(className) : undefined}
              onOvrClear={() => clearOvrClassifier(className)}
              ovrSaveName={
                ovrSaveClassifierPaths[className]
                  ? (ovrSaveClassifierPaths[className].replace(/\\/g, '/').split('/').pop() || null)
                  : null
              }
              onOvrSaveClear={() => clearOvrSaveClassifier(className)}
            />
          ))}
        </div>
      
        {/* Update/Review controls */}
        <ClassificationFooter
          updateAfterAnnotationId="updatePatchAfterEveryAnnotation"
          updateAfterAnnotationChecked={updatePatchAfterEveryAnnotation}
          onUpdateAfterAnnotationChange={(checked) => dispatch(setUpdatePatchAfterEveryAnnotation(checked === true))}
          onUpdate={handlePatchUpdate}
          onReview={() => {
            const reviewClass = normalizedPatchData.class_name[selectedClassIndex]
              ?? normalizedPatchData.class_name[0];
            if (!currentPath || !reviewClass) {
              toast.error('Select a slide and a patch class first');
              return;
            }
            dispatch(setReviewSession({ slideId: currentPath, className: reviewClass }));
            setShowPatchReview(true);
          }}
          updateVariant="secondary"
          reviewVariant="default"
          writeDisabled={!pathWritable}
          writeDisabledTitle={writeBlockTitle}
        />

        {/* Patch active-learning review — popup window, mirrors the cell review */}
        <PatchReviewDialog
          open={showPatchReview}
          onClose={() => setShowPatchReview(false)}
          slideId={currentPath}
          reviewClasses={patchReviewClasses}
        />
      </div>

      {/* Reset Confirmation Modal */}
      <Dialog open={showResetConfirm} onOpenChange={(open) => {
        if (!open) {
          setShowResetConfirm(false);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Reset</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            {isResetting ? (
              <div className="flex items-center gap-2 justify-center py-4">
                <InlineSpinner size={20} color="#6352a3" />
                <span className="text-sm text-muted-foreground">Resetting...</span>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Are you sure you want to reset patch classification? This removes tissue patch classification labels and your annotations. The patches will be unclassified.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button 
              variant="secondary" 
              onClick={() => {
                setShowResetConfirm(false);
                setIsResetting(false);
              }}
              disabled={isResetting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleReset}
              disabled={isResetting}
            >
              {isResetting ? (
                <>
                  <InlineSpinner size={16} color="#fff" className="mr-2" />
                  Resetting...
                </>
              ) : (
                'Yes, reset'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add/Edit Class Modal */}
      <Dialog open={showModal} onOpenChange={(open) => {
        if (!open) {
          setShowModal(false);
          setEditingIndex(null);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingIndex !== null ? 'Edit Class' : 'Add New Class'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="tissue-type-select" className="text-muted-foreground">
                Tissue Type:
              </Label>
              <Select
                value={newClassName}
                onValueChange={(value) => setNewClassName(value)}
              >
                <SelectTrigger id="tissue-type-select">
                  <SelectValue placeholder="Select tissue type" />
                </SelectTrigger>
                <SelectContent>
                  {cellTypeOptions.map((option) => (
                    <SelectItem key={option} value={option}>{option}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="custom-tissue-type">
                Or enter custom tissue type:
              </Label>
              <Textarea
                id="custom-tissue-type"
                value={
                  isNegativeControl(newClassName)
                    ? ''
                    : newClassName
                }
                onChange={(e) => setNewClassName(e.target.value)}
                rows={2}
                placeholder="Enter custom tissue type"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="class-color">Color:</Label>
              <Input
                id="class-color"
                type="color"
                value={newClassColor}
                onChange={(e) => {
                  let selectedColor = e.target.value;
                  
                  // If black color is selected, automatically generate a random non-black color
                  if (selectedColor === '#000000') {
                    // Generate a random number between 1 and 16777215 (0xFFFFFF) to avoid 0 (black)
                    const randomNum = Math.floor(Math.random() * 16777214) + 1; // +1 to avoid 0
                    selectedColor = '#' + randomNum.toString(16).padStart(6, '0').toUpperCase();
                  }
                  
                  setNewClassColor(selectedColor);
                }}
                className="h-10 w-full cursor-pointer"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setShowModal(false);
                setEditingIndex(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="default" onClick={handleAddClass}>
              {editingIndex !== null ? 'Save' : 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}; 
