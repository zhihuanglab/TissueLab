import React, { useState } from 'react';
import { CForm, CFormSelect, CFormLabel, CFormCheck, CButton, CFormTextarea, CFormInput, CBadge } from '@coreui/react';
import CIcon from '@coreui/icons-react';
import { cilPlus, cilMinus } from '@coreui/icons';
import './CoPilotTab.module.css';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '@/store';
import { setCoPilotEnabled } from '@/store/slices/coPilotSlice';

const CoPilotTab = () => {
    const dispatch = useDispatch();
    // Get isEnabled from Redux instead of local state
    const isEnabled = useSelector((state: RootState) => state.coPilot.enabled);
    
    // Remove local state for isEnabled
    const [parameters, setParameters] = useState({
        confidence: 0.5,
        threshold: 0.7,
        maxDetections: 100,
        useEnhancement: false
    });

    // Handle parameter changes
    const handleParameterChange = (name: string, value: number | boolean) => {
        setParameters(prev => ({
            ...prev,
            [name]: value
        }));
    };

    // Update toggle handler to dispatch Redux action
    const handleToggle = () => {
        dispatch(setCoPilotEnabled(!isEnabled));
    };

    return (
        <div className="wsi-tab p-3">
            {/*@ts-ignore*/}
            <CButton 
                color={isEnabled ? "success" : "secondary"}
                className="mb-3 w-100"
                onClick={handleToggle}  // Updated onClick handler
            >
                {isEnabled ? "Enabled" : "Disabled"}
            </CButton>

            {/* Parameters Form */}
            <CForm className={!isEnabled ? "opacity-50" : ""}>
                <div className="mb-3">
                    <CFormLabel>Confidence</CFormLabel>
                    {/*@ts-ignore*/}
                    <CFormInput
                        type="range"
                        min="0"
                        max="1"
                        step="0.1"
                        value={parameters.confidence}
                        onChange={(e) => handleParameterChange('confidence', parseFloat(e.target.value))}
                        disabled={!isEnabled}
                    />
                    <small className="text-muted">{parameters.confidence}</small>
                </div>

                <div className="mb-3">
                    <CFormLabel>Threshold</CFormLabel>
                    {/*@ts-ignore*/}
                    <CFormInput
                        type="range"
                        min="0"
                        max="1"
                        step="0.1"
                        value={parameters.threshold}
                        onChange={(e) => handleParameterChange('threshold', parseFloat(e.target.value))}
                        disabled={!isEnabled}
                    />
                    <small className="text-muted">{parameters.threshold}</small>
                </div>

                <div className="mb-3">
                    <CFormLabel>Max Detections</CFormLabel>
                    {/*@ts-ignore*/}
                    <CFormInput
                        type="number"
                        min="1"
                        max="1000"
                        value={parameters.maxDetections}
                        onChange={(e) => handleParameterChange('maxDetections', parseInt(e.target.value))}
                        disabled={!isEnabled}
                    />
                </div>

                {/*@ts-ignore*/}
                <CFormCheck
                    id="enhancementCheck"
                    label="Use Enhancement"
                    checked={parameters.useEnhancement}
                    onChange={(e) => handleParameterChange('useEnhancement', e.target.checked)}
                    disabled={!isEnabled}
                />
            </CForm>
        </div>
    );
};

export default CoPilotTab;
