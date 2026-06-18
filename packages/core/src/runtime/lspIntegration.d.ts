import type { Tool } from '../runtime/types';
interface LSPDiagnostic {
    range: {
        start: {
            line: number;
            character: number;
        };
        end: {
            line: number;
            character: number;
        };
    };
    severity: number;
    message: string;
    source?: string;
    code?: string | number;
}
export declare function initLSP(serverCommand: string, serverArgs: string[], workspaceRoot?: string): Promise<void>;
export declare function disconnectLSP(): void;
export declare function resetLSP(): void;
export declare function isLSPReady(): boolean;
export declare function attachDiagnostics(content: string, filePath: string): string;
export declare function getFileDiagnostics(filePath: string): LSPDiagnostic[];
export declare function hasLSErrors(filePath: string): boolean;
export declare function getLSErrorCount(filePath: string): {
    errors: number;
    warnings: number;
};
export declare function openLSEDocument(filePath: string, content?: string): void;
export declare class LSPDiagnosticsTool implements Tool {
    definition: {
        name: string;
        description: string;
        inputSchema: {
            type: string;
            properties: {
                filePath: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class LSPAttachTool implements Tool {
    definition: {
        name: string;
        description: string;
        inputSchema: {
            type: string;
            properties: {
                filePath: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    execute(args: Record<string, unknown>): Promise<string>;
}
export {};
//# sourceMappingURL=lspIntegration.d.ts.map