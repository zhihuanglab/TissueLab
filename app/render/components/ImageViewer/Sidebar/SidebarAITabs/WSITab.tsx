import React, { useState } from 'react';
import { CForm, CFormSelect, CFormLabel, CFormCheck, CButton, CFormTextarea, CFormInput, CBadge } from '@coreui/react';
import CIcon from '@coreui/icons-react';
import { cilPlus, cilMinus } from '@coreui/icons';
import './WSITab.module.css';

const WSITab = () => {
    // Add state for encoder parameters
    const [encoderParams, setEncoderParams] = useState({
        quality: 75,
        tileSize: 256,
        compression: 'jpeg',
        enablePyramid: true
    });

    // Add state for tissue segmentation
    const [segmentationParams, setSegmentationParams] = useState({
        threshold: 90,
        minSize: 1000,
        enabled: false
    });

    const handleParamChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value, type } = e.target;
        setEncoderParams(prev => ({
            ...prev,
            [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
        }));
    };

    const handleSegmentationChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value, type } = e.target;
        setSegmentationParams(prev => ({
            ...prev,
            [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
        }));
    };

    return (
        <CForm className="wsi-encoder p-3">
            <h4>Tissue Classification</h4>
            
            <div className="mb-3">
                <CFormCheck 
                    id="enableSegmentation"
                    label="Enable Tissue Classification"
                    name="enabled"
                    checked={segmentationParams.enabled}
                    onChange={handleSegmentationChange}
                />
            </div>

            <div className="mb-3">
                <CFormLabel>Threshold ({segmentationParams.threshold}%)</CFormLabel>
                <CFormInput
                    type="range"
                    name="threshold"
                    min="0"
                    max="100"
                    value={segmentationParams.threshold}
                    onChange={handleSegmentationChange}
                    disabled={!segmentationParams.enabled}
                />
            </div>

            <div className="mb-3">
                <CFormLabel>Minimum Region Size (pixels)</CFormLabel>
                <CFormInput
                    type="number"
                    name="minSize"
                    min="100"
                    max="10000"
                    value={segmentationParams.minSize}
                    onChange={handleSegmentationChange}
                    disabled={!segmentationParams.enabled}
                />
            </div>

            <div className="mb-3">
                <table className="table table-sm table-bordered">
                    <thead>
                        <tr>
                            <th>Region</th>
                            <th>Size (px)</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>Region 1</td>
                            <td>125,000</td>
                            <td>
                                {/* @ts-ignore */}
                                <CButton size="sm" color="danger" className="btn-square">
                                    <CIcon icon={cilMinus} size="sm" />
                                </CButton>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <div className="mb-3 d-flex gap-2">
                {/* @ts-ignore */}
                <CButton color="primary" disabled={!segmentationParams.enabled}>
                    Run Segmentation
                </CButton>
                {/* @ts-ignore */}
                <CButton color="secondary" disabled={!segmentationParams.enabled}>
                    Clear All
                </CButton>
            </div>

            <h4>WSI Encoder</h4>
            
            <div className="mb-3">
                <CFormLabel>Compression Type</CFormLabel>
                <CFormSelect 
                    name="compression"
                    value={encoderParams.compression}
                    onChange={handleParamChange}
                >
                    <option value="jpeg">JPEG</option>
                    <option value="png">PNG</option>
                    <option value="webp">WebP</option>
                </CFormSelect>
            </div>

            <div className="mb-3">
                <CFormLabel>Quality ({encoderParams.quality})</CFormLabel>
                <CFormInput
                    type="range"
                    name="quality"
                    min="1"
                    max="100"
                    value={encoderParams.quality}
                    onChange={handleParamChange}
                />
            </div>

            <div className="mb-3">
                <CFormLabel>Tile Size</CFormLabel>
                <CFormSelect
                    name="tileSize"
                    value={encoderParams.tileSize}
                    onChange={handleParamChange}
                >
                    <option value="128">128 x 128</option>
                    <option value="256">256 x 256</option>
                    <option value="512">512 x 512</option>
                    <option value="1024">1024 x 1024</option>
                </CFormSelect>
            </div>

            <div className="mb-3">
                <CFormCheck 
                    id="enablePyramid"
                    label="Enable Image Pyramid"
                    name="enablePyramid"
                    checked={encoderParams.enablePyramid}
                    onChange={handleParamChange}
                />
            </div>
            {/* @ts-ignore */}
            <CButton color="primary" className="w-100">
                Encode WSI
            </CButton>
        </CForm>
    );
};

export default WSITab;
