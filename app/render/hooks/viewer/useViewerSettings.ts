import { RootState } from '@/store';
import { setCentroidSize, setOverlayAlpha, setCentroidThreshold, setShowNavigator, setTrackpadGesture, setZoomSpeed, setHighlightGtAnnotations, toggleHighlightGtAnnotations, setEnableMouseTracking, toggleEnableMouseTracking, setEnableViewportHistory, toggleEnableViewportHistory } from '@/store/slices/viewer/viewerSettingsSlice';
import { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';

const STORAGE_KEY = 'tissuelab_preferences';

export const DEFAULT_SETTINGS = {
    trackpadGesture: false,
    zoomSpeed: 0.5,
    centroidSize: 1.5,
    overlayAlpha: 0.4,
    showNavigator: true,
    centroidThreshold: 10
};

const loadFromLocalStorage = (): typeof DEFAULT_SETTINGS => {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            // Migrate old centroidAlpha to overlayAlpha if needed
            if (parsed.centroidAlpha !== undefined && parsed.overlayAlpha === undefined) {
                parsed.overlayAlpha = parsed.centroidAlpha;
                delete parsed.centroidAlpha;
            }
            // Merge default settings and saved settings, ensure all fields exist
            return { ...DEFAULT_SETTINGS, ...parsed };
        }
    } catch (error) {
        console.error('Load settings from local storage failed:', error);
    }
    return DEFAULT_SETTINGS;
};

const saveToLocalStorage = (settings: typeof DEFAULT_SETTINGS) => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
        console.error('Save settings to local storage failed:', error);
    }
};

const updateSetting = <K extends keyof typeof DEFAULT_SETTINGS>(
    key: K, 
    value: typeof DEFAULT_SETTINGS[K]
) => {
    try {
        const currentSettings = loadFromLocalStorage();
        currentSettings[key] = value;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(currentSettings));
    } catch (error) {
        console.error('Update setting failed:', error);
    }
};

export const useViewerSettings = () => {
    const dispatch = useDispatch();
    
    // Get current settings from Redux store
    const zoomSpeed = useSelector((state: RootState) => state.viewerSettings.zoomSpeed);
    const centroidSize = useSelector((state: RootState) => state.viewerSettings.centroidSize);
    const overlayAlpha = useSelector((state: RootState) => state.viewerSettings.overlayAlpha);
    const trackpadGesture = useSelector((state: RootState) => state.viewerSettings.trackpadGesture);
    const showNavigator = useSelector((state: RootState) => state.viewerSettings.showNavigator);
    const centroidThreshold = useSelector((state: RootState) => state.viewerSettings.centroidThreshold);
    const highlightGtAnnotations = useSelector((state: RootState) => state.viewerSettings.highlightGtAnnotations);
    const enableMouseTracking = useSelector((state: RootState) => state.viewerSettings.enableMouseTracking);
    const enableViewportHistory = useSelector((state: RootState) => state.viewerSettings.enableViewportHistory);

    // Load settings from localStorage and update Redux store on component mount
    useEffect(() => {
        const settings = loadFromLocalStorage();
        
        // Update Redux store with loaded settings
        dispatch(setTrackpadGesture(settings.trackpadGesture));
        dispatch(setZoomSpeed(settings.zoomSpeed));
        dispatch(setCentroidSize(settings.centroidSize));
        dispatch(setOverlayAlpha(settings.overlayAlpha ?? DEFAULT_SETTINGS.overlayAlpha));
        dispatch(setShowNavigator(settings.showNavigator));
        dispatch(setCentroidThreshold(settings.centroidThreshold));
    }, [dispatch]);

    // Setting change handlers
    const handleZoomSpeedChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        let value = Number(e.target.value);
        if (isNaN(value)) value = 0.5;
        if (value < 0.1) value = 0.1;
        if (value > 2) value = 2;
        dispatch(setZoomSpeed(value));
        updateSetting('zoomSpeed', value);
    };
    
    const handleCentroidSizeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        let value = Number(e.target.value);
        if (isNaN(value)) value = 1.5;
        if (value < 0.5) value = 0.5;
        if (value > 5) value = 5;
        dispatch(setCentroidSize(value));
        updateSetting('centroidSize', value);
    };

    const handleOverlayAlphaChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        let value = Number(e.target.value);
        if (isNaN(value)) value = 0.4;
        if (value < 0) value = 0;
        if (value > 1) value = 1;
        dispatch(setOverlayAlpha(value));
        updateSetting('overlayAlpha', value);
    };

    const toggleTrackpadGesture = () => {
        const newValue = !trackpadGesture;
        dispatch(setTrackpadGesture(newValue));
        updateSetting('trackpadGesture', newValue);
    };

    const toggleShowNavigator = () => {
        const newValue = !showNavigator;
        dispatch(setShowNavigator(newValue));
        updateSetting('showNavigator', newValue);
    };

    const handleCentroidThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        let value = Number(e.target.value);
        if (isNaN(value)) value = 10;
        if (value < 0.1) value = 0.1;
        if (value > 100) value = 100;
        dispatch(setCentroidThreshold(value));
        updateSetting('centroidThreshold', value);
    };

    const resetToDefaults = () => {
        dispatch(setTrackpadGesture(DEFAULT_SETTINGS.trackpadGesture));
        dispatch(setZoomSpeed(DEFAULT_SETTINGS.zoomSpeed));
        dispatch(setCentroidSize(DEFAULT_SETTINGS.centroidSize));
        dispatch(setOverlayAlpha(DEFAULT_SETTINGS.overlayAlpha));
        dispatch(setShowNavigator(DEFAULT_SETTINGS.showNavigator));
        dispatch(setCentroidThreshold(DEFAULT_SETTINGS.centroidThreshold));
        dispatch(setEnableMouseTracking(false));
        dispatch(setEnableViewportHistory(false));
        saveToLocalStorage(DEFAULT_SETTINGS);
    };

    const toggleHighlightGt = () => {
        dispatch(toggleHighlightGtAnnotations());
    };

    const toggleMouseTracking = () => {
        dispatch(toggleEnableMouseTracking());
    };

    const toggleViewportHistory = () => {
        dispatch(toggleEnableViewportHistory());
    };

    return {
        // Current settings
        zoomSpeed,
        centroidSize,
        overlayAlpha,
        trackpadGesture,
        showNavigator,
        centroidThreshold,
        highlightGtAnnotations,
        enableMouseTracking,
        enableViewportHistory,

        // Handlers
        handleZoomSpeedChange,
        handleCentroidSizeChange,
        handleOverlayAlphaChange,
        toggleTrackpadGesture,
        toggleShowNavigator,
        handleCentroidThresholdChange,
        toggleHighlightGt,
        toggleMouseTracking,
        toggleViewportHistory,
        resetToDefaults,
        
        // Utility functions
        saveToLocalStorage,
        loadFromLocalStorage,
        updateSetting,
        DEFAULT_SETTINGS
    };
};
