import { FmApiError } from '@/services/fmApiError';

export const ZARR_BATCH_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const ZARR_BATCH_UPLOAD_MAX_FILES = 2000;
export const ZARR_BATCH_UPLOAD_MIN_BYTES = 8 * 1024 * 1024;
export const ZARR_BATCH_UPLOAD_TARGET_BATCH_COUNT = 100;

export const CHUNK_UPLOAD_MIN_BYTES = 8 * 1024 * 1024;
export const CHUNK_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const CHUNK_UPLOAD_TARGET_COUNT = 1000;
export const CHUNK_UPLOAD_CONCURRENCY = 3;

/** Assumed minimum upload speed for timeout budgeting (32 KB/s). */
export const CHUNK_UPLOAD_MIN_ASSUMED_SPEED_BPS = 32 * 1024;
/** Per-chunk request timeout ceiling (1 hour). */
export const CHUNK_UPLOAD_MAX_TIMEOUT_MS = 60 * 60 * 1000;

export const COMPLETE_POLL_FAST_INTERVAL_MS = 10_000;
export const COMPLETE_POLL_INTERVAL_MS = 15_000;

const MERGE_IN_PROGRESS_MARKERS = ['merge already in progress', 'resource_conflict'];

const CHUNKED_UPLOAD_STORAGE_KEY = 'tissuelab:chunked-upload-sessions';
const ZARR_BATCH_UPLOAD_STORAGE_KEY = 'tissuelab:zarr-batch-upload-sessions';
/** Fallback when session has no fileSize (legacy entries). */
const CHUNKED_UPLOAD_SESSION_FALLBACK_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** Match server STALE_UPLOAD_SESSION_MAX_AGE_SECONDS (7 days). */
export const CHUNK_UPLOAD_SESSION_MIN_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** Minimum interval between localStorage updatedAt refreshes during upload. */
export const CHUNK_UPLOAD_PERSIST_INTERVAL_MS = 30_000;
/** Progress cap while bytes/chunks upload; merge completes the final 1% to 100%. */
export const UPLOAD_PROGRESS_PRE_MERGE_MAX = 99;

export function progressBeforeMergeFromRatio(ratio: number): number {
    if (!Number.isFinite(ratio) || ratio <= 0) return 0;
    return Math.min(UPLOAD_PROGRESS_PRE_MERGE_MAX, Math.round(ratio * UPLOAD_PROGRESS_PRE_MERGE_MAX));
}

export interface PersistedChunkUploadSession {
    uploadId: string;
    filename: string;
    fileSize: number;
    fileLastModified: number;
    path: string;
    chunkSize: number;
    totalChunks: number;
    relativePath?: string;
    overwrite: boolean;
    keepBoth: boolean;
    updatedAt: number;
}

export interface ChunkUploadStatusSnapshot {
    total_chunks: number;
    missing_chunks: number[];
    progress: number;
    total_size: number;
}

function pickBoundedPartSize(
    totalBytes: number,
    targetCount: number,
    minBytes: number,
    maxBytes: number
): number {
    if (totalBytes <= 0) return minBytes;
    const ideal = Math.ceil(totalBytes / targetCount);
    return Math.min(maxBytes, Math.max(minBytes, ideal));
}

export function pickZarrBatchMaxBytesForTotalSize(totalBytes: number): number {
    return pickBoundedPartSize(
        totalBytes,
        ZARR_BATCH_UPLOAD_TARGET_BATCH_COUNT,
        ZARR_BATCH_UPLOAD_MIN_BYTES,
        ZARR_BATCH_UPLOAD_MAX_BYTES
    );
}

export function pickChunkSizeForFile(fileSize: number): number {
    return pickBoundedPartSize(
        fileSize,
        CHUNK_UPLOAD_TARGET_COUNT,
        CHUNK_UPLOAD_MIN_BYTES,
        CHUNK_UPLOAD_MAX_BYTES
    );
}

export function computeChunkUploadTimeoutMs(chunkSize: number): number {
    const BUFFER_MS = 60_000;
    const MIN_MS = 120_000;
    const transferMs = Math.ceil(
        (chunkSize / CHUNK_UPLOAD_MIN_ASSUMED_SPEED_BPS) * 1000
    );
    return Math.min(
        CHUNK_UPLOAD_MAX_TIMEOUT_MS,
        Math.max(MIN_MS, transferMs + BUFFER_MS)
    );
}

export function computeCompleteUploadTimeoutMs(fileSize: number): number {
    const MIN_MERGE_SPEED_BPS = 10 * 1024 * 1024;
    const BUFFER_MS = 10 * 60 * 1000;
    const ABSOLUTE_MIN_MS = 10 * 60 * 1000;
    const GB = 1024 * 1024 * 1024;
    const sizeBasedMinMs = Math.min(90 * 60 * 1000, Math.ceil(fileSize / GB) * 60 * 1000);
    const MIN_MS = Math.max(ABSOLUTE_MIN_MS, sizeBasedMinMs);
    return Math.max(MIN_MS, Math.ceil((fileSize / MIN_MERGE_SPEED_BPS) * 1000) + BUFFER_MS);
}

