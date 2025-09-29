import React, { useState } from 'react';
import {
  CCard,
  CCardHeader,
  CCardBody,
  CButton,
  CProgress,
  CProgressBar,
  CFormSelect,
  CFormInput,
  CRow,
  CCol
} from '@coreui/react';
import styles from "@/styles/imageViewer.module.css";
import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import http from '@/utils/http';

const SidebarPreprocess = () => {
  const [progress, setProgress] = useState(0);
  const [model, setModel] = useState('stardist');
  const [magnification, setMagnification] = useState('auto');
  const [manualMagnification, setManualMagnification] = useState('');
  const [numberOfNuclei, setNumberOfNuclei] = useState(null); // State to hold the number of nuclei

  const checkProgress = async () => {
    const progressResponse = await http.get(`${AI_SERVICE_API_ENDPOINT}/load/v1/get-progress/`);
    const progressJson = progressResponse.data;

    const progressData = progressJson.data || progressJson;
    setProgress(progressData.progress);

    if (progressData.progress < 100) {
      setTimeout(checkProgress, 1000); // Check again in 1 second
    } else {
      const resultResponse = await http.get(`${AI_SERVICE_API_ENDPOINT}/load/v1/get-result/`);
      const resultJson = resultResponse.data;

      const resultData = resultJson.data || resultJson;
      setNumberOfNuclei(resultData.number_of_nuclei);
    }
  };

  const handleRunButtonClick = async () => {
    const params = {
      model: model,
      magnification: magnification === 'manual' ? manualMagnification : magnification,
    };

    const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/load/v1/run-preprocess/`, { params: params });

    const responseJson = response.data;
    const responseData = responseJson.data || responseJson;
    
    if (response.status === 200) {
      // Start polling for progress
      checkProgress();
    } else {
      console.error('Failed to run preprocess');
    }
  };

  return (
    <CCard className={styles['widget image-viewer-sidebar']}>
      {/*@ts-ignore*/}
      <CCardHeader>
        <h4 style={{ margin: 0 }}>Preprocess</h4>
      </CCardHeader>
      <CCardBody>
        <p>
          To better enable some AI functions, such as real-time nuclei classification, we need to preprocess the image data.
        </p>
        <h5 style={{ marginBottom: '15px' }}>Nuclei Segmentation and Basic Statistics</h5>

        <div style={{ marginBottom: '10px' }}>
          <strong>Model:</strong>
          <CFormSelect
            value={model}
            onChange={(e) => setModel(e.target.value)}
            aria-label="Select Model"
            style={{ marginBottom: '10px' }}
          >
            <option value="stardist">Stardist</option>
            <option value="cellvit">CellVit</option>
            <option value="fast-color-threshold">Fast Color Threshold</option>
          </CFormSelect>
        </div>

        <div style={{ marginBottom: '10px' }}>
          <strong>Magnification:</strong>
          <CFormSelect
            value={magnification}
            onChange={(e) => setMagnification(e.target.value)}
            aria-label="Select Magnification"
          >
            <option value="auto">Auto</option>
            <option value="manual">Manual</option>
          </CFormSelect>
        </div>

        {magnification === 'manual' && (
          <div style={{ marginBottom: '20px' }}>
            <CFormInput
              type="number"
              placeholder="Enter Magnification Value"
              value={manualMagnification}
              onChange={(e) => setManualMagnification(e.target.value)}
            />
          </div>
        )}

        <div style={{ marginBottom: '20px' }}>
          {/*@ts-ignore*/}
          <CButton color="primary" onClick={handleRunButtonClick}>
            Run
          </CButton>
        </div>

        <div style={{ marginBottom: '15px' }}>
          <CProgress>
            <CProgressBar value={progress} color="info">
              {progress}% Complete
            </CProgressBar>
          </CProgress>
        </div>

        {progress > 0 && (
          <div style={{ fontSize: '12px', color: '#6c757d' }}>
            Processing nuclei segmentation and calculating basic statistics. Please wait...
          </div>
        )}

        {numberOfNuclei !== null && (
          <div style={{ marginTop: '15px', fontSize: '14px', color: '#28a745' }}>
            Number of Nuclei Detected: {numberOfNuclei}
          </div>
        )}
      </CCardBody>
    </CCard>
  );
};

export default SidebarPreprocess;
