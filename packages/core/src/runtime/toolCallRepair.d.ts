export interface RepairResult {
    args: Record<string, unknown>;
    repairs: string[];
}
/**
 * Attempt to repair malformed tool call arguments.
 * Applies multiple strategies in order, stopping at first success.
 * Conservative: returns original input unchanged if nothing works.
 */
export declare function repairToolCallArguments(rawArgs: unknown, _toolName: string): RepairResult;
/**
 * Tier 3.1: produce concrete suggestions for repairing validation errors.
 * Each suggestion is a one-sentence hint the LLM can use to self-correct.
 */
export declare function suggestRepairsForValidationErrors(errors: Array<{
    path: string;
    message: string;
    expectedType?: string;
    actualValue?: unknown;
}>): string[];
//# sourceMappingURL=toolCallRepair.d.ts.map