export function isAbortError(error: unknown): boolean {
    return (error instanceof DOMException || error instanceof Error) && error.name === 'AbortError';
}

export function isMergeInProgressError(error: unknown): boolean {
    const lower = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
    if (MERGE_IN_PROGRESS_MARKERS.some((marker) => lower.includes(marker))) {
        return true;
    }
    if (error instanceof FmApiError) {
        if (error.errorCode === 'RESOURCE_CONFLICT') {
            return MERGE_IN_PROGRESS_MARKERS.some((marker) => lower.includes(marker))
                || lower.includes('merge')
                || lower.includes('being merged');
        }
    }
    return false;
}

export function isRequestQuotaExceededError(error: unknown): boolean {
    if (error instanceof FmApiError) {
        return error.errorCode === 'REQUEST_QUOTA_EXCEEDED';
    }
    const err = error as { errorCode?: string };
    return err.errorCode === 'REQUEST_QUOTA_EXCEEDED';
}

export function computeRetryDelayMs(error: unknown, attempt: number, baseMs = 1000): number {
    if (error instanceof FmApiError && error.retryAfter && error.retryAfter > 0) {
        return error.retryAfter * 1000;
    }
    return baseMs * Math.max(1, attempt);
}

export function isStorageQuotaError(error: unknown): boolean {
    if (error instanceof FmApiError) {
        if (error.errorCode === 'REQUEST_QUOTA_EXCEEDED') return false;
        if (
            error.errorCode === 'QUOTA_EXCEEDED'
            || error.errorCode === 'BUSINESS_QUOTA_EXCEEDED'
            || error.errorCode === 'STORAGE_QUOTA_EXCEEDED'
        ) {
            return true;
        }
        if (error.status === 429) {
            const msg = error.message.toLowerCase();
            return msg.includes('storage') && (msg.includes('quota') || msg.includes('exceed'));
        }
        return false;
    }
    const err = error as { status?: number; message?: string; errorCode?: string };
    if (err.errorCode === 'REQUEST_QUOTA_EXCEEDED') return false;
    if (
        err.errorCode === 'STORAGE_QUOTA_EXCEEDED'
        || err.errorCode === 'QUOTA_EXCEEDED'
        || err.errorCode === 'BUSINESS_QUOTA_EXCEEDED'
    ) {
        return true;
    }
    const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
    if (message.includes('request quota')) return false;
    return (
        (err.status === 429 && message.includes('storage') && (message.includes('quota') || message.includes('exceed')))
        || (message.includes('storage') && message.includes('exceed'))
    );
}

export function isCompleteRetryableError(error: unknown): boolean {
    if (isMergeInProgressError(error)) return true;
    const lower = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
    return lower.includes('metadata registration failed') || lower.includes('retry complete');
}

/** User-facing message for upload errors (timeouts, metadata retry, merge cancel, etc.). */
export function mapUploadErrorMessage(error: unknown): string {
    const lower = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();

    if (lower.includes('cannot cancel while the file is being merged')) {
        return 'The file is being merged on the server. Cancel is unavailable until merge finishes.';
    }
    if (isCompleteRetryableError(error)) {
        return 'The file was assembled on the server but registration failed. Keep this window open to retry automatically, or re-select the same file to resume.';
    }
    if (lower.includes('timed out') || lower.includes('re-select the same file')) {
        return 'Upload timed out. Re-select the same file to continue where you left off.';
    }
    if (isMergeInProgressError(error)) {
        return 'Server is merging your file. This may take a while for large files — please wait.';
    }
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error ?? 'Upload failed');
}

export function formatUploadDurationMs(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    if (ms < 60_000) return '< 1 min';
    const totalMinutes = Math.ceil(ms / 60_000);
    if (totalMinutes < 60) return `~${totalMinutes} min`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `~${hours}h ${minutes}m` : `~${hours}h`;
}

/** Estimated merge time remaining based on file size budget and elapsed merge time. */
export function estimateMergeRemainingMs(fileSize: number, mergeStartedAt: number): number {
    const budgetMs = computeCompleteUploadTimeoutMs(fileSize);
    const elapsed = Math.max(0, Date.now() - mergeStartedAt);
    return Math.max(60_000, budgetMs - elapsed);
}

export interface ChunkUploadResumeHint {
    filename: string;
    fileSize: number;
    path: string;
    relativePath?: string;
    kind?: 'file' | 'zarr';
}

