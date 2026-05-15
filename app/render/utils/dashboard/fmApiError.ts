/** Structured HTTP/API errors from FM / ctrl service (`handleResponse` in fileManager.service). */
export class FmApiError extends Error {
    readonly status: number;
    readonly errorCode?: string;
    readonly isAppErrorWrapped?: boolean;
    readonly requiredBytes?: number;
    readonly availableBytes?: number;
    readonly quotaBytes?: number;
    readonly retryAfter?: number;

    constructor(
        message: string,
        init: {
            status: number;
            errorCode?: string;
            isAppErrorWrapped?: boolean;
            requiredBytes?: number;
            availableBytes?: number;
            quotaBytes?: number;
            retryAfter?: number;
        }
    ) {
        super(message);
        this.name = 'FmApiError';
        this.status = init.status;
        if (init.errorCode !== undefined) this.errorCode = init.errorCode;
        if (init.isAppErrorWrapped !== undefined) this.isAppErrorWrapped = init.isAppErrorWrapped;
        if (init.requiredBytes !== undefined) this.requiredBytes = init.requiredBytes;
        if (init.availableBytes !== undefined) this.availableBytes = init.availableBytes;
        if (init.quotaBytes !== undefined) this.quotaBytes = init.quotaBytes;
        if (init.retryAfter !== undefined) this.retryAfter = init.retryAfter;
    }
}

export function isFmApiError(e: unknown): e is FmApiError {
    return e instanceof FmApiError;
}
