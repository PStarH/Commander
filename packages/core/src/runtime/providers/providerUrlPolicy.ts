/**
 * MCP-11: provider base-URL egress policy.
 *
 * Provider base URLs are frequently sourced from environment variables
 * (`*_BASE_URL`). A compromised, typo'd, or attacker-influenced value would
 * otherwise send the API key and the full prompt to an arbitrary host over
 * plaintext. This module enforces, at the single point where a request URL is
 * built from a base URL:
 *
 *   1. HTTPS is required — except for explicitly-local providers on a loopback
 *      host (Ollama/vLLM), or when COMMANDER_ALLOW_INSECURE_PROVIDER_URLS=1.
 *   2. An optional host allowlist (COMMANDER_PROVIDER_HOST_ALLOWLIST, comma
 *      separated, supports leading `*.` wildcards) pins egress to known hosts.
 *
 * Fail-closed: an unparseable or disallowed URL throws before any secret or
 * prompt leaves the process.
 */

function isTruthyEnv(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((value ?? '').toLowerCase());
}

function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  );
}

export function assertSafeProviderBaseUrl(
  rawUrl: string,
  opts: { providerName?: string; isLocal?: boolean } = {},
): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Provider base URL is not a valid URL: ${JSON.stringify(rawUrl)}`);
  }

  const host = url.hostname.toLowerCase();
  const loopback = isLoopbackHost(host);
  const allowInsecure = isTruthyEnv(process.env.COMMANDER_ALLOW_INSECURE_PROVIDER_URLS);

  // 1. Scheme.
  if (url.protocol !== 'https:') {
    const httpOkForLocal = url.protocol === 'http:' && (opts.isLocal === true || loopback);
    if (!httpOkForLocal && !allowInsecure) {
      throw new Error(
        `Provider "${opts.providerName ?? 'unknown'}" base URL must use https ` +
          `(got ${url.protocol}//${host}). Set COMMANDER_ALLOW_INSECURE_PROVIDER_URLS=1 ` +
          `to allow plaintext for a trusted local/dev endpoint.`,
      );
    }
  }

  // 2. Optional host allowlist.
  const allowlistRaw = process.env.COMMANDER_PROVIDER_HOST_ALLOWLIST;
  if (allowlistRaw && allowlistRaw.trim()) {
    const patterns = allowlistRaw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const matches = patterns.some((p) => {
      if (p.startsWith('*.')) {
        const suffix = p.slice(1); // ".example.com"
        return host === p.slice(2) || host.endsWith(suffix);
      }
      return host === p;
    });
    // Local providers on loopback are always permitted regardless of the allowlist.
    if (!matches && !(loopback && opts.isLocal === true)) {
      throw new Error(
        `Provider "${opts.providerName ?? 'unknown'}" host "${host}" is not in ` +
          `COMMANDER_PROVIDER_HOST_ALLOWLIST.`,
      );
    }
  }
}
