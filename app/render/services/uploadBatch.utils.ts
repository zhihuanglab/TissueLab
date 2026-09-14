import {
    getZarrRootFromRelativePath,
    groupZarrBatchEntriesByRoot,
    type ZarrBatchFileEntry,
} from '@/services/zarrUpload.service';

/** Default threshold matching WebFileManager (50 MB). */
export const DEFAULT_CHUNKED_UPLOAD_THRESHOLD_BYTES = 50 * 1024 * 1024;

export interface UploadFileEntry {
    file: File;
    relativePath?: string;
}

export type UploadBatchUnitKind = 'small' | 'large' | 'zarr';

export interface UploadBatchUnit {
    fileId: string;
    file: File;
    relativePath?: string;
    displayPath: string;
    displayFileSize?: number;
    kind: UploadBatchUnitKind;
    zarrEntries?: ZarrBatchFileEntry[];
}

export interface ClassifiedUploadEntries {
    small: UploadFileEntry[];
    large: UploadFileEntry[];
    zarrGroups: ZarrBatchFileEntry[][];
}

export function filterValidUploadFiles(
    files: File[],
    relativePaths?: string[]
): {
    validFiles: File[];
    validRelPaths: string[];
    effectiveRelPaths?: string[];
} {
    const relPaths = relativePaths && relativePaths.length === files.length ? relativePaths : undefined;
    const validFiles: File[] = [];
    const validRelPaths: string[] = [];

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.size === 0 || !file.name || file.name.trim() === '') {
            continue;
        }
        validFiles.push(file);
        if (relPaths && i < relPaths.length) {
            validRelPaths.push(relPaths[i]);
        }
    }

    const effectiveRelPaths =
        relPaths && validRelPaths.length === validFiles.length ? validRelPaths : undefined;

    return { validFiles, validRelPaths, effectiveRelPaths };
}

export function classifyUploadEntries(
    entries: UploadFileEntry[],
    chunkedThresholdBytes: number = DEFAULT_CHUNKED_UPLOAD_THRESHOLD_BYTES
): ClassifiedUploadEntries {
    const small: UploadFileEntry[] = [];
    const large: UploadFileEntry[] = [];
    const zarrBatchEntries: ZarrBatchFileEntry[] = [];

    for (const entry of entries) {
        if (getZarrRootFromRelativePath(entry.relativePath)) {
            zarrBatchEntries.push({ file: entry.file, relativePath: entry.relativePath! });
            continue;
        }
        if (entry.file.size >= chunkedThresholdBytes) {
            large.push(entry);
        } else {
            small.push(entry);
        }
    }

    return {
        small,
        large,
        zarrGroups: groupZarrBatchEntriesByRoot(zarrBatchEntries),
    };
}

export function buildUploadBatchUnits(
    batchTs: number,
    normalSmallEntries: UploadFileEntry[],
    largeEntries: UploadFileEntry[],
    zarrEntryGroups: ZarrBatchFileEntry[][]
): UploadBatchUnit[] {
    const units: UploadBatchUnit[] = [];

    normalSmallEntries.forEach((entry, idx) => {
        const displayPath = entry.relativePath || entry.file.name;
        units.push({
            fileId: `small_${entry.file.name}_${entry.file.size}_${batchTs}_${idx}`,
            file: entry.file,
            relativePath: entry.relativePath,
            displayPath,
            kind: 'small',
        });
    });

    largeEntries.forEach((entry, idx) => {
        const displayPath = entry.relativePath || entry.file.name;
        units.push({
            fileId: `large_${entry.file.name}_${entry.file.size}_${batchTs}_${idx}`,
            file: entry.file,
            relativePath: entry.relativePath,
            displayPath,
            kind: 'large',
        });
    });

    zarrEntryGroups.forEach((entries, groupIdx) => {
        const zarrRoots = Array.from(
            new Set(entries.map((entry) => getZarrRootFromRelativePath(entry.relativePath)).filter(Boolean))
        ) as string[];
        const zarrDisplayPath = zarrRoots[0] || 'Zarr upload';
        const zarrTotalBytes = entries.reduce((sum, entry) => sum + (entry.file.size || 0), 0);
        units.push({
            fileId: `zarr_${zarrDisplayPath}_${zarrTotalBytes}_${batchTs}_${groupIdx}`,
            file: entries[0].file,
            displayPath: zarrDisplayPath,
            displayFileSize: zarrTotalBytes,
            kind: 'zarr',
            zarrEntries: entries,
        });
    });

    return units;
}

export function getUploadUnitWeight(unit: UploadBatchUnit): number {
    return Math.max(1, unit.displayFileSize ?? unit.file.size ?? 1);
}

