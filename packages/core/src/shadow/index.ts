// packages/core/src/shadow/index.ts
export * from './types';
export { ShadowProxy, type ProxyContext, type Next } from './proxy';
export { scrubRequest, redactPii, DEFAULT_IGNORE_FIELDS } from './scrubber';
export { DriftReporter } from './driftReporter';
export { startShadowRunner, type RunnerOptions } from './runner';
