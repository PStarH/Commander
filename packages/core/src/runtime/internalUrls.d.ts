/**
 * Internal URL Protocol — unified resource access for the agent.
 *
 * Inspired by oh-my-pi's internal URL system. Provides a single interface
 * to access different resource types through the file_read tool:
 *
 * - agent://<id> — subagent output
 * - memory://<key> — memory store entries
 * - skill://<name> — skill content
 * - checkpoint://<id> — checkpoint state
 *
 * This simplifies the tool interface — the agent uses file_read for everything.
 */
export interface InternalUrlResult {
    content: string;
    mimeType?: string;
    immutable?: boolean;
}
export type InternalUrlHandler = (path: string, params: Record<string, string>) => Promise<InternalUrlResult>;
export interface ParsedInternalUrl {
    protocol: string;
    path: string;
    params: Record<string, string>;
}
/**
 * Parse an internal URL like "agent://id/output" or "memory://key?namespace=ns"
 */
export declare function parseInternalUrl(url: string): ParsedInternalUrl | null;
/**
 * Check if a string is an internal URL.
 */
export declare function isInternalUrl(url: string): boolean;
export declare class InternalUrlRouter {
    private handlers;
    constructor();
    /**
     * Register a handler for a protocol.
     */
    register(protocol: string, handler: InternalUrlHandler): void;
    /**
     * Resolve an internal URL to its content.
     */
    resolve(url: string): Promise<InternalUrlResult | null>;
    /**
     * Check if a URL can be handled.
     */
    canHandle(url: string): boolean;
    /**
     * Get list of supported protocols.
     */
    getProtocols(): string[];
    private handleCheckpoint;
    private handleMemory;
    private handleSkill;
    private handleAgent;
}
export declare function getInternalUrlRouter(): InternalUrlRouter;
export declare function resetInternalUrlRouter(): void;
//# sourceMappingURL=internalUrls.d.ts.map