export interface PersistedZarrBatchUploadSession {
    uploadId: string;
    path: string;
    zarrDisplayPath: string;
    totalBytes: number;
    fileCount: number;
    hasConflicts: boolean;
    keepBoth: boolean;
    maxBatchBytes: number;
    folderRewrite?: Record<string, string>;
    updatedAt: number;
}

export function computeCompleteRetryAttempts(fileSize: number): number {
    const pollWindowMs = computeCompleteUploadTimeoutMs(fileSize) + (30 * 60 * 1000);
    return Math.max(120, Math.ceil(pollWindowMs / COMPLETE_POLL_FAST_INTERVAL_MS));
}

export function computeCompletePhaseBudgetMs(fileSize: number): number {
    const perAttemptMs = computeCompleteUploadTimeoutMs(fileSize);
    return perAttemptMs * 2 + computeCompleteRetryAttempts(fileSize) * COMPLETE_POLL_INTERVAL_MS;
}

export function computeUploadSessionTimeoutMs(fileSize: number): number {
    const MIN_MS = 30 * 60 * 1000;
    const transferMs = Math.ceil((fileSize / CHUNK_UPLOAD_MIN_ASSUMED_SPEED_BPS) * 1000);
    return Math.max(MIN_MS, transferMs + computeCompletePhaseBudgetMs(fileSize));
}

export function isCancelBlockedWhileMerging(error: unknown): boolean {
    const lower = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
    if (lower.includes('cannot cancel upload while merge')) {
        return true;
    }
    return isMergeInProgressError(error);
}

export function shouldRetryCompleteUpload(
    error: unknown,
    isCancelled: boolean,
    isSessionTimeout: boolean = false
): { retry: boolean; delayMs: number } {
    if (isCancelled || isSessionTimeout) return { retry: false, delayMs: 0 };
    if (isCompleteRetryableError(error)) {
        return { retry: true, delayMs: COMPLETE_POLL_FAST_INTERVAL_MS };
    }
    if (isRequestQuotaExceededError(error)) {
        return { retry: true, delayMs: computeRetryDelayMs(error, 1, COMPLETE_POLL_INTERVAL_MS) };
    }
    if (isAbortError(error)) {
        return { retry: true, delayMs: COMPLETE_POLL_INTERVAL_MS };
    }
    return { retry: false, delayMs: 0 };
}

export function buildChunkUploadSessionKey(
    filename: string,
    fileSize: number,
    fileLastModified: number,
    path: string,
    relativePath?: string,
    overwrite: boolean = false,
    keepBoth: boolean = false
): string {
    return [filename, fileSize, fileLastModified, path, relativePath || '', overwrite, keepBoth].join('|');
}

export function uploadedChunksFromStatus(status: ChunkUploadStatusSnapshot): Set<number> {
    return new Set(
        Array.from({ length: status.total_chunks }, (_, i) => i)
            .filter((i) => !status.missing_chunks.includes(i))
    );
}

