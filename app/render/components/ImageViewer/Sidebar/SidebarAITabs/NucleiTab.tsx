import React, { useState, useEffect } from 'react';
import { CForm, CFormSelect, CFormLabel, CFormCheck, CButton, CFormTextarea, CFormInput, CBadge, CCard, CCardBody, CCardHeader, CTable, CTableBody, CTableRow, CTableDataCell, CModal, CModalHeader, CModalBody, CModalFooter, CTableHead, CTableHeaderCell, CTooltip } from '@coreui/react';
import CIcon from '@coreui/icons-react';
import { CheckCircle } from 'lucide-react'
import { cilPlus, cilPencil, cilTrash, cilCloudUpload, cilCloudDownload, cilLoop, cilNotes, cilWarning, cilCursor } from '@coreui/icons';
import styles from './NucleiTab.module.css';
import http from "@/utils/http";
import {useDispatch, useSelector} from "react-redux";
import {setIsGenerating} from "@/store/slices/annotationSlice";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertTriangle, X } from "lucide-react"
import {RootState} from "@/store";
import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import {requestClassification, setClassificationEnabled} from "@/store/slices/annotationSlice";
import { AppDispatch } from '@/store';
import {
  addNucleiClass,
  updateNucleiClass,
  deleteNucleiClass,
  resetNucleiClasses,
  addRegionClass,
  updateRegionClass,
  deleteRegionClass,
  resetRegionClasses,
} from '@/store/slices/annotationSlice';
import { formatPath } from "@/utils/pathUtils"
import NotificationToast from '@/components/ui/NotificationToast'

// Add this interface near the top of the file, after imports
interface AnnotationClass {
  name: string;
  count: number;
  color: string;
}

