/** Structured HTTP/API errors from FM / ctrl service (`handleResponse` in fileManager.service). */
export class FmApiError extends Error {
    readonly status: number;
    readonly errorCode: string;
    readonly accessMode: string;
    readonly operation: string;
    readonly requestId: string;
    readonly isAppErrorWrapped: boolean;
    readonly requiredBytes: number | null;
    readonly availableBytes: number | null;
    readonly quotaBytes: number | null;
    readonly retryAfter: number | null;

    constructor(
        message: string,
        init: {
            status: number;
            errorCode?: string | null;
            accessMode?: string | null;
            operation?: string | null;
            requestId?: string | null;
            isAppErrorWrapped?: boolean;
            requiredBytes?: number | null;
            availableBytes?: number | null;
            quotaBytes?: number | null;
            retryAfter?: number | null;
        }
    ) {
        super(message);
        this.name = 'FmApiError';
        this.status = init.status;
        this.errorCode = init.errorCode ?? '';
        this.accessMode = init.accessMode ?? '';
        this.operation = init.operation ?? '';
        this.requestId = init.requestId ?? '';
        this.isAppErrorWrapped = init.isAppErrorWrapped ?? false;
        this.requiredBytes = init.requiredBytes ?? null;
        this.availableBytes = init.availableBytes ?? null;
        this.quotaBytes = init.quotaBytes ?? null;
        this.retryAfter = init.retryAfter ?? null;
    }
}

export function isFmApiError(e: unknown): e is FmApiError {
    return e instanceof FmApiError;
}
