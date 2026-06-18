import type { Tool } from '../runtime/types';
/**
 * Built-in tool that requests human input mid-execution.
 * When ctx.resumeWith is set, returns that value (resume path).
 * Otherwise throws InterruptError to pause execution (interrupt path).
 */
export declare function createRequestHumanInputTool(): Tool;
//# sourceMappingURL=requestHumanInputTool.d.ts.map