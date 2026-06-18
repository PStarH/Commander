"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SafeFetchError = void 0;
exports.performFetch = performFetch;
exports.safeFetch = safeFetch;
const urlSafety_1 = require("./urlSafety");
class SafeFetchError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'SafeFetchError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
exports.SafeFetchError = SafeFetchError;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
async function performFetch(url, options = {}) {
    var _a, _b, _c, _d, _e;
    const timeoutMs = (_a = options.timeoutMs) !== null && _a !== void 0 ? _a : DEFAULT_TIMEOUT_MS;
    const maxBytes = (_b = options.maxBytes) !== null && _b !== void 0 ? _b : DEFAULT_MAX_BYTES;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    timer.unref();
    let response;
    try {
        response = await fetch(url, {
            method: (_c = options.method) !== null && _c !== void 0 ? _c : 'GET',
            headers: options.headers,
            signal: controller.signal,
            redirect: 'follow',
        });
    }
    catch (err) {
        clearTimeout(timer);
        if (timedOut) {
            throw new SafeFetchError('timeout', `Request to ${url} timed out after ${timeoutMs}ms`);
        }
        if (err instanceof Error && err.name === 'AbortError') {
            throw new SafeFetchError('aborted', `Request to ${url} was aborted`);
        }
        throw new SafeFetchError('network', `Network error: ${err.message}`);
    }
    if (options.method === 'HEAD' || !response.body) {
        clearTimeout(timer);
        return {
            ok: response.ok,
            status: response.status,
            body: '',
            bytes: 0,
            truncated: false,
            contentType: (_d = response.headers.get('content-type')) !== null && _d !== void 0 ? _d : '',
            finalUrl: response.url,
        };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            if (!value)
                continue;
            bytes += value.byteLength;
            if (bytes > maxBytes) {
                const allowed = Math.max(0, value.byteLength - (bytes - maxBytes));
                if (allowed > 0) {
                    chunks.push(decoder.decode(value.subarray(0, allowed), { stream: true }));
                }
                bytes = maxBytes;
                truncated = true;
                await reader.cancel().catch(() => { });
                break;
            }
            chunks.push(decoder.decode(value, { stream: true }));
        }
    }
    catch (err) {
        clearTimeout(timer);
        reader.cancel().catch(() => { });
        if (timedOut) {
            throw new SafeFetchError('timeout', `Request to ${url} timed out after ${timeoutMs}ms`);
        }
        throw new SafeFetchError('network', `Stream read error: ${err.message}`);
    }
    finally {
        clearTimeout(timer);
    }
    chunks.push(decoder.decode());
    return {
        ok: response.ok,
        status: response.status,
        body: chunks.join(''),
        bytes,
        truncated,
        contentType: (_e = response.headers.get('content-type')) !== null && _e !== void 0 ? _e : '',
        finalUrl: response.url,
    };
}
async function safeFetch(url, options = {}) {
    const safety = (0, urlSafety_1.isUrlSafe)(url);
    if (!safety.safe) {
        throw new SafeFetchError('unsafe_url', `URL blocked: ${safety.reason}`);
    }
    return performFetch(url, options);
}
