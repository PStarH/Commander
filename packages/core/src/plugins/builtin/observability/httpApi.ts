// Re-export the core observability HTTP API so the plugin surface stays in
// sync with the main implementation in packages/core/src/observability/httpApi.ts.
// This eliminates the previous 400-line duplicate that had drifted to the old
// response-writing signature.
export * from '../../../observability/httpApi';