function escapeRegexSegment(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nextKeepBothFolderName(base: string, existingNames: Set<string>): string {
    const re = new RegExp(`^${escapeRegexSegment(base)} \\((\\d+)\\)$`);
    const used = new Set<number>();
    if (existingNames.has(base)) used.add(0);
    existingNames.forEach((name) => {
        const match = String(name).match(re);
        if (match) used.add(parseInt(match[1], 10));
    });
    let counter = 1;
    while (used.has(counter)) counter++;
    return `${base} (${counter})`;
}

function nextKeepBothFileName(filename: string, existingNames: Set<string>): string {
    const lastDot = filename.lastIndexOf('.');
    if (lastDot <= 0) {
        return nextKeepBothFolderName(filename, existingNames);
    }
    const base = filename.slice(0, lastDot);
    const ext = filename.slice(lastDot);
    const esc = escapeRegexSegment;
    const reSpace = new RegExp(`^${esc(base)} \\((\\d+)\\)${esc(ext)}$`);
    const reUnderscore = new RegExp(`^${esc(base)}_\\((\\d+)\\)${esc(ext)}$`);
    const used = new Set<number>();
    if (existingNames.has(filename)) used.add(0);
    existingNames.forEach((name) => {
        const match = String(name).match(reSpace) || String(name).match(reUnderscore);
        if (match) used.add(parseInt(match[1], 10));
    });
    let counter = 1;
    while (used.has(counter)) counter++;
    return `${base} (${counter})${ext}`;
}

/**
 * Pre-compute keep-both target paths so parallel uploads share the same names.
 * When paths are rewritten here, callers should pass keep_both=false to the API.
 */
export function computeKeepBothPaths(params: {
    validFiles: File[];
    effectiveRelPaths?: string[];
    existingNames: Set<string>;
}): {
    pathsForUpload: string[] | undefined;
    keepBoth: boolean;
} {
    const { validFiles, effectiveRelPaths, existingNames } = params;

    if (effectiveRelPaths) {
        const folderRewrites: Record<string, string> = {};
        const tops = new Set<string>();
        for (const relPath of effectiveRelPaths) {
            const top = relPath.split('/')[0];
            if (top && existingNames.has(top)) tops.add(top);
        }
        tops.forEach((top) => {
            folderRewrites[top] = nextKeepBothFolderName(top, existingNames);
        });

        if (Object.keys(folderRewrites).length > 0) {
            const pathsForUpload = effectiveRelPaths.map((relPath) => {
                const parts = relPath.split('/');
                if (parts[0] && folderRewrites[parts[0]]) {
                    parts[0] = folderRewrites[parts[0]];
                    return parts.join('/');
                }
                return relPath;
            });
            return { pathsForUpload, keepBoth: false };
        }
        return { pathsForUpload: effectiveRelPaths, keepBoth: true };
    }

    const fileRewrites: string[] = [];
    let anyRewritten = false;
    for (const file of validFiles) {
        if (existingNames.has(file.name)) {
            fileRewrites.push(nextKeepBothFileName(file.name, existingNames));
            anyRewritten = true;
        } else {
            fileRewrites.push(file.name);
        }
    }

    if (anyRewritten) {
        return { pathsForUpload: fileRewrites, keepBoth: false };
    }
    return { pathsForUpload: undefined, keepBoth: true };
}

export interface UploadConflictInfo {
    existingFiles: File[];
    conflictDesc: string;
}

export function detectUploadConflicts(params: {
    validFiles: File[];
    effectiveRelPaths?: string[];
    existingNames: Set<string>;
}): UploadConflictInfo | null {
    const { validFiles, effectiveRelPaths, existingNames } = params;

    let existingFiles: File[] = [];
    if (effectiveRelPaths) {
        const topLevelFolders = new Set<string>();
        for (const relPath of effectiveRelPaths) {
            const top = relPath.split('/')[0];
            if (top && existingNames.has(top)) topLevelFolders.add(top);
        }
        if (topLevelFolders.size > 0) {
            existingFiles = validFiles.filter((_, index) => {
                const top = effectiveRelPaths[index]?.split('/')[0];
                return top && topLevelFolders.has(top);
            });
        }
    } else {
        existingFiles = validFiles.filter((file) => existingNames.has(file.name));
    }

    if (existingFiles.length === 0) return null;

    const topFolders = effectiveRelPaths
        ? Array.from(new Set(
            existingFiles
                .map((file) => effectiveRelPaths[validFiles.indexOf(file)]?.split('/')[0])
                .filter(Boolean)
        ))
        : [];

    const conflictDesc = topFolders.length > 0
        ? `Folder${topFolders.length > 1 ? 's' : ''} "${topFolders.join('", "')}" already exist${topFolders.length > 1 ? '' : 's'}.`
        : `The following files already exist: ${existingFiles.map((f) => f.name).join(', ')}`;

    return { existingFiles, conflictDesc };
}
