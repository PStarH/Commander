export const SUPPORTED_NODE_MAJOR = 22;

export function isSupportedNodeVersion(version: string): boolean {
  return (
    Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '', 10) === SUPPORTED_NODE_MAJOR
  );
}
