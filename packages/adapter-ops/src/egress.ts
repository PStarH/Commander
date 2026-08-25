/**
 * adapter-ops 出站允许列表：非 demo 单元必须在启动 outbound daemon 前满足。
 * 应用层 fail-closed；K8s NetworkPolicy 是额外兜底，不能替代本闸门。
 */

export function parseEgressAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.COMMANDER_ADAPTER_EGRESS_ALLOWLIST?.trim() ?? '';
  const allowlist = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const kubernetesServer = env.COMMANDER_KUBERNETES_SERVER?.trim();
  if (kubernetesServer) {
    let server: URL;
    try {
      server = new URL(kubernetesServer);
    } catch {
      throw new Error('COMMANDER_KUBERNETES_SERVER_INVALID: expected an HTTPS URL');
    }
    if (
      server.protocol !== 'https:' ||
      server.username ||
      server.password ||
      server.search ||
      server.hash
    ) {
      throw new Error('COMMANDER_KUBERNETES_SERVER_INVALID: expected an HTTPS origin');
    }
    allowlist.push(server.hostname);
  }
  return [...new Set(allowlist)];
}

/**
 * Fail-closed default: an unset/empty tier must NOT be treated as 'demo' (which
 * skips the egress allowlist gate below). Demo openness requires an explicit
 * COMMANDER_CELL_TIER=demo; anything else — including unset — is non-demo.
 */
export function cellTier(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMMANDER_CELL_TIER?.trim() || 'unspecified';
}

/** 非 demo 且 allowlist 为空 → 禁止启动 reconciliation/compensation daemon。 */
export function assertEgressAllowlistBeforeDaemonStart(
  tier: string,
  allowlist: readonly string[],
): void {
  if (tier !== 'demo' && allowlist.length === 0) {
    throw new Error(
      'ADAPTER_OPS_EGRESS_ALLOWLIST_REQUIRED: set COMMANDER_ADAPTER_EGRESS_ALLOWLIST before starting outbound daemons on non-demo cells',
    );
  }
  // AUDIT-F1: CIDR-only allowlists silently disabled the application-layer
  // hostname gate (assertEgressUrlAllowed cannot adjudicate IPs without DNS
  // resolution). That made an operator-looking config equivalent to
  // allow-any-host, leaving NetworkPolicy as the only control. Fail closed:
  // at least one hostname entry is required; CIDR entries remain additive.
  const hostEntries = allowlist.filter((e) => !looksLikeCidr(e));
  if (tier !== 'demo' && allowlist.length > 0 && hostEntries.length === 0) {
    throw new Error(
      'ADAPTER_OPS_EGRESS_ALLOWLIST_HOST_REQUIRED: COMMANDER_ADAPTER_EGRESS_ALLOWLIST contains only CIDR entries; ' +
        'the application-layer hostname gate cannot adjudicate them. Add at least one hostname (or *.suffix) entry.',
    );
  }
}

/**
 * 传输层闸门：对实际 HTTP(S) URL 的 hostname 做允许列表匹配。
 * 条目为 hostname（或后缀域）；CIDR 条目无法在无 DNS 解析时匹配，交由 NetworkPolicy。
 */
export function assertEgressUrlAllowed(url: RequestInfo | URL, allowlist: readonly string[]): void {
  if (allowlist.length === 0) return;
  const href = typeof url === 'string' ? url : url instanceof URL ? url.href : String(url);
  let host: string;
  try {
    host = new URL(href).hostname.toLowerCase();
  } catch {
    throw new Error('ADAPTER_OPS_EGRESS_DENIED: unparseable URL ' + href.slice(0, 120));
  }
  const hostEntries = allowlist.filter((entry) => !looksLikeCidr(entry));
  if (hostEntries.length === 0) {
    // 仅有 CIDR 时应用层无法裁决主机名；daemon 启动闸门已要求非空 allowlist。
    return;
  }
  const allowed = hostEntries.some((entry) => hostMatches(host, entry.toLowerCase()));
  if (!allowed) {
    throw new Error(
      'ADAPTER_OPS_EGRESS_DENIED: host ' + host + ' not in COMMANDER_ADAPTER_EGRESS_ALLOWLIST',
    );
  }
}

export function createEgressGatedFetch(
  allowlist: readonly string[],
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    assertEgressUrlAllowed(input, allowlist);
    return fetchImpl(input, init);
  }) as typeof fetch;
}

function looksLikeCidr(entry: string): boolean {
  return (
    /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(entry) || (entry.includes(':') && entry.includes('/'))
  );
}

function hostMatches(host: string, entry: string): boolean {
  if (host === entry) return true;
  if (entry.startsWith('*.') && host.endsWith(entry.slice(1))) return true;
  if (!entry.includes('*') && host.endsWith('.' + entry)) return true;
  return false;
}
