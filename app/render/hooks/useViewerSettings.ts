import { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '@/store';
import { setZoomSpeed, setCentroidSize, setTrackpadGesture, setShowNavigator } from '@/store/slices/viewerSettingsSlice';

const STORAGE_KEY = 'tissuelab_preferences';

export const DEFAULT_SETTINGS = {
    trackpadGesture: false,
    zoomSpeed: 2.0,
    centroidSize: 1.5,
    showNavigator: true
};

const loadFromLocalStorage = (): typeof DEFAULT_SETTINGS => {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
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
    const trackpadGesture = useSelector((state: RootState) => state.viewerSettings.trackpadGesture);
    const showNavigator = useSelector((state: RootState) => state.viewerSettings.showNavigator);

    // Load settings from localStorage and update Redux store on component mount
    useEffect(() => {
        const settings = loadFromLocalStorage();
        
        // Update Redux store with loaded settings
        dispatch(setTrackpadGesture(settings.trackpadGesture));
        dispatch(setZoomSpeed(settings.zoomSpeed));
        dispatch(setCentroidSize(settings.centroidSize));
        dispatch(setShowNavigator(settings.showNavigator));
    }, [dispatch]);

    // Setting change handlers
    const handleZoomSpeedChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        let value = Number(e.target.value);
        if (isNaN(value)) value = 2.0;
        if (value < 0.5) value = 0.5;
        if (value > 10) value = 10;
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

    const resetToDefaults = () => {
        dispatch(setTrackpadGesture(DEFAULT_SETTINGS.trackpadGesture));
        dispatch(setZoomSpeed(DEFAULT_SETTINGS.zoomSpeed));
        dispatch(setCentroidSize(DEFAULT_SETTINGS.centroidSize));
        dispatch(setShowNavigator(DEFAULT_SETTINGS.showNavigator));
        saveToLocalStorage(DEFAULT_SETTINGS);
    };

    return {
        // Current settings
        zoomSpeed,
        centroidSize,
        trackpadGesture,
        showNavigator,
        
        // Handlers
        handleZoomSpeedChange,
        handleCentroidSizeChange,
        toggleTrackpadGesture,
        toggleShowNavigator,
        resetToDefaults,
        
        // Utility functions
        saveToLocalStorage,
        loadFromLocalStorage,
        updateSetting,
        DEFAULT_SETTINGS
    };
};
