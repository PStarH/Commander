/**
 * Type declarations for optional dependencies.
 *
 * These packages are not required at build time — they are loaded dynamically
 * at runtime via try-catch wrapped dynamic imports. These declarations prevent
 * tsc --noEmit errors while preserving the lazy-loading intent.
 *
 * If you install these packages, the declarations here serve as a fallback
 * and will be overridden by the actual package types.
 */

declare module '@aws-sdk/client-bedrock-runtime' {
  export class BedrockRuntimeClient {
    constructor(config: Record<string, unknown>);
    send(command: unknown): Promise<unknown>;
  }

  export class ConverseCommand {
    constructor(body: Record<string, unknown>);
  }

  export class InvokeModelCommand {
    constructor(body: Record<string, unknown>);
  }
}
