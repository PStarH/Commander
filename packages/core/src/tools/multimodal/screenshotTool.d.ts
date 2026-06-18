import type { Tool, ToolDefinition } from '../../runtime/types';
export declare class ScreenshotCaptureTool implements Tool {
    readonly definition: ToolDefinition;
    isConcurrencySafe: boolean;
    isReadOnly: boolean;
    timeout: number;
    maxOutputSize: number;
    execute(args: Record<string, unknown>): Promise<string>;
    private captureUrl;
    private captureScreen;
}
//# sourceMappingURL=screenshotTool.d.ts.map