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
 * 传输层闸门：对实际 HTTP(S) URL 的 scheme 与 hostname 做允许列表匹配。
 *
 * 契约（fail-closed）：
 * - 空允许列表 = 拒绝一切出站（“未配置”不等于“放行”）。demo/hollow cell 需要空列表
 *   放行时必须由调用方显式传 `allowEmptyAllowlist: true`，不允许从 env 猜测。
 * - scheme：默认只允许 `https:`；`http:` 仅对 loopback 主机（127.0.0.1 / ::1 /
 *   localhost）放行；其余 scheme 一律拒绝。
 * - 条目为精确 hostname，或以 `*.` 前缀显式声明的后缀域。裸条目不再隐式匹配子域
 *   （原 `host.endsWith('.' + entry)` 会让任何子域随父域一起被放行）。
 * - 纯 CIDR 列表无法在无 DNS 时裁决主机名 → 拒绝（daemon 启动闸门另要求至少一个
 *   hostname 条目）。
 */
export interface EgressUrlGateOptions {
  /**
   * 显式声明“允许空允许列表”（demo/hollow cell）。除 demo 外任何调用点都不得传 true。
   */
  allowEmptyAllowlist?: boolean;
}

export function assertEgressUrlAllowed(
  url: RequestInfo | URL,
  allowlist: readonly string[],
  options: EgressUrlGateOptions = {},
): void {
  if (allowlist.length === 0) {
    if (options.allowEmptyAllowlist === true) return;
    throw new Error(
      'ADAPTER_OPS_EGRESS_DENIED: COMMANDER_ADAPTER_EGRESS_ALLOWLIST is empty; refusing outbound request',
    );
  }
  const href = typeof url === 'string' ? url : url instanceof URL ? url.href : String(url);
  let target: URL;
  try {
    target = new URL(href);
  } catch {
    throw new Error('ADAPTER_OPS_EGRESS_DENIED: unparseable URL ' + href.slice(0, 120));
  }
  // `URL.hostname` keeps the brackets of an IPv6 literal; entries are written bare.
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  assertEgressSchemeAllowed(target);
  const hostEntries = allowlist.filter((entry) => !looksLikeCidr(entry));
  if (hostEntries.length === 0) {
    // 仅有 CIDR 时应用层无法裁决主机名 → 拒绝，而不是放行。
    throw new Error(
      'ADAPTER_OPS_EGRESS_DENIED: allowlist has no hostname entry to adjudicate host ' + host,
    );
  }
  const allowed = hostEntries.some((entry) => hostMatches(host, entry.toLowerCase()));
  if (!allowed) {
    throw new Error(
      'ADAPTER_OPS_EGRESS_DENIED: host ' + host + ' not in COMMANDER_ADAPTER_EGRESS_ALLOWLIST',
    );
  }
}

/** `https:` always; `http:` only for loopback targets; everything else is denied. */
function assertEgressSchemeAllowed(target: URL): void {
  const protocol = target.protocol.toLowerCase();
  if (protocol === 'https:') return;
  if (protocol === 'http:' && isLoopbackHost(target.hostname)) return;
  throw new Error(
    'ADAPTER_OPS_EGRESS_DENIED: scheme ' +
      protocol +
      ' is not permitted for host ' +
      target.hostname.toLowerCase() +
      ' (https only; http is limited to loopback)',
  );
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export function createEgressGatedFetch(
  allowlist: readonly string[],
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  options: EgressUrlGateOptions = {},
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    assertEgressUrlAllowed(input, allowlist, options);
    return fetchImpl(input, init);
  }) as typeof fetch;
}

function looksLikeCidr(entry: string): boolean {
  return (
    /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(entry) || (entry.includes(':') && entry.includes('/'))
  );
}

function hostMatches(host: string, entry: string): boolean {
  if (entry.startsWith('*.')) {
    const suffix = entry.slice(1);
    return host.length > suffix.length && host.endsWith(suffix);
  }
  if (entry.includes('*')) {
    // A wildcard that is not the documented leading `*.` form would silently never
    // match; treat the configuration as invalid instead of fail-open.
    throw new Error(
      'ADAPTER_OPS_EGRESS_ALLOWLIST_INVALID: wildcard entries must use the leading "*." form: ' +
        entry,
    );
  }
  return host === entry;
}
