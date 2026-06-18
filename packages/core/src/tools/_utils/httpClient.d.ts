export interface SafeFetchOptions {
    timeoutMs?: number;
    maxBytes?: number;
    headers?: Record<string, string>;
    method?: 'GET' | 'POST' | 'HEAD';
}
export interface SafeFetchResult {
    ok: boolean;
    status: number;
    body: string;
    bytes: number;
    truncated: boolean;
    contentType: string;
    finalUrl: string;
}
export declare class SafeFetchError extends Error {
    readonly code: 'timeout' | 'too_large' | 'network' | 'unsafe_url' | 'aborted';
    readonly name = "SafeFetchError";
    constructor(code: 'timeout' | 'too_large' | 'network' | 'unsafe_url' | 'aborted', message: string);
}
export declare function performFetch(url: string, options?: SafeFetchOptions): Promise<SafeFetchResult>;
export declare function safeFetch(url: string, options?: SafeFetchOptions): Promise<SafeFetchResult>;
//# sourceMappingURL=httpClient.d.ts.map