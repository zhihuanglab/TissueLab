// File type detection utilities

export const isWSI = (fileName: string) => {
    const supportedExtensions = ['.svs', '.qptiff', '.tif', '.ndpi', '.tiff', '.jpeg', '.png', '.jpg', '.dcm', '.bmp', '.czi', '.nii', '.nii.gz', '.btf', '.isyntax'];
    return supportedExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
};

export const isZarr = (fileName: string) => {
    const lowerName = fileName.toLowerCase();
    return lowerName.endsWith('.zarr') || lowerName.endsWith('.zarr.zip');
};

export const isZarrDir = (fileName: string) => {
    return fileName.toLowerCase().endsWith('.zarr');
};

export const isZarrZip = (fileName: string) => {
    return fileName.toLowerCase().endsWith('.zarr.zip');
};

export const isH5Convertible = (fileName: string) => {
    const lowerName = fileName.toLowerCase();
    return lowerName.endsWith('.svs.h5') || lowerName.endsWith('.h5') || lowerName.endsWith('.hdf5');
};

export const getWSIBaseName = (fileName: string) => {
    // For Zarr files that follow pattern: wsi_name.ext.zarr or wsi_name.ext.zarr.zip
    if (isZarr(fileName)) {
        // Remove .zarr or .zarr.zip extension properly
        return fileName.replace(/\.zarr(\.zip)?$/i, '');
    }
    return fileName;
};

export const isNiivueFile = (fileName: string) => {
    const niivueExtensions = ['.nii', '.nii.gz'];
    return niivueExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
};

export const isOpenSeadragonFile = (fileName: string) => {
    const openseadragonExtensions = ['.svs', '.qptiff', '.tif', '.ndpi', '.tiff', '.jpeg', '.png', '.jpg', '.bmp', '.czi', '.btf', '.isyntax', '.dcm'];
    return openseadragonExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
};

export const getFileViewerType = (fileName: string): 'niivue' | 'openseadragon' | 'unsupported' => {
    if (isNiivueFile(fileName)) {
        return 'niivue';
    } else if (isOpenSeadragonFile(fileName)) {
        return 'openseadragon';
    } else {
        return 'unsupported';
    }
};
