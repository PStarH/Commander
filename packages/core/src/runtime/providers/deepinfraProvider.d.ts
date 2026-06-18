import { BaseOpenAICompatibleProvider, type OpenAICompatibleConfig } from './baseOpenAICompatible';
export declare class DeepInfraProvider extends BaseOpenAICompatibleProvider {
    readonly name = "deepinfra";
    protected getDefaultBaseUrl(): string;
    protected getDefaultModel(): string;
    protected getExtraConfig(): Partial<OpenAICompatibleConfig>;
}
//# sourceMappingURL=deepinfraProvider.d.ts.map