function mergeAbortSignals(signals: AbortSignal[]): AbortSignal {
    const active = signals.filter((s) => !s.aborted);
    if (active.length === 0) {
        const controller = new AbortController();
        controller.abort();
        return controller.signal;
    }
    if (active.length === 1) return active[0];
    if (typeof AbortSignal !== 'undefined' && 'any' in AbortSignal) {
        return AbortSignal.any(active);
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    for (const signal of active) {
        signal.addEventListener('abort', abort, { once: true });
    }
    return controller.signal;
}

function uploadSignalWithTimeout(parent: AbortSignal | null | undefined, timeoutMs: number): {
    signal: AbortSignal;
    cleanup: () => void;
} {
    const chunkAbort = new AbortController();
    const timer = setTimeout(() => chunkAbort.abort(), timeoutMs);
    const signal = parent
        ? mergeAbortSignals([parent, chunkAbort.signal])
        : chunkAbort.signal;
    return { signal, cleanup: () => clearTimeout(timer) };
}

export async function withUploadTimeout<T>(
    timeoutMs: number,
    fn: (signal: AbortSignal) => Promise<T>,
    parentSignal?: AbortSignal | null
): Promise<T> {
    const { signal, cleanup } = uploadSignalWithTimeout(parentSignal, timeoutMs);
    try {
        return await fn(signal);
    } finally {
        cleanup();
    }
}

export function computePersistedSessionMaxAgeMs(fileSize: number): number {
    const computed = fileSize > 0
        ? computeUploadSessionTimeoutMs(fileSize)
        : CHUNKED_UPLOAD_SESSION_FALLBACK_MAX_AGE_MS;
    return Math.max(CHUNK_UPLOAD_SESSION_MIN_MAX_AGE_MS, computed);
}

export function buildZarrBatchUploadSessionKey(
    path: string,
    zarrDisplayPath: string,
    totalBytes: number,
    fileCount: number,
    hasConflicts: boolean = false,
    keepBoth: boolean = false,
): string {
    return ['zarr', path, zarrDisplayPath, totalBytes, fileCount, hasConflicts, keepBoth].join('|');
}

function readPersistedChunkUploadSessions(): Record<string, PersistedChunkUploadSession> {
    if (typeof window === 'undefined') return {};
    try {
        const raw = window.localStorage.getItem(CHUNKED_UPLOAD_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};

        const now = Date.now();
        let changed = false;
        for (const [key, value] of Object.entries(parsed)) {
            const session = value as PersistedChunkUploadSession;
            const maxAgeMs = computePersistedSessionMaxAgeMs(session.fileSize || 0);
            const stale = !session?.uploadId
                || (now - (session.updatedAt || 0)) > maxAgeMs;
            if (stale) {
                delete parsed[key];
                changed = true;
            }
        }
        if (changed) {
            writePersistedChunkUploadSessions(parsed as Record<string, PersistedChunkUploadSession>);
        }
        return parsed as Record<string, PersistedChunkUploadSession>;
    } catch {
        return {};
    }
}

export function listChunkUploadResumeHints(): ChunkUploadResumeHint[] {
    const fileHints = Object.values(readPersistedChunkUploadSessions()).map((session) => ({
        filename: session.filename,
        fileSize: session.fileSize,
        path: session.path,
        relativePath: session.relativePath,
        kind: 'file' as const,
    }));
    const zarrHints = Object.values(readPersistedZarrBatchUploadSessions()).map((session) => ({
        filename: session.zarrDisplayPath,
        fileSize: session.totalBytes,
        path: session.path,
        relativePath: session.zarrDisplayPath,
        kind: 'zarr' as const,
    }));
    return [...fileHints, ...zarrHints];
}

function writePersistedChunkUploadSessions(sessions: Record<string, PersistedChunkUploadSession>): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(CHUNKED_UPLOAD_STORAGE_KEY, JSON.stringify(sessions));
    } catch (error) {
        console.warn('Failed to persist chunked upload session:', error);
    }
}

export function loadPersistedChunkUploadSession(sessionKey: string): PersistedChunkUploadSession | null {
    return readPersistedChunkUploadSessions()[sessionKey] ?? null;
}

export function savePersistedChunkUploadSession(
    sessionKey: string,
    session: PersistedChunkUploadSession
): void {
    const sessions = readPersistedChunkUploadSessions();
    sessions[sessionKey] = session;
    writePersistedChunkUploadSessions(sessions);
}

export function clearPersistedChunkUploadSession(sessionKey: string): void {
    const sessions = readPersistedChunkUploadSessions();
    if (!(sessionKey in sessions)) return;
    delete sessions[sessionKey];
    writePersistedChunkUploadSessions(sessions);
}

function readPersistedZarrBatchUploadSessions(): Record<string, PersistedZarrBatchUploadSession> {
    if (typeof window === 'undefined') return {};
    try {
        const raw = window.localStorage.getItem(ZARR_BATCH_UPLOAD_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};

        const now = Date.now();
        let changed = false;
        for (const [key, value] of Object.entries(parsed)) {
            const session = value as PersistedZarrBatchUploadSession;
            const maxAgeMs = computePersistedSessionMaxAgeMs(session.totalBytes || 0);
            const stale = !session?.uploadId
                || (now - (session.updatedAt || 0)) > maxAgeMs;
            if (stale) {
                delete parsed[key];
                changed = true;
            }
        }
        if (changed) {
            writePersistedZarrBatchUploadSessions(parsed as Record<string, PersistedZarrBatchUploadSession>);
        }
        return parsed as Record<string, PersistedZarrBatchUploadSession>;
    } catch {
        return {};
    }
}

function writePersistedZarrBatchUploadSessions(sessions: Record<string, PersistedZarrBatchUploadSession>): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(ZARR_BATCH_UPLOAD_STORAGE_KEY, JSON.stringify(sessions));
    } catch (error) {
        console.warn('Failed to persist zarr batch upload session:', error);
    }
}

export function loadPersistedZarrBatchUploadSession(sessionKey: string): PersistedZarrBatchUploadSession | null {
    return readPersistedZarrBatchUploadSessions()[sessionKey] ?? null;
}

export function savePersistedZarrBatchUploadSession(
    sessionKey: string,
    session: PersistedZarrBatchUploadSession,
): void {
    const sessions = readPersistedZarrBatchUploadSessions();
    sessions[sessionKey] = session;
    writePersistedZarrBatchUploadSessions(sessions);
}

export function clearPersistedZarrBatchUploadSession(sessionKey: string): void {
    const sessions = readPersistedZarrBatchUploadSessions();
    if (!(sessionKey in sessions)) return;
    delete sessions[sessionKey];
    writePersistedZarrBatchUploadSessions(sessions);
}
