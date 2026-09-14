// File type detection utilities

// These predicates run inside sort comparators and per-row filters over the
// whole listing, so a large folder calls them hundreds of thousands of times.
// Keep the extension tables at module scope and lowercase the name once per
// call instead of once per extension.
const WSI_EXTENSIONS = ['.svs', '.qptiff', '.tif', '.ndpi', '.tiff', '.jpeg', '.png', '.jpg', '.dcm', '.bmp', '.czi', '.nii', '.nii.gz', '.btf', '.isyntax'];
const NIIVUE_EXTENSIONS = ['.nii', '.nii.gz'];
const OPENSEADRAGON_EXTENSIONS = ['.svs', '.qptiff', '.tif', '.ndpi', '.tiff', '.jpeg', '.png', '.jpg', '.bmp', '.czi', '.btf', '.isyntax', '.dcm'];

const hasExtension = (fileName: string, extensions: string[]) => {
    const lowerName = (fileName || '').toLowerCase();
    return extensions.some(ext => lowerName.endsWith(ext));
};

export const isWSI = (fileName: string) => hasExtension(fileName, WSI_EXTENSIONS);

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

export const isNiivueFile = (fileName: string) => hasExtension(fileName, NIIVUE_EXTENSIONS);

export const isOpenSeadragonFile = (fileName: string) => hasExtension(fileName, OPENSEADRAGON_EXTENSIONS);

export const getFileViewerType = (fileName: string): 'niivue' | 'openseadragon' | 'unsupported' => {
    if (isNiivueFile(fileName)) {
        return 'niivue';
    } else if (isOpenSeadragonFile(fileName)) {
        return 'openseadragon';
    } else {
        return 'unsupported';
    }
};
