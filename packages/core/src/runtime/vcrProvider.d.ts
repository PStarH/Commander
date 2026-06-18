import type { LLMProvider, LLMRequest, LLMResponse } from './types';
export interface VCREntry {
    request: LLMRequest;
    response: LLMResponse;
    recordedAt: string;
    hash: string;
}
export interface VCRCassette {
    name: string;
    version: 1;
    recordedAt: string;
    entries: VCREntry[];
}
export interface VCRConfig {
    cassetteDir: string;
    mode: 'record' | 'replay' | 'passthrough';
    hashAlgorithm?: string;
    matchByContent?: boolean;
}
export declare class VCRProvider implements LLMProvider {
    readonly name: string;
    private wrapped;
    private config;
    private cassette;
    private cassettePath;
    private hitCount;
    private missCount;
    constructor(wrapped: LLMProvider, config: VCRConfig);
    call(request: LLMRequest): Promise<LLMResponse>;
    getStats(): {
        hits: number;
        misses: number;
        entries: number;
    };
    getCassette(): VCRCassette;
    clearStats(): void;
    private findMatch;
    private recordEntry;
    private loadCassette;
    private saveCassette;
    private sanitizeName;
}
export declare function createVCRProvider(wrapped: LLMProvider, cassetteDir: string, mode?: 'record' | 'replay' | 'passthrough'): VCRProvider;
//# sourceMappingURL=vcrProvider.d.ts.map