import { BaseOpenAICompatibleProvider } from './baseOpenAICompatible';
import type { LLMRequest } from '../types';
export declare class AgnesProvider extends BaseOpenAICompatibleProvider {
    readonly name = "agnes";
    protected getDefaultBaseUrl(): string;
    protected getDefaultModel(): string;
    protected getExtraBody(request: LLMRequest): Record<string, unknown>;
}
//# sourceMappingURL=agnesProvider.d.ts.map