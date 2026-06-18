import { BaseOpenAICompatibleProvider, type OpenAICompatibleConfig } from './baseOpenAICompatible';
export declare class AnyscaleProvider extends BaseOpenAICompatibleProvider {
    readonly name = "anyscale";
    protected getDefaultBaseUrl(): string;
    protected getDefaultModel(): string;
    protected getExtraConfig(): Partial<OpenAICompatibleConfig>;
}
//# sourceMappingURL=anyscaleProvider.d.ts.map