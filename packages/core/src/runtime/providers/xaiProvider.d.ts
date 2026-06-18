import { BaseOpenAICompatibleProvider, type OpenAICompatibleConfig } from './baseOpenAICompatible';
export declare class XAIProvider extends BaseOpenAICompatibleProvider {
    readonly name = "xai";
    protected getDefaultBaseUrl(): string;
    protected getDefaultModel(): string;
    protected getExtraConfig(): Partial<OpenAICompatibleConfig>;
}
//# sourceMappingURL=xaiProvider.d.ts.map