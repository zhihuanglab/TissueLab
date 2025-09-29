// TODO: Search functionality - commented out for future use
// This component is kept for future implementation when search is re-enabled
import React, { useState, useEffect, useMemo } from 'react';
import { CForm, CFormSelect, CFormLabel, CFormCheck, CButton, CFormTextarea, CFormInput, CBadge, CCard, CCardHeader, CCardBody } from '@coreui/react';
import CIcon from '@coreui/icons-react';
import {
    CirclePlus,
    CircleCheck,
    Ban,
    BookMarked,
    StepForward
} from "lucide-react";
import './Search.module.css';
import { motion } from 'framer-motion';

// Add type for opacity states
type OpacityState = 'confirm' | 'exclude';
type OpacityStates = Record<number, OpacityState>;

const SearchTab = () => {
    // Generate random RGB color
    const generateRandomColor = () => {
        const r = Math.floor(Math.random() * 256);
        const g = Math.floor(Math.random() * 256);
        const b = Math.floor(Math.random() * 256);
        return `rgb(${r}, ${g}, ${b})`;
    };

    // State for managing the random color
    const [randomColor, setRandomColor] = useState(generateRandomColor());

    // State for managing the number of images to show. Default is 20.
    const [numImages, setNumImages] = useState(20);

    // Update gallery data based on the selected number of images
    const galleryData = useMemo(() => {
        return Array.from({ length: numImages }, (_, index) => ({
            id: index,
            color: generateRandomColor(),
            title: `Similar Image ${index + 1}`
        }));
    }, [numImages]);

    // State for managing the toggle
    const [isBatchAnnotationEnabled, setIsBatchAnnotationEnabled] = useState(false);
    const [fadeIn, setFadeIn] = useState(false);

    // Update state definition with type
    const [opacityStates, setOpacityStates] = useState<OpacityStates>({});

    // Add type annotations to parameters
    const handleButtonClick = (id: number, type: OpacityState) => {
        setOpacityStates((prev) => ({
            ...prev,
            [id]: type
        }));
    };

    useEffect(() => {
        if (isBatchAnnotationEnabled) {
            setFadeIn(true);
        } else {
            setFadeIn(false);
        }
    }, [isBatchAnnotationEnabled]);

    // Define animation variants
    const variants = {
        open: { opacity: 1, height: 'auto' },
        closed: { opacity: 0, height: 0 }
    };

    return (
        <CForm className="p-2">
            <div className="mb-3">
                <CFormLabel style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>Reference Image</CFormLabel>
                <div className="d-flex flex-column align-items-center">
                    <div className="position-relative mb-2">
                        <div 
                            style={{
                                width: '200px',
                                height: '200px',
                                backgroundColor: randomColor,
                                border: '1px solid #ccc'
                            }}
                        />
                        {/* @ts-ignore */}
                        <CButton 
                            color="primary" 
                            size="sm" 
                            className="position-absolute top-0 end-0"
                            onClick={() => setRandomColor(generateRandomColor())}
                        >
                            <CirclePlus />
                        </CButton>
                    </div>
                </div>


                <CFormLabel style={{ fontSize: '1rem' }}>Custom prompt:</CFormLabel>
                    <CFormTextarea
                        rows={2}
                        className="mb-3"
                        placeholder="Enter your custom prompt here..."
                    />

                {/* Dropdown menu for selecting number of images to show */}
                <div className="d-flex align-items-center mb-3">
                    <CFormLabel style={{ fontSize: '1rem', marginRight: '1rem' }}>Number of Images to Show:</CFormLabel>
                    <CFormSelect 
                        className="me-2"
                        size="sm"
                        aria-label="Select number of images"
                        onChange={(e) => setNumImages(Number(e.target.value))} // Update state on change
                        style={{ width: '20%' }} // Set width to 20%
                    >
                        <option value="20">20</option>
                        <option value="50">50</option>
                        <option value="100">100</option>
                        <option value="500">500</option>
                    </CFormSelect>

                    {/* @ts-ignore */}
                    <CButton 
                        color="primary"
                        size="sm"
                    >
                        Update Results
                    </CButton>
                </div>

                {/* Toggle button for batch annotation */}
                <div className="mb-3">
                    {/* @ts-ignore */}
                    <CButton 
                        color="secondary" 
                        size="sm" 
                        onClick={() => setIsBatchAnnotationEnabled(!isBatchAnnotationEnabled)}
                    >
                        {isBatchAnnotationEnabled ? 'Hide Batch Annotation' : 'Enable Batch Annotation'}
                    </CButton>

                    {/* Box with options when batch annotation is enabled */}
                    <motion.div
                        initial="closed"
                        animate={isBatchAnnotationEnabled ? "open" : "closed"}
                        variants={variants}
                        transition={{ duration: 0.5 }}
                        className="batch-options"
                    >
                        <CCard>
                            {/* @ts-ignore */}
                            <CCardHeader>
                                Batch Annotation Options
                            </CCardHeader>
                            <CCardBody>
                                {/* @ts-ignore */}
                                <CButton color="primary" size="sm" className="me-2 d-flex align-items-center">
                                    <StepForward className="me-1" /> Next Batch
                                </CButton>
                                <CFormTextarea
                                    rows={2}
                                    className="mt-2 mb-2"
                                    placeholder="Universal text annotation..."
                                />
                                <div>
                                    {/* @ts-ignore */}
                                    <CButton color="primary" size="sm" className="me-2 d-flex align-items-center">
                                        <BookMarked className="me-1" /> Manage my annotations
                                    </CButton>
                                </div>
                            </CCardBody>
                        </CCard>
                    </motion.div>
                </div>

            </div>

            <div className="mb-3">
                <CFormLabel style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>Similar Images</CFormLabel>
                
                <div className="mb-3">
                    <CFormLabel style={{ fontSize: '1rem' }}>Sort based on:</CFormLabel>
                    {/* @ts-ignore */}
                    <CFormSelect 
                        className="mb-3"
                        size="sm"
                        aria-label="Sort similarity method"
                    >
                        <option value="pure">Pure Similarity</option>
                        <option value="distance">Distance-weighted Similarity</option>
                    </CFormSelect>
                </div>
                
                <div className="gallery-container" style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
                    gap: '1rem',
                    width: '100%'
                }}>
                    {galleryData.map((item) => {
                        const isExcluded = opacityStates[item.id] === 'exclude';

                        return (
                            <div key={item.id} className="gallery-item">
                                <div
                                    className="gallery-image position-relative"
                                    style={{ 
                                        backgroundColor: item.color,
                                        minWidth: '140px',
                                        height: '140px',
                                        border: '1px solid #ccc',
                                        borderRadius: '4px',
                                        display: 'flex',
                                        justifyContent: 'center',
                                        alignItems: 'center'
                                    }}
                                >
                                    {isExcluded ? (
                                        <Ban className="position-absolute top-0 end-0" style={{ color: 'red' }} />
                                    ) : opacityStates[item.id] === 'confirm' && (
                                        <CircleCheck className="position-absolute top-0 end-0" style={{ color: 'green' }} />
                                    )}
                                </div>
                                <span className="gallery-title">
                                    {item.title}
                                </span>

                                {isBatchAnnotationEnabled && (
                                    <div className={`annotation-controls mt-2 ${fadeIn ? 'fade-in-enter-active' : 'fade-in'}`}>
                                        <CFormTextarea
                                            rows={3}
                                            className="mb-2"
                                            placeholder="Enter additional text..."
                                            disabled={isExcluded} // Disable textarea if excluded
                                        />
                                        <div className="d-flex justify-content-between">
                                            {/* @ts-ignore */}
                                            <CButton 
                                                color="success" 
                                                size="sm" 
                                                className="flex-grow-1 me-1"
                                                onClick={() => handleButtonClick(item.id, 'confirm')}
                                            >
                                                Confirm
                                            </CButton>
                                            {/* @ts-ignore */}
                                            <CButton 
                                                color="danger" 
                                                size="sm" 
                                                className="flex-grow-1"
                                                onClick={() => handleButtonClick(item.id, 'exclude')}
                                            >
                                                Exclude
                                            </CButton>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </CForm>
    );
};

export default SearchTab;
