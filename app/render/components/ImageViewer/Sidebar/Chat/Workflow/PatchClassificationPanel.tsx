"use client";
import React, { useState, useEffect, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import { AppDispatch, RootState } from "@/store";
import {
  PatchClassificationData,
  setPatchClassificationData,
  selectPatchClassificationData,
} from "@/store/slices/annotationSlice";
import { PatchClassificationPanelProps } from "./types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Edit, Trash2, MousePointer2, Shapes } from "lucide-react";
import CIcon from "@coreui/icons-react";
import { cilPlus, cilTrash, cilLoop, cilNotes, cilPencil } from "@coreui/icons";
import { CModal, CModalHeader, CModalBody, CModalFooter, CButton, CFormLabel, CFormSelect, CFormTextarea, CFormInput, CFormCheck } from "@coreui/react";
import { formatPath } from "@/utils/pathUtils"
import { cellTypeOptions } from "./constants";
import { useAnnotatorInstance } from "@/contexts/AnnotatorContext";
import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import { getDefaultOutputPath, triggerPatchClassificationWorkflow } from '@/utils/workflowUtils';
import http from '@/utils/http';
import EventBus from '@/utils/EventBus';
import { message } from 'antd';
import { setUpdatePatchAfterEveryAnnotation, setPatchClassifierPath, setPatchClassifierSavePath, setUpdateClassifier } from "@/store/slices/workflowSlice";
import { selectSelectedModelForPath } from "@/store/slices/modelSelectionSlice";
import { mergePatchClassificationData, normalizePatchClassificationData } from "@/utils/patchClassificationUtils";

const DEFAULT_PATCH_CLASS_NAME = 'Negative control';
const DEFAULT_PATCH_CLASS_COLOR = '#aaaaaa';
const DEFAULT_PATCH_DATA = {
  class_id: [0],
  class_name: [DEFAULT_PATCH_CLASS_NAME],
  class_hex_color: [DEFAULT_PATCH_CLASS_COLOR],
  class_counts: [0],
};

export const PatchClassificationPanel: React.FC<PatchClassificationPanelProps> = ({
  panel,
  onContentChange,
}) => {
  const dispatch = useDispatch<AppDispatch>();
  const patchClassificationData = useSelector(selectPatchClassificationData);
  const updatePatchAfterEveryAnnotation = useSelector((state: any) => state.workflow.updatePatchAfterEveryAnnotation as boolean);
  const patchClassifierPath = useSelector((state: any) => state.workflow.patchClassifierPath as string | null);
  const patchClassifierSavePath = useSelector((state: any) => state.workflow.patchClassifierSavePath as string | null);
  const updateClassifier = useSelector((state: any) => state.workflow.updateClassifier as boolean);
  const { viewerInstance } = useAnnotatorInstance();
  const [showModal, setShowModal] = useState(false);
  const [newClassName, setNewClassName] = useState(cellTypeOptions[0]);
  const [newClassColor, setNewClassColor] = useState('#' + Math.floor(Math.random()*16777215).toString(16));
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [selectedClassIndex, setSelectedClassIndex] = useState<number>(0);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const promptInitRef = useRef<string | null>(null);
  
  // path
  const currentPath = useSelector((state: any) => state.svsPath.currentPath as string | null);
  const [formattedPath, setFormattedPath] = useState(formatPath(currentPath ?? ""));
  
  // Get current path and selected model from FileBrowserSidebar
  const selectedFolder = useSelector((state: RootState) => state.webFileManager.selectedFolder);
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


  const ensureHash = (hex: string | undefined | null): string => {
    if (!hex) return '#000000';
    return hex.startsWith('#') ? hex : `#${hex}`;
  };

  useEffect(() => {
    if (isWebMode) {
      // In web mode, always use forward slashes
      setFormattedPath((currentPath ?? "").replace(/\\/g, "/"));
    } else {
      // In desktop mode, use formatPath for OS-specific formatting
      setFormattedPath(formatPath(currentPath ?? ""));
    }
  }, [currentPath, isWebMode]);

  // Auto-update panel content when selected model changes in FileBrowserSidebar
  useEffect(() => {
    if (selectedModelForCurrentPath) {
      // Construct path to the model file
      let modelPath;
      if (isWebMode) {
        // In web mode, use relative path like h5_path
        modelPath = `${selectedFolder || ''}/${selectedModelForCurrentPath}`.replace(/\/+/g, '/');
      } else {
        // In desktop mode, use absolute path
        modelPath = `${selectedFolder || ''}\\${selectedModelForCurrentPath}`.replace(/\\+/g, '\\');
      }
      
      // Update panel content with the selected model path
      handlePathChange('load', modelPath);
      
      // If update classifier is already checked, also update save path
      if (updateClassifier) {
        handlePathChange('save', modelPath);
      }
    } else {
      // When no classifier is selected, clear both load and save paths in one operation
      let newContent = [...panel.content];
      const loadIndex = newContent.findIndex(item => item.key === 'classifier_path');
      const saveIndex = newContent.findIndex(item => item.key === 'save_classifier_path');
      
      // Remove both paths if they exist
      if (loadIndex > -1) {
        newContent.splice(loadIndex, 1);
      }
      if (saveIndex > -1) {
        // Adjust index if we already removed load path
        const adjustedSaveIndex = saveIndex > loadIndex ? saveIndex - 1 : saveIndex;
        newContent.splice(adjustedSaveIndex, 1);
      }
      
      onContentChange(panel.id, { ...panel, content: newContent });
    }
  }, [selectedModelForCurrentPath, selectedFolder, isWebMode, updateClassifier]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ensure Negative Control class exists
  useEffect(() => {
    if (!patchClassificationData || !Array.isArray(patchClassificationData.class_name) || patchClassificationData.class_name.length === 0) {
      dispatch(setPatchClassificationData(DEFAULT_PATCH_DATA as any));
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
            const classes = promptValue
              .split(/[\n,]/)
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

        const incoming: PatchClassificationData = {
          class_id: normalizedPromptClasses.map((_, idx) => idx),
          class_name: normalizedPromptClasses,
          class_hex_color: normalizedPromptClasses.map(name =>
            name.toLowerCase() === 'negative control'
              ? '#aaaaaa'
              : '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')
          ),
        };

        const merged = mergePatchClassificationData(patchClassificationData as PatchClassificationData, incoming);

        if (
          !patchClassificationData ||
          merged.class_name.length !== patchClassificationData.class_name.length ||
          merged.class_name.some((name, idx) => name !== patchClassificationData.class_name[idx])
        ) {
          dispatch(setPatchClassificationData(merged as any));
        }
      }
    } catch (error) {
      console.error("init classification failed:", error);
    }
  }, [panel, dispatch, patchClassificationData]);

  const handleAddClass = () => {
    const currentData = normalizePatchClassificationData(patchClassificationData as PatchClassificationData);
    const nextData: PatchClassificationData = {
      class_id: [...currentData.class_id],
      class_name: [...currentData.class_name],
      class_hex_color: [...currentData.class_hex_color],
      ...(currentData.class_counts ? { class_counts: [...currentData.class_counts] } : {}),
    };
    
    if (editingIndex !== null) {
      nextData.class_name[editingIndex] = newClassName;
      nextData.class_hex_color[editingIndex] = newClassColor;
    } else {
      const newId = nextData.class_id.length > 0 ? Math.max(...nextData.class_id) + 1 : 0;
      nextData.class_id.push(newId);
      nextData.class_name.push(newClassName);
      nextData.class_hex_color.push(newClassColor);
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
    if (patchClassificationData) {
      const normalized = normalizePatchClassificationData(patchClassificationData as PatchClassificationData);
      const nextData: PatchClassificationData = {
        class_id: normalized.class_id.filter((_, i) => i !== index),
        class_name: normalized.class_name.filter((_, i) => i !== index),
        class_hex_color: normalized.class_hex_color.filter((_, i) => i !== index),
        ...(normalized.class_counts
          ? { class_counts: normalized.class_counts.filter((_, i) => i !== index) }
          : {}),
      };
      
      dispatch(setPatchClassificationData(nextData as any));
      
      if (selectedClassIndex === index) {
        setSelectedClassIndex(0);
      } else if (selectedClassIndex > index) {
        setSelectedClassIndex(selectedClassIndex - 1);
      }
    }
  };
  
  const handleReset = () => {
    try {
      // Frontend reset (existing behavior)
      dispatch(setPatchClassificationData({
        class_id: [],
        class_name: [],
        class_hex_color: []
      }));

      // Backend cleanup: remove MuskNode tissue_* datasets and /user_annotation
      const h5Path = getDefaultOutputPath(currentPath || '');
      if (!h5Path) {
        message.warning('No H5 path resolved for cleanup. UI reset only.');
        return;
      }
      http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/reset_patch_classification`, {
        h5_path: h5Path
      })
        .then(response => {
          const json = response.data;
          if (json && json.code === 0) {
            message.success('Cleared patch classification data in H5.');
            // Notify WS path refresh to clear caches and reload counts/layers
            EventBus.emit('refresh-websocket-path', { path: h5Path, forceReload: true });
          } else {
            message.error(json?.message || 'Failed to clear patch classification in H5');
          }
        })
        .catch(() => message.error('Network error while clearing patch classification'));
    } catch (e) {
      // no-op for UI safety
    }
  };

  const handleClassSelect = (index: number) => {
    setSelectedClassIndex(index);
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
    const key = type === 'save' ? 'save_classifier_path' : 'classifier_path';
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

  // Handle update classifier checkbox change
  const handleUpdateClassifierChange = (checked: boolean) => {
    dispatch(setUpdateClassifier(checked));
    
    if (checked && selectedModelForCurrentPath) {
      // When enabling update, set both load and save paths to the selected model
      let modelPath;
      if (isWebMode) {
        // In web mode, use relative path like h5_path
        modelPath = `${selectedFolder || ''}/${selectedModelForCurrentPath}`.replace(/\/+/g, '/');
      } else {
        // In desktop mode, use absolute path
        modelPath = `${selectedFolder || ''}\\${selectedModelForCurrentPath}`.replace(/\\+/g, '\\');
      }
      
      handlePathChange('load', modelPath);
      handlePathChange('save', modelPath);
    } else if (!checked) {
      // When disabling update, clear save path but keep load path
      handlePathChange('save', null);
    }
  };



  return (
    <div className="px-[10px] py-[10px] space-y-2 rounded-lg bg-neutral-50 border-1">
      <div className="">
        <div className="flex items-center justify-between mb-2">
          <Label htmlFor="Tissues" className="text-muted-foreground font-normal">Tissues:</Label>
        </div>
        
        <div className="d-flex flex-column align-items-start">
          <div className="d-flex gap-1 align-items-center">
            {/* @ts-ignore */}
            <CButton color="primary" size="sm" onClick={openAddClassModal}>
              <CIcon icon={cilPlus}/> New Class
            </CButton>
            {/* @ts-ignore */}
            <CButton color="danger" size="sm" className="text-white" onClick={() => setShowResetConfirm(true)}>
              <CIcon icon={cilTrash}/> Reset
            </CButton>
            {/* @ts-ignore */}
            <div className="ms-2 flex-shrink-0 d-flex align-items-center gap-1">
              <CFormCheck
              type="checkbox"
              id={`updateClassifier-${panel.id}`}
              checked={updateClassifier}
              onChange={(e) => handleUpdateClassifierChange(e.target.checked)}
              disabled={!selectedModelForCurrentPath}
              title={selectedModelForCurrentPath ? "Update the selected classifier" : "No classifier selected"}
              className="text-xs me-1"
              />
               <label htmlFor={`updateClassifier-${panel.id}`} style={{ fontSize: '0.8rem' }}>
                 Update Classifier
               </label>
            </div>
          </div>
        </div>
        
        {/* Selected Classifier from FileBrowser */}
        {selectedModelForCurrentPath && (
          <div className="mt-2 p-2 bg-blue-50 border border-blue-200 rounded text-xs">
            <div className="flex items-center gap-2">
              <span className="font-medium text-blue-800">Selected Classifier:</span>
              <span className="text-blue-600 truncate" title={selectedModelForCurrentPath}>
                {selectedModelForCurrentPath.replace('.tlcls', '')}
              </span>
            </div>
          </div>
        )}
        
        {/* Update Classifier Status */}
        {updateClassifier && selectedModelForCurrentPath && (
          <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded text-xs">
            <div className="flex items-center gap-2">
              <span className="font-medium text-green-800">Updating Classifier:</span>
              <span className="text-green-600 truncate" title={selectedModelForCurrentPath}>
                {selectedModelForCurrentPath.replace('.tlcls', '')}
              </span>
            </div>
          </div>
        )}

        <div className="mt-2 border-y">
          <table className="w-full">
            <tbody>
              {normalizedPatchData.class_name.map((className: string, index: number) => (
                <tr key={index} className="border-b last:border-b-0 w-full">
                  <td className="px-2 py-1 w-8 text-center">
                    <div className="flex justify-center">
                      {selectedClassIndex === index ? (
                        <MousePointer2 className="h-4 w-4 text-primary" />
                      ) : (
                        <button
                          className="w-4 h-4 cursor-pointer hover:bg-gray-100 rounded-sm"
                          onClick={() => handleClassSelect(index)}
                        />
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-1 overflow-hidden w-auto max-w-0">
                    <div className="flex min-w-0 items-center w-full justify-between flex-shrink">
                      <span className="text-sm min-w-0 truncate overflow-hidden" title={className}>{className}</span>
                      <div className="flex-none">
                        {className !== 'Negative control' && (
                          <button
                            className="ml-1 text-gray-500 hover:text-gray-700"
                            onClick={() => editClass(index)}
                          >
                            <Edit className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-1 w-8">
                    <Input
                      type="color"
                      value={ensureHash(normalizedPatchData.class_hex_color[index])}
                      className="w-5 h-5 p-0 border-0"
                      onChange={(e) => {
                        const newColors = [...normalizedPatchData.class_hex_color];
                        newColors[index] = e.target.value;
                        const updated: PatchClassificationData = {
                          ...normalizedPatchData,
                          class_hex_color: newColors,
                        };
                        dispatch(setPatchClassificationData(updated as any));
                      }}
                    />
                  </td>
                  <td className="px-2 py-1 w-12 text-center">
                    <span className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">
                      {normalizedPatchData.class_counts?.[index] ?? 0}
                    </span>
                  </td>
                  <td className="px-2 py-1 w-10 text-right">
                    {className !== 'Negative control' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                        onClick={() => deleteClass(index)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      
      {/* Update/Review controls */}
      <div className="d-flex flex-column align-items-start gap-1">
        <CFormCheck 
          label="Update after every annotation"
          checked={updatePatchAfterEveryAnnotation}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => dispatch(setUpdatePatchAfterEveryAnnotation(e.target.checked))}
          className="text-xs w-full space-x-2"
        />
        <div className="d-flex gap-1">
          {/* @ts-ignore */}
          <CButton color="success" size="sm" onClick={async () => {
            try {
              const h5Path = getDefaultOutputPath(formattedPath);
              if (!h5Path) {
                message.warning('No H5 path resolved.');
                return;
              }
              if (!patchClassificationData || !patchClassificationData.class_name || patchClassificationData.class_name.length === 0) {
                message.warning('Please add at least one tissue class before updating.');
                return;
              }

              await triggerPatchClassificationWorkflow(
                dispatch,
                h5Path,
                {
                  class_name: normalizedPatchData.class_name,
                  class_hex_color: normalizedPatchData.class_hex_color,
                },
                patchClassifierPath,
                patchClassifierSavePath
              );
            } catch (e) {
              console.error('Failed to trigger patch classification workflow:', e);
              message.error('Failed to start patch classification update');
            }
          }}>
            <CIcon icon={cilLoop}/> Update
          </CButton>
          {/* @ts-ignore */}
          <CButton color="success" size="sm">
            <CIcon icon={cilNotes}/> Review
          </CButton>
        </div>
      </div>

      {/* Reset Confirmation Modal */}
      <CModal
        visible={showResetConfirm}
        onClose={() => setShowResetConfirm(false)}
        // @ts-ignore
        scrollable
      >
        <CModalHeader closeButton>
          Confirm Reset
        </CModalHeader>
        <CModalBody>
          <div className="text-sm">
            Are you sure you want to reset patch classification? This removes tissue patch classification labels and your annotations. The patches will be unclassified.
          </div>
        </CModalBody>
        <CModalFooter>
          {/* @ts-ignore */}
          <CButton color="secondary" onClick={() => setShowResetConfirm(false)}>
            Cancel
          </CButton>
          {/* @ts-ignore */}
          <CButton color="danger" className="text-white" onClick={() => { setShowResetConfirm(false); handleReset(); }}>
            Yes, reset
          </CButton>
        </CModalFooter>
      </CModal>

      {/* Add/Edit Class Modal */}
      <CModal
        visible={showModal}
        onClose={() => {
          setShowModal(false);
          setEditingIndex(null);
        }}
        // @ts-ignore
        scrollable
      >
        <CModalHeader closeButton>
          {editingIndex !== null ? 'Edit Class' : 'Add New Class'}
        </CModalHeader>
        <CModalBody>
          <div className="mb-3">
            <CFormLabel>
              Tissue Type:
            </CFormLabel>
            <CFormSelect
              value={newClassName}
              onChange={(e) => setNewClassName(e.target.value)}
              className="mb-2"
            >
              {cellTypeOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </CFormSelect>

            <CFormLabel>
              Or enter custom tissue type:
            </CFormLabel>
            <CFormTextarea
              value={
                newClassName === 'Negative control'
                  ? ''
                  : newClassName
              }
              onChange={(e) => setNewClassName(e.target.value)}
              rows={2}
            />
          </div>
          <div className="mb-3">
            <CFormLabel>Color:</CFormLabel>
            <CFormInput
              type="color"
              value={newClassColor}
              onChange={(e) => setNewClassColor(e.target.value)}
            />
          </div>
        </CModalBody>
        <CModalFooter>
          {/* @ts-ignore */}
          <CButton
            color="secondary"
            onClick={() => {
              setShowModal(false);
              setEditingIndex(null);
            }}
          >
            Cancel
          </CButton>
          {/* @ts-ignore */}
          <CButton color="primary" onClick={handleAddClass}>
            {editingIndex !== null ? 'Save' : 'Add'}
          </CButton>
        </CModalFooter>
      </CModal>

    </div>
  );
}; 