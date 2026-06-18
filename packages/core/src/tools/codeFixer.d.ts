import type { Tool, ToolDefinition } from '../runtime/types';
export declare function fixPythonSyntax(code: string, errorHint?: string): {
    fixed: string;
    changes: string[];
};
export declare class CodeFixerTool implements Tool {
    readonly definition: ToolDefinition;
    isConcurrencySafe: boolean;
    isReadOnly: boolean;
    timeout: number;
    maxOutputSize: number;
    execute(args: Record<string, unknown>): Promise<string>;
}
//# sourceMappingURL=codeFixer.d.ts.map