const NucleiTab = () => {
  const dispatch = useDispatch<AppDispatch>();
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  const [formattedPath, setFormattedPath] = useState(formatPath(currentPath ?? ""));

  useEffect(() => {
    setFormattedPath(formatPath(currentPath ?? ""));
  }, [currentPath]);

  // const [nucleiClasses, setNucleiClasses] = useState<AnnotationClass[]>([]);
  // const [regionClasses, setRegionClasses] = useState<AnnotationClass[]>([]);
  const nucleiClasses = useSelector((state: RootState) => state.annotations.nucleiClasses);
  const regionClasses = useSelector((state: RootState) => state.annotations.regionClasses);

  const reloadSegmentationData = async () => {
    try {
      const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/seg/v1/reload`, {});
      console.log('Segmentation reload response:', response.data);
      console.log('Successfully reloaded segmentation data after completion');
    } catch (error) {
      console.error('Error reloading segmentation data:', error);
    }
  };
  
  // state for store current added class
  const [categoryType, setCategoryType] = useState<'nuclei' | 'region'>('nuclei');
  const [showModal, setShowModal] = useState(false);
  const [newClassName, setNewClassName] = useState('Negative control');
  const getRandomColor = () => {
    const letters = '0123456789ABCDEF';
    let color = '#';
    for (let i = 0; i < 6; i++) {
      color += letters[Math.floor(Math.random() * 16)];
    }
    return color;
  };
  const [newClassColor, setNewClassColor] = useState(getRandomColor());
  // Add new state for storing custom options
  const [customOptions, setCustomOptions] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    const savedOptions = localStorage.getItem('nucleiCustomOptions');
    return savedOptions ? JSON.parse(savedOptions) : [];
  });

  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  // Add new state for reset confirmation modal
  const [showResetModal, setShowResetModal] = useState(false);

  // states for selected AnnotationClass
  const [selectedNucleiClasses, setSelectedNucleiClasses] = useState<number[]>(() =>
      // default select all classes
      nucleiClasses.map((_, index) => index)
  );

  const classificationEnabled = useSelector((state: RootState) => state.annotations.classificationEnabled);

  // Update localStorage when classes change
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('nucleiClasses', JSON.stringify(nucleiClasses));
    }
  }, [nucleiClasses]);

  // Update localStorage when customOptions change
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('nucleiCustomOptions', JSON.stringify(customOptions));
    }
  }, [customOptions]);



  const openAddClassModal = (type: 'nuclei' | 'region') => {
    setCategoryType(type);
    setNewClassName(type === 'nuclei' ? 'Negative control' : '');
    setNewClassColor(getRandomColor());
    setShowModal(true);
  };

  const editClass = (index: number, type: 'nuclei' | 'region') => {
    const classes = type === 'nuclei' ? nucleiClasses : regionClasses;

    // Prevent editing Negative control in nucleiClasses
    if (type === 'nuclei' && classes[index].name === 'Negative control') return;

    setEditingIndex(index);
    setCategoryType(type);
    setNewClassName(classes[index].name);
    setNewClassColor(classes[index].color);
    setShowModal(true);
  };

  const handleAddClass = () => {
    if (editingIndex !== null) {
      // Edit existing class
      if (categoryType === 'nuclei') {
        const updatedClass = {
          ...nucleiClasses[editingIndex],
          name: newClassName,
          color: newClassColor
        };
        
        dispatch(updateNucleiClass({
          index: editingIndex,
          newClass: updatedClass
        }));
      } else {
        const updatedClass = {
          ...regionClasses[editingIndex],
          name: newClassName,
          color: newClassColor
        };
        
        dispatch(updateRegionClass({
          index: editingIndex,
          newClass: updatedClass
        }));
      }
    } else {
      // Add new class
      if (categoryType === 'nuclei') {
        dispatch(addNucleiClass({
          name: newClassName,
          count: 0,
          color: newClassColor
        }));
      } else {
        dispatch(addRegionClass({
          name: newClassName,
          count: 0,
          color: newClassColor
        }));
      }
    }
    
    // Reset and close modal
    setShowModal(false);
    setNewClassName('');
    setNewClassColor(getRandomColor());
    setEditingIndex(null);
  };

  const handleDeleteClass = (index: number, type: 'nuclei' | 'region') => {
    // Prevent deleting Negative control in nucleiClasses
    if (type === 'nuclei') {
      // Don't delet Negative control
      if (nucleiClasses[index].name === 'Negative control') return;
    }

    if (type === 'nuclei') {
      dispatch(deleteNucleiClass(index));
    } else {
      dispatch(deleteRegionClass(index));
    }
  };

  const handleClassNameChange = (index: number, newName: string, type: 'nuclei' | 'region') => {
    const isNuclei = (type === 'nuclei');
    const classes = isNuclei ? nucleiClasses : regionClasses;
    const updatedClass = { ...classes[index], name: newName };
    // update local state
    if (isNuclei) {
      dispatch(updateNucleiClass({
        index,
        newClass: updatedClass,
      }));
    } else {
      dispatch(updateRegionClass({
        index,
        newClass: updatedClass,
      }));
    }
  };

  const handleClassColorChange = (index: number, newColor: string, type: 'nuclei' | 'region') => {
    const isNuclei = (type === 'nuclei');
    const classes = isNuclei ? nucleiClasses : regionClasses;
    const fixed = newColor && newColor.startsWith('#') ? newColor : `#${newColor}`;
    const updatedClass = { ...classes[index], color: fixed };

    // just update redux store
    if (isNuclei) {
      dispatch(updateNucleiClass({
        index,
        newClass: updatedClass,
      }));
    } else {
      dispatch(updateRegionClass({
        index,
        newClass: updatedClass,
      }));
    }
  };

  // Add reset handler
  const handleReset = () => {
    dispatch(resetNucleiClasses());
    dispatch(resetRegionClasses());
    setShowResetModal(false);
  };

  // Add new state for save modal
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);

  // Add new state for selected class
  const [selectedClassIndex, setSelectedClassIndex] = useState(0);
  const imageUploaded = useSelector(
    (state: RootState) => state.sidebar.imageLoaded
  )
  const isGenerating  = useSelector(
      (state: RootState) => state.annotations.isGenerating,
  )

  const [progress, setProgress] = useState(0)
  const [isProcessed, setIsProcessed] = useState(false);
  const [showAlert, setShowAlert] = useState(false)
  const toggleAlert = () => setShowAlert(!showAlert)
  const [toast, setToast] = useState<{ visible: boolean; title: string; message: string, variant?: 'success' | 'warning' | 'error' }>({
    visible: false,
    title: '',
    message: '',
    variant: 'success'
  })
  const showToast = (title: string, message: string, variant: 'success' | 'warning' | 'error' = 'success') => setToast({ visible: true, title, message, variant })

  useEffect(() => {
    if (isGenerating) {
      const timer = setInterval(async () => {
        try {
          const response = await http.get(`${AI_SERVICE_API_ENDPOINT}/processing/v1/progress`)
          const responseData = response.data.data || response.data;
          if (responseData.code === 200) {
            const { is_processing, total_iterations, cur_iterations } = responseData;
            if (is_processing && total_iterations) {
              setProgress((cur_iterations / total_iterations) * 100)
            } else if (!is_processing) {
              setIsProcessed(true)
              dispatch(setIsGenerating(false))
              // the task has been completed, clear the timer
              clearInterval(timer as NodeJS.Timeout)

              // After segmentation is complete, call the reload API and trigger rendering—the same approach as classification.
              try {
                // 1. Call the reload API to reload segmented data.
                const reload_response = await http.post(`${AI_SERVICE_API_ENDPOINT}/seg/v1/reload`, {});
                console.log('Segmentation reload response:', reload_response.data);
                
                // 2. Trigger front-end rendering using the same method as Classification.
                dispatch(requestClassification());
              } catch (error) {
                console.error('Error reloading segmentation data:', error);
              }
            }
          }
        } catch (error) {
          console.error('An error occurred while polling progress: ', error)
        }
      }, 1000)
    } else {
      // TODO: check h5 file exists
    }
  }, [isGenerating, dispatch])

  const handlePreprocessing = async () => {
    if (!imageUploaded) {
      toggleAlert()
      return
    }

    try {
      const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/processing/v1/run`, {})
      // update progress
      if (response.data.code === 200) {
        dispatch(setIsGenerating(true))
      }
    } catch (error) {
      setProgress(0)
      console.error("Error fetching data:", error)
    } finally {
      // setIsProcessed(true)
      // setIsLoading(false)
    }
  };
  const handleGeneration = async () => {
    console.log("Process button clicked!");
    await handlePreprocessing()
  };

  // Add new state for toggle buttons
  const [showNucleiContour, setShowNucleiContour] = useState(false);
  const [showPatch, setShowPatch] = useState(false);

  const handleClickUpdate = async () => {
    const getDefaultOutputPath = (path: string): string => {
      if (!path) return "";
      return path + '.h5';
    };

    try {
      console.log(currentPath);
      console.log(formattedPath);
      console.log(getDefaultOutputPath(formattedPath));
      const payload = {
        path: getDefaultOutputPath(formattedPath),
      };
      const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/classification`, payload);
      if (response.data.code === 200) {
        dispatch(setClassificationEnabled(true));
        dispatch(requestClassification());
      }
    } catch (error) {
      console.error('An error occurred while polling progress: ', error)
    }
  };

  useEffect(() => {
    console.log("[NucleiTab] classificationEnabled changed to:", classificationEnabled);
  }, [classificationEnabled]);


  // @ts-ignore
  // @ts-ignore
  return (
        <>
        <CForm className="p-3 d-flex flex-column" style={{height: '100%'}}>

        {/* @ts-ignore */}
        {!isProcessed ? (
            <CCard className="shadow border-warning">
              {/* @ts-ignore */}
              <CCardHeader className="fw-bold bg-warning text-dark small">
                <CIcon icon={cilWarning} className="me-2"/> Warning
              </CCardHeader>
              <CCardBody className="py-2">
                <p className="mb-2 small">
                  Either there is no H5 file or the H5 file does not contain nuclei segmentation & patch embedding.
                  Please preprocess this slide first. Run nuclei segmentation & patch embedding before continuing.
                </p>

                {isGenerating ? (
                    <div className="flex flex-row justify-content-center items-center align-items-center gap-4">
                      <div className="w-64 h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-blue-500 transition-all duration-500 ease-out"
                            style={{width: `${progress}%`}}
                        />
                      </div>
                      <span>{progress}%</span>
                    </div>
                ) : (
                    <>
                      {/* @ts-ignore */}
                      <CButton
                          color="warning"
                          size="sm"
                          className="w-100"
                          onClick={handlePreprocessing}
                      >
                        <CIcon icon={cilLoop} className="me-1"/>Run Preprocessing
                      </CButton>
                      {showAlert && (
                          <Alert variant="destructive" className="relative max-w-md mt-2">
                            <AlertTriangle className="h-4 w-4"/>
                            <AlertTitle>Warning</AlertTitle>
                            <AlertDescription>
                              Please upload the SVS file first.
                            </AlertDescription>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="absolute top-2 right-2 hover:bg-destructive/20"
                                onClick={toggleAlert}
                            >
                              <X className="h-4 w-4 mr-5"/>
                            </Button>
                          </Alert>
                      )}
                    </>
                )}
              </CCardBody>
            </CCard>
        ) : (
            <div className="flex flex-col justify-content-center items-center gap-4">
              <div className="flex items-center justify-center space-x-2 text-green-600">
                <CheckCircle className="w-5 h-5"/>
                <span className="text-sm font-medium">Segmentation generated successfully</span>
              </div>
              <Button
                  type="button"
                  onClick={handleGeneration}
                  className="w-full bg-black text-white hover:bg-gray-800"
              >
                Regenerate Segmentation
              </Button>
            </div>
        )}


        <CFormLabel className="fw-bold mt-4">Nuclei & Region Adjustment:</CFormLabel>
        <div className="d-flex justify-content-between align-items-center mb-3">
          <div className="d-flex align-items-center">
          <CFormLabel className="me-2">Show Nuclei Contour</CFormLabel>
            <input
              type="checkbox"
              checked={showNucleiContour}
              onChange={() => setShowNucleiContour(!showNucleiContour)}
              className="form-checkbox h-5 w-5 text-blue-600"
            />
          </div>
          <div className="d-flex align-items-center">
            <CFormLabel className="me-2">Show Patch Grid</CFormLabel>
            <input
              type="checkbox"
              checked={showPatch}
              onChange={() => setShowPatch(!showPatch)}
              className="form-checkbox h-5 w-5 text-blue-600"
            />
          </div>
        </div>

        <div className="d-flex flex-column align-items-start">
          <div className="d-flex gap-1">
            {/* @ts-ignore */}
            <CButton color="primary" size="sm" onClick={() => openAddClassModal('nuclei')}>
              <CIcon icon={cilPlus}/> New Nuclei Class
            </CButton>
            {/* @ts-ignore */}
            <CButton color="primary" size="sm" onClick={() => openAddClassModal('region')}>
              <CIcon icon={cilPlus}/> New Region Class
            </CButton>
            {/* @ts-ignore */}
            <CButton color="danger" size="sm" className="text-white" onClick={() => setShowResetModal(true)}>
              <CIcon icon={cilTrash}/> Reset
            </CButton>
            {/* @ts-ignore */}
            <CButton color="light" size="sm" onClick={() => setShowSaveModal(true)}>
              <CIcon icon={cilCloudUpload}/> Save
            </CButton>
            {/* @ts-ignore */}
            <CButton color="light" size="sm" onClick={() => {
              // TODO: Implement load functionality similar to ClassificationPanelContent
              // This should open a file dialog to select a .tlcls file to load
              console.log('Load button clicked - implement load functionality');
              showToast('Load functionality not yet implemented. Please use the nuclei classification workflow panel for loading.', 'warning');
            }}>
              <CIcon icon={cilCloudDownload}/> Load
            </CButton>
          </div>
        </div>


        {/* render nuclei */}
        <div className="flex-fill">
          <CFormLabel className="fw-bold mt-4">Nuclei Classes:</CFormLabel>
          <CTable className={styles.nucleiTable}>
            <CTableBody>
              {nucleiClasses.map((cls, index) => (
                  <CTableRow key={index} className={styles.compactRow}>
                    <CTableDataCell className={styles.cellCheckbox}>
                      <CTooltip content="Select for double-click annotation">
                        {selectedClassIndex === index ? (
                            <CIcon icon={cilCursor} className="text-primary"/>
                        ) : (
                          <div
                              style={{width: '16px', height: '16px', cursor: 'pointer'}}
                              onClick={() => setSelectedClassIndex(index)}
                          />
                        )}
                      </CTooltip>
                    </CTableDataCell>
                    <CTableDataCell className={styles.cellType}>
                      <div className={styles.cellTypeContent}>
                        <div className={styles.cellName}>
                          <span className={styles.cellNameText}>{cls.name}</span>
                          {cls.name !== 'Negative control' && (
                              <CIcon
                                  icon={cilPencil}
                                  className={styles.editIcon}
                                  onClick={() => editClass(index, 'nuclei')}
                              />
                          )}
                        </div>
                      </div>
                    </CTableDataCell>
                    <CTableDataCell className={styles.cellColor}>
                      <CTooltip content="Edit color">
                        <CFormInput
                            type="color"
                            value={cls.color && cls.color.startsWith('#') ? cls.color : `#${cls.color}`}
                            onChange={(e) =>
                                handleClassColorChange(index, e.target.value, 'nuclei')
                            }
                        />
                      </CTooltip>
                    </CTableDataCell>

                    <CTooltip content="Number of nuclei">
                      <CTableDataCell className={styles.cellCount}>
                        <CFormInput type="number" value={cls.count} disabled/>
                      </CTableDataCell>
                    </CTooltip>
                    <CTableDataCell className={styles.cellAction}>
                      {cls.name !== 'Negative control' && (
                          <CTooltip content="Delete class">
                            {/* @ts-ignore */}
                            <CButton
                                color="danger"
                                size="sm"
                                onClick={() => handleDeleteClass(index, 'nuclei')}
                            >
                              <CIcon icon={cilTrash} className="text-white"/>
                            </CButton>
                          </CTooltip>
                      )}
                    </CTableDataCell>
                  </CTableRow>
              ))}
            </CTableBody>
          </CTable>

          {/* render region */}
          <CFormLabel className="fw-bold mt-4">Region Classes:</CFormLabel>
          <CTable className={styles.nucleiTable}>
            <CTableBody>
              {regionClasses.map((cls, index) => (
                  <CTableRow key={index} className={styles.compactRow}>
                    <CTableDataCell className={styles.cellType}>
                      <div className={styles.cellTypeContent}>
                        <div className={styles.cellName}>
                          <span className={styles.cellNameText}>{cls.name}</span>
                          <CIcon
                              icon={cilPencil}
                              className={styles.editIcon}
                              onClick={() => editClass(index, 'region')}
                          />
                        </div>
                      </div>
                    </CTableDataCell>
                    <CTableDataCell className={styles.cellColor}>
                      <CTooltip content="Edit color">
                        <CFormInput
                            type="color"
                            value={cls.color && cls.color.startsWith('#') ? cls.color : `#${cls.color}`}
                            onChange={(e) =>
                                handleClassColorChange(index, e.target.value, 'region')
                            }
                        />
                      </CTooltip>
                    </CTableDataCell>

                    <CTooltip content="Number of regions">
                      <CTableDataCell className={styles.cellCount}>
                        <CFormInput type="number" value={cls.count} disabled/>
                      </CTableDataCell>
                    </CTooltip>
                    <CTableDataCell className={styles.cellAction}>
                      <CTooltip content="Delete class">
                        {/* @ts-ignore */}
                        <CButton
                            color="danger"
                            size="sm"
                            onClick={() => handleDeleteClass(index, 'region')}
                        >
                          <CIcon icon={cilTrash} className="text-white"/>
                        </CButton>
                      </CTooltip>
                    </CTableDataCell>
                  </CTableRow>
              ))}
            </CTableBody>
          </CTable>
        </div>

        <div className="d-flex flex-column align-items-start">
          <CFormCheck label="Update after every annotation"/>
          <div className="d-flex gap-1">
            {/* @ts-ignore */}
            <CButton color="success" size="sm" onClick={handleClickUpdate}>
              <CIcon icon={cilLoop}/> Update
            </CButton>
            {/* @ts-ignore */}
            <CButton color="success" size="sm">
                <CIcon icon={cilNotes}/> Review
              </CButton>
            </div>
          </div>


          <CCard className="mt-3 shadow-sm">
            {/* @ts-ignore */}
            <CCardHeader className="fw-bold bg-primary text-white">Current Classifier Information</CCardHeader>
            <CCardBody className="m-0 p-3">
              {/* @ts-ignore */}
              <div>Number of targets: <CBadge color="primary">5</CBadge></div>
              {/* @ts-ignore */}
              <div>Total nuclei: <CBadge color="primary">210</CBadge></div>
              {/* @ts-ignore */}
              <div>Overall fitting accuracy: <CBadge color="success">88.33%</CBadge></div>
            </CCardBody>
          </CCard>


          <CCard className="mt-3 shadow-sm">
            {/* @ts-ignore */}
            <CCardHeader className="fw-bold bg-primary text-white">Current WSI Statistics</CCardHeader>
            <CCardBody className="m-0 p-3">
              {/* Add stacked bar visualization */}
              <div className="mt-3">
                {/* Whole Slide Statistics */}
                <div className="mb-3">
                  <div className="d-flex justify-content-between align-items-center mb-1">
                    <small className="text-muted">Whole Slide</small>
                    <small className="text-muted">Total: 210 nuclei</small>
                  </div>
                  <div className="w-100 d-flex position-relative"
                       style={{height: '24px', borderRadius: '4px', overflow: 'hidden'}}>
                    {nucleiClasses.map((cls, index) => {
                      const count = cls.count || (index === 0 ? 70 : 28);
                      const percentage = (count / 210 * 100).toFixed(1);
                      return (
                          <div
                              key={index}
                              className="position-relative"
                              style={{
                                backgroundColor: cls.color,
                                width: `${count}%`,
                                transition: 'width 0.3s ease'
                              }}
                          >
                            <div className="position-absolute w-100 text-center small text-white"
                                 style={{
                                   top: '50%',
                                   transform: 'translateY(-50%)',
                                   textShadow: '1px 1px 2px rgba(0,0,0,0.5)',
                                   fontSize: '0.7rem'
                                 }}>
                              {count} ({percentage}%)
                            </div>
                          </div>
                      );
                    })}
                  </div>
                </div>

                {/* Selected Region Statistics */}
                <div className="mb-2">
                  <div className="d-flex justify-content-between align-items-center mb-1">
                    <div className="d-flex align-items-center gap-2">
                      <small className="text-muted">Selected Region</small>
                      {/* @ts-ignore */}
                      <CFormCheck size="sm"/>
                    </div>
                    <small className="text-muted">Total: 45 nuclei</small>
                  </div>
                  <div className="w-100 d-flex position-relative"
                       style={{
                         height: '24px',
                         borderRadius: '4px',
                         overflow: 'hidden',
                         opacity: 0.5  // Greyed out by default
                       }}>
                    {nucleiClasses.map((cls, index) => {
                      const count = cls.count || (index === 0 ? 15 : 6);
                      const percentage = (count / 45 * 100).toFixed(1);
                      return (
                          <div
                              key={index}
                              className="position-relative"
                              style={{
                                backgroundColor: cls.color,
                                width: `${count / 45 * 100}%`,
                                transition: 'width 0.3s ease'
                              }}
                          >
                            <div className="position-absolute w-100 text-center small text-white"
                                 style={{
                                   top: '50%',
                                   transform: 'translateY(-50%)',
                                   textShadow: '1px 1px 2px rgba(0,0,0,0.5)',
                                   fontSize: '0.7rem'
                                 }}>
                              {count} ({percentage}%)
                            </div>
                          </div>
                      );
                    })}
                  </div>
                </div>

                {/* Legend */}
                <div className="d-flex flex-wrap gap-2 mt-2">
                  {nucleiClasses.map((cls, index) => (
                      <div key={index} className="d-flex align-items-center small">
                        <div
                            style={{
                              width: '12px',
                              height: '12px',
                              backgroundColor: cls.color,
                              marginRight: '4px',
                              borderRadius: '2px'
                            }}
                        />
                        <span>{cls.name}</span>
                      </div>
                  ))}
                </div>
              </div>
            </CCardBody>
          </CCard>

          <div className="mt-3">
            <div className="d-flex gap-1">
              {/* @ts-ignore */}
              <CButton color="success" size="sm">
                  <CIcon icon={cilNotes}/> Generate Report of Evidence
              </CButton>
            </div>
          </div>


          {/* Add Reset Confirmation Modal */}
          <CModal
              visible={showModal}
              onClose={() => {
                setShowModal(false);
                setEditingIndex(null);
              }}
              scrollable
          >
            <CModalHeader closeButton>
              {editingIndex !== null ? 'Edit Class' : 'Add New Class'}
            </CModalHeader>
            <CModalBody>
              <div className="mb-3">
                <CFormLabel>
                  {categoryType === 'nuclei' ? 'Cell Type:' : 'Region Type:'}
                </CFormLabel>
                <CFormSelect
                    value={newClassName}
                    onChange={(e) => setNewClassName(e.target.value)}
                    className="mb-2"
                >
                  {categoryType === 'nuclei' ? (
                      <>
                      <option>Adipocytes (Fat Cells)</option>
                      <option>Astrocytes</option>
                      <option>Basophils</option>
                      <option>Cellular Debris</option>
                      <option>Eosinophils</option>
                      <option>Endothelial Cells</option>
                      <option>Epithelial Cells</option>
                      <option>Fibrin</option>
                      <option>Fibroblasts</option>
                      <option>Hemorrhage</option>
                      <option>Lymphocytes</option>
                      <option>Macrophages</option>
                      <option>Mast Cells</option>
                      <option>Microglia</option>
                      <option>Neoplastic (Tumor) Cells</option>
                      <option>Neurons</option>
                      <option>Necrosis</option>
                      <option>Neutrophils</option>
                      <option>Oligodendrocytes</option>
                      <option>Plasma Cells</option>
                      <option>Smooth Muscle Cells</option>
                      <option>Stromal Reaction (Desmoplasia)</option>
                      </>
                  ) : (
                      <>
                      <option>Adrenal Cortex (Adrenal Gland)</option>
                      <option>Adrenal Medulla (Adrenal Gland)</option>
                      <option>Alveolar Region (Lung)</option>
                      <option>Bone Marrow</option>
                      <option>Biliary Tract Region (Liver)</option>
                      <option>Bronchial Region (Lung)</option>
                      <option>Central Nervous System (CNS)</option>
                      <option>Cerebellar Cortex (Brain)</option>
                      <option>Colonic Mucosa (Colon)</option>
                      <option>Cortical Region</option>
                      <option>Dermal Region (Skin)</option>
                      <option>Ductal Region (Breast)</option>
                      <option>Endocardial Region (Heart)</option>
                      <option>Endometrial Region (Uterus)</option>
                      <option>Esophageal Region (Esophagus)</option>
                      <option>Epidermal Region (Skin)</option>
                      <option>Follicular Region (Lymph Node)</option>
                      <option>Gastric Mucosa (Stomach)</option>
                      <option>Germinal Center (Lymph Node)</option>
                      <option>Glomerular Region (Kidney)</option>
                      <option>Hematopoietic Region</option>
                      <option>Hepatic Parenchyma (Liver)</option>
                      <option>Hippocampal Region (Brain)</option>
                      <option>Hypothalamic Region (Brain)</option>
                      <option>Intestinal Mucosa (Intestine)</option>
                      <option>Lobular Region (Breast)</option>
                      <option>Lymph Node Cortex (Lymph Node)</option>
                      <option>Lymph Node Medulla (Lymph Node)</option>
                      <option>Lymphocytes Region</option>
                      <option>Medullary Region</option>
                      <option>Meningeal Region (Brain/Spinal Cord)</option>
                      <option>Microglia Region (Brain)</option>
                      <option>Muscularis Layer (Digestive Tract)</option>
                      <option>Mucosal Region</option>
                      <option>Myocardial Region (Heart)</option>
                      <option>Myometrial Region (Uterus)</option>
                      <option>Ovarian Cortex (Ovary)</option>
                      <option>Ovarian Medulla (Ovary)</option>
                      <option>Pancreatic Islets (Pancreas)</option>
                      <option>Pericardial Region (Heart)</option>
                      <option>Perineural Region (Nervous System)</option>
                      <option>Periosteal Region (Bone)</option>
                      <option>Peritoneal Region (Abdominal Cavity)</option>
                      <option>Peripheral Nervous System (PNS)</option>
                      <option>Pituitary Region (Brain)</option>
                      <option>Portal Region (Liver)</option>
                      <option>Prostatic Region (Prostate)</option>
                      <option>Red Pulp (Spleen)</option>
                      <option>Renal Cortex (Kidney)</option>
                      <option>Renal Medulla (Kidney)</option>
                      <option>Reticular Region (Lymph Node)</option>
                      <option>Salivary Gland Region (Salivary Glands)</option>
                      <option>Seminiferous Tubules (Testis)</option>
                      <option>Serosal Region</option>
                      <option>Sinusoidal Region (Liver)</option>
                      <option>Smooth Muscle Cells</option>
                      <option>Spinal Cord</option>
                      <option>Splenic Region (Spleen)</option>
                      <option>Stromal Reaction (Desmoplasia) (Tumor Microenvironment)</option>
                      <option>Subcutaneous Region</option>
                      <option>Submucosal Region (Digestive Tract)</option>
                      <option>Synovial Region (Joints)</option>
                      <option>Testicular Region (Testis)</option>
                      <option>Thymic Cortex (Thymus)</option>
                      <option>Thymic Medulla (Thymus)</option>
                      <option>Thyroid Follicles (Thyroid)</option>
                      <option>Tumoral Region</option>
                      <option>Tracheal Region (Trachea)</option>
                      <option>White Pulp (Spleen)</option>
                      </>
                  )}
                </CFormSelect>

                <CFormLabel>
                  Or enter custom {categoryType === 'nuclei' ? 'cell type' : 'region type'}:
                </CFormLabel>
                <CFormTextarea
                    value={
                      newClassName === 'Negative control' && categoryType === 'nuclei'
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

          {/* reset */}
          <CModal visible={showResetModal} onClose={() => setShowResetModal(false)}>
            <CModalHeader closeButton>Confirm Reset</CModalHeader>
            <CModalBody>
              Are you sure you want to reset all nuclei and region classes? This action cannot be
              undone.
            </CModalBody>
            <CModalFooter>
              {/* @ts-ignore */}
              <CButton color="secondary" onClick={() => setShowResetModal(false)}>
                Cancel
              </CButton>
              {/* @ts-ignore */}
              <CButton color="danger" onClick={handleReset}>
                Reset
              </CButton>
            </CModalFooter>
          </CModal>

          {/* store to cloud */}
          <CModal visible={showSaveModal} onClose={() => setShowSaveModal(false)}>
            <CModalHeader closeButton>Save to Cloud</CModalHeader>
            <CModalBody>
              <CFormLabel className="fw-bold">Description:</CFormLabel>
              <CFormTextarea
                  rows={3}
                  placeholder="Before sync, describe your work please."
                  className="mb-3"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
              />
              <CFormCheck
                  className="mt-3"
                  label="I wish to make this contribution public."
                  checked={isPublic}
                  onChange={(e) => setIsPublic(e.target.checked)}
              />
            </CModalBody>
            <CModalFooter>
              {/* @ts-ignore */}
              <CButton color="secondary" onClick={() => setShowSaveModal(false)}>
                Cancel
              </CButton>
              {/* Temporarily commented out upload to cloud functionality */}
              {/*
              <CButton
                  color="primary"
                  onClick={() => {
                    // Add your save logic here
                    setShowSaveModal(false);
                  }}
              >
                Upload to cloud
              </CButton>
              */}
            </CModalFooter>
          </CModal>
        </CForm>
        <NotificationToast
          isVisible={toast.visible}
          title={toast.title}
          message={toast.message}
          onDismiss={() => setToast((t) => ({ ...t, visible: false }))}
          variant={toast.variant}
        />
        </>
);
};

export default NucleiTab;
