import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ClaimViolation {
  file: string;
  line: number;
  match: string;
  reason: string;
}

interface ScanOptions {
  files?: string[];
  contents?: Record<string, string>;
}

interface Rule {
  file: string;
  pattern: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  {
    file: 'README.md',
    pattern: /tamper-proof/i,
    reason: 'tamper-proof requires external anchor, key separation, and retained live evidence',
  },
  {
    file: 'apps/web/src/pages/SLOPage.tsx',
    pattern: /Public SLO commitments/i,
    reason:
      'the dashboard must distinguish target definitions and CI baselines from production SLA attainment',
  },
  {
    file: 'README.md',
    pattern: /RealWorld\s+\|/i,
    reason:
      'unsupported RealWorld benchmark row must not be published without a case manifest and results',
  },
  {
    file: 'README.md',
    pattern: /55\.7%\s+pass rate/i,
    reason: 'the retained benchmark matrix does not provide a citable source for this score',
  },
  {
    file: 'README-zh.md',
    pattern: /55\.7%\s*通过率/i,
    reason: 'the retained benchmark matrix does not provide a citable source for this score',
  },
  {
    file: 'README-ja.md',
    pattern: /55\.7%\s*pass rate/i,
    reason: 'the retained benchmark matrix does not provide a citable source for this score',
  },
  {
    file: 'README.md',
    pattern: /Every output is verified/i,
    reason: 'every-output verification must be qualified as configured/in-process checks',
  },
  {
    file: 'README.md',
    pattern: /Every output passes through five quality gates/i,
    reason: 'verification gates are configured and path-dependent, not universal output proof',
  },
  {
    file: 'README.md',
    pattern:
      /Every agent thought|Every agent decision|Quality Gates on Every Output|Running daily|same discipline as any production distributed system/i,
    reason:
      'public copy must describe emitted events, configured checks, and scheduled offline benchmarks without universal or production-proven wording',
  },
  {
    file: 'README.md',
    pattern: /100% defense/i,
    reason:
      'benchmark summaries must say all listed cases were blocked and retain the simulated-harness scope',
  },
  {
    file: 'README.md',
    pattern: /\[think\]/i,
    reason:
      'demo traces must label observable runtime events, not imply private chain-of-thought visibility',
  },
  {
    file: 'README.md',
    pattern: /Before returning any result, Commander runs 5-layer verification/i,
    reason: 'verification pipeline availability must be stated explicitly',
  },
  {
    file: 'CHANGELOG.md',
    pattern: /Multi-tenant isolation with per-tenant rate limits, concurrency, storage, memory/i,
    reason: 'historical release note overstates opt-in and simulated tenant controls',
  },
  {
    file: 'ENTERPRISE_READINESS.md',
    pattern: /\b(?:SOC2-2|SOC2-6|TEN-3|SLO-2)\b[^\n]*✅/i,
    reason:
      'readiness rows with simulated or baseline-only evidence must remain yellow until live proof exists',
  },
  {
    file: 'ENTERPRISE_READINESS.md',
    pattern: /SOC2-1[^\n]*never `?process\.env|OBS-1[^\n]*every LLM call[^\n]*✅/i,
    reason:
      'readiness rows must not claim fail-closed secret resolution or end-to-end tracing while documented gaps remain',
  },
  {
    file: 'CHANGELOG.md',
    pattern: /All benchmark reports updated with evidence chains and verified results/i,
    reason:
      'benchmark artifacts have mixed simulated/live evidence and are not independently verified',
  },
  {
    file: 'CHANGELOG.md',
    pattern: /(?:GAIA\s+69\.7%|PinchBench\s+97\.7%|BFCL\s+30-task.*80\.0%|MT-Bench.*7\.8\/10)/i,
    reason: 'invalidated or archival benchmark scores must not remain as current release claims',
  },
  {
    file: 'CHANGELOG.md',
    pattern: /real 165-task results|@commander\/operations/i,
    reason:
      'release history must not describe an unverified full GAIA rerun or a deleted package as shipped',
  },
  {
    file: 'BENCHMARK.md',
    pattern: /Topology \(live\)/i,
    reason: 'provider-backed benchmark is not production live-fire evidence',
  },
  {
    file: 'packages/action-adapters/package.json',
    pattern: /production action adapters/i,
    reason:
      'adapter implementations are conformance-tested; live production readiness is opt-in and unproven',
  },
  {
    file: 'packages/worker-plane/package.json',
    pattern: /"test:e2e"\s*:/i,
    reason: 'worker E2E scripts must distinguish in-memory runs from the opt-in PostgreSQL run',
  },
  {
    file: 'packages/core/src/security/euAiActCompliance.ts',
    pattern: /tamperProof:\s*true/i,
    reason:
      'compliance reports may not hardcode tamper-proof status; derive it from live manifest verification',
  },
  {
    file: 'packages/core/src/security/euAiActCompliance.ts',
    pattern:
      /(?:GAIA:\s*69\.7|PinchBench:\s*97\.7|HumanEval\+:\s*91\.5|BFCL \(Tool Selection\):\s*60\.0|BFCL \(Parameter Prediction\):\s*91\.4|8 execution patterns|every agent decision|all output boundaries)/i,
    reason:
      'compliance reports must not publish invalidated benchmark scores or universal visibility/output-boundary claims',
  },
  {
    file: 'packages/core/src/security/euAiActCompliance.ts',
    pattern: /Tamper-Proof:/i,
    reason:
      'compliance output must qualify external anchoring instead of presenting a generic tamper-proof label',
  },
  {
    file: 'packages/core/src/security/euAiActCompliance.ts',
    pattern:
      /EU AI Act compliance report generated|Compliance Reporter v1\.0|full replay capability|all security events|at all boundaries|designed to meet EU AI Act|No critical risks remain unmitigated|Every PR \(smoke\).*full battery/i,
    reason:
      'generated EU AI Act output must remain a self-assessment with configured-path and residual-risk boundaries',
  },
  {
    file: 'packages/core/src/security/redTeamBaseline.ts',
    pattern: /tamper-proof JSON/i,
    reason: 'baseline HMAC storage is tamper-evident until external WORM/KMS anchoring is verified',
  },
  {
    file: 'apps/web/src/pages/POCPage.tsx',
    pattern: /status:\s*'(?:live|completed|pilot)'/i,
    reason: 'unverified POC scenarios must be labelled illustrative/demo',
  },
  {
    file: 'packages/core/src/security/complianceAuditReport.ts',
    pattern: /Fully Compliant|fullyCompliant:\s*gaps\.length\s*===\s*0/i,
    reason:
      'internal control coverage is a reporting scaffold and cannot self-declare full compliance or certification',
  },
  {
    file: 'apps/api/src/securityPostureEndpoints.ts',
    pattern: /fullyCompliant:\s*gaps\.length\s*===\s*0/i,
    reason:
      'internal control coverage is a reporting scaffold and cannot self-declare full compliance or certification',
  },
  {
    file: 'apps/web/src/components/HallucinationRiskPanel.tsx',
    pattern: /every LLM output|every output passed/i,
    reason:
      'UI must report observed detector signals and enabled paths, not universal output verification',
  },
  {
    file: 'apps/web/src/components/OnboardingWizard.tsx',
    pattern: /实时查看思考|view thinking/i,
    reason:
      'onboarding copy must describe observable runtime events rather than private model reasoning',
  },
  {
    file: 'apps/web/src/pages/POCPage.tsx',
    pattern: /value:\s*['"][^'"]*(?:%|[<>]\s*\d|\d+(?:\.\d+)?x)/i,
    reason: 'illustrative POC scenarios must not publish unsupported numeric outcomes',
  },
  {
    file: 'apps/web/src/i18n.ts',
    pattern: /['"]poc\.sectionLabel['"]:\s*['"]Enterprise Pilots['"]/i,
    reason: 'illustrative POC content must not be labelled as real enterprise pilots',
  },
  {
    file: 'README-zh.md',
    pattern: /PinchBench-|HumanEval\+|\$0\.10|这不是模拟|真实录像|每个结果在返回前都经过验证/i,
    reason:
      'localized README must not publish unverified benchmark, cost, recording, or universal verification claims',
  },
  {
    file: 'README-ja.md',
    pattern:
      /PinchBench-|HumanEval\+|\$0\.10|モックアップではありません|実録画|すべての結果は返却前に検証されます/i,
    reason:
      'localized README must not publish unverified benchmark, cost, recording, or universal verification claims',
  },
  {
    file: 'README-ja.md',
    pattern: /すべてが見える|各エージェントの思考|結果を信頼|毎日実行中/i,
    reason:
      'localized README must scope streaming to emitted events and benchmark status to the scheduled offline run',
  },
  {
    file: 'README-ja.md',
    pattern: /100% defense/i,
    reason:
      'benchmark summaries must say all listed cases were blocked and retain the simulated-harness scope',
  },
  {
    file: 'README-zh.md',
    pattern: /一切尽在眼前|每个智能体的思考过程|信任结果|每日运行中/i,
    reason:
      'localized README must scope streaming to emitted events and benchmark status to the scheduled offline run',
  },
  {
    file: 'README-zh.md',
    pattern: /100% 防御/i,
    reason:
      'benchmark summaries must say all listed cases were blocked and retain the simulated-harness scope',
  },
  {
    file: 'docs/getting-started.md',
    pattern: /每个代理的思考/i,
    reason:
      'getting-started documentation must describe emitted events rather than promise complete private reasoning',
  },
  {
    file: 'examples/README.md',
    pattern: /see agent reasoning in real-time/i,
    reason:
      'examples documentation must describe observable events rather than complete private reasoning',
  },
  {
    file: 'apps/web/src/pages/POCPage.tsx',
    pattern: /poc\.quote\./i,
    reason: 'unverified customer quotes must not be presented as pilot evidence',
  },
  {
    file: 'apps/web/src/i18n.ts',
    pattern: /poc\.status\.(?:live|completed|pilot)|Completed \/ Live/i,
    reason: 'POC UI status copy must not imply live or completed customer pilots',
  },
  {
    file: 'packages/core/tests/architecture/v2-cross-node-fencing.test.ts',
    pattern: /exactly-once execution semantics/i,
    reason: 'in-memory fencing tests cannot establish universal external exactly-once effects',
  },
  {
    file: 'packages/core/tests/architecture/v2-worker-load.test.ts',
    pattern: /No duplicate executions/i,
    reason: 'in-memory step-claim uniqueness must be stated with its scope',
  },
  {
    file: 'packages/core/tests/architecture/v2-worker-autoscale.test.ts',
    pattern: /No duplicate executions/i,
    reason: 'in-memory step-claim uniqueness must be stated with its scope',
  },
  {
    file: 'packages/core/tests/architecture/v2-cross-tenant-live-fire.test.ts',
    pattern: /Live-Fire/i,
    reason: 'in-memory tenant protocol tests are not live-fire infrastructure evidence',
  },
  {
    file: 'packages/core/tests/architecture/v2-compensation-rollback.test.ts',
    pattern: /Live-Fire/i,
    reason: 'in-memory compensation tests are not live-fire external-effect evidence',
  },
  {
    file: 'packages/worker-plane/src/e2e/gateway-kernel-worker.e2e.test.ts',
    pattern: /Gateway → Kernel → Worker real execution loop/i,
    reason: 'the PostgreSQL block is opt-in and must be labelled as such',
  },
  {
    file: 'scripts/benchmark-agentdojo.ts',
    pattern: /100% defense/i,
    reason:
      'CLI output must scope a pass to all listed embedded cases rather than imply universal defense',
  },
  {
    file: 'packages/core/tests/security/agentdojoDefense.test.ts',
    pattern: /(?:Every real AgentDojo|100% defense rate|real indirect-injection test cases)/i,
    reason:
      'the test covers embedded sample cases and must not imply coverage of the complete external dataset',
  },
  {
    file: 'packages/core/src/security/securityBenchmarkRunner.ts',
    pattern: /All critical-severity test cases were blocked/i,
    reason:
      'generated reports must scope a pass to the listed sample cases and configured defenses',
  },
  {
    file: 'apps/web/src/pages/SecurityPosturePage.tsx',
    pattern: /Compliance & Red Team Dashboard|continuous red team testing/i,
    reason:
      'the UI reports posture snapshots and configured signals, not compliance certification or continuous coverage',
  },
  {
    file: 'deploy/helm/commander/Chart.yaml',
    pattern: /production-grade/i,
    reason: 'package metadata must not imply production readiness without deployment evidence',
  },
  {
    file: 'packages/core/src/security/complianceAuditReport.ts',
    pattern: /enterprise-ready audit documentation|last mile of enterprise trust/i,
    reason:
      'the report is self-assessed control coverage and cannot imply certification or independent audit',
  },
  {
    file: 'apps/api/src/securityPostureEndpoints.ts',
    pattern: /full compliance report/i,
    reason: 'the endpoint exposes a self-assessed posture report, not a compliance certification',
  },
  {
    file: 'packages/core/src/security/runComplianceAudit.ts',
    pattern: /enterprise compliance|full compliance audit report/i,
    reason: 'the CLI generates self-assessed control coverage and cannot imply certification',
  },
  {
    file: 'packages/python-sdk/README.md',
    pattern: /Latest compliance report/i,
    reason:
      'SDK documentation must identify posture output as self-assessed rather than certified compliance',
  },
  {
    file: 'ENTERPRISE_READINESS.md',
    pattern: /enterprise-grade status reporting/i,
    reason:
      'readiness status is an internal contract and must not imply an enterprise certification',
  },
  {
    file: 'benchmark-report-2026-07-13/benchmark-report-2026-07-13.html',
    pattern:
      /真实(?: StepFun API|环境)|真实 API 验证通过|所有 4 个真实场景|全场景攻击成功率归零|12 passed \/ 0 failed/i,
    reason:
      'archival benchmark pages must scope provider, environment, and readiness results to the declared harness snapshot',
  },
  {
    file: 'commander-benchmark-report/commander-benchmark-report.html',
    pattern: /外部安全 benchmark[^。\n]*(?:达到|均达到)\s*100% 拦截|通过率\s*55\.7%|全拦截/i,
    reason:
      'archival benchmark pages must qualify sample interception counts and omit unsupported historical chaos scores',
  },
  {
    file: 'observability-reversibility-benchmark/observability-reversibility-benchmark.html',
    pattern:
      /行业第一对标|距离行业第一|领先行业第一|远超 Langfuse|满足 EU AI Act|防篡改|无等效机制/i,
    reason:
      'code-review comparisons must be labelled as reference estimates and tamper claims must remain tamper-evident/in-process',
  },
  {
    file: 'external-benchmark-research/external-benchmark-research.html',
    pattern: /4 个外部安全 benchmark 均达到 100% 拦截|所有信息均来自.*避免使用未经验证的数据/i,
    reason:
      'benchmark research must separate sourced benchmark facts from unverified Commander-specific historical results',
  },
  {
    file: 'packages/core/src/runtime/modelRouter.ts',
    pattern: /Covers 95% of use cases|SOC2\/compliance requirements with managed services/i,
    reason:
      'provider tier metadata must describe configuration options, not unsupported coverage or compliance guarantees',
  },
  {
    file: 'packages/core/src/tools/requestToolTool.ts',
    pattern: /95% reduction/i,
    reason:
      'research figures must be identified as external findings, not Commander performance results',
  },
  {
    file: 'packages/core/src/runtime/toolRetriever.ts',
    pattern: /95% reduction|32% improvement|70% cost reduction/i,
    reason:
      'research figures must be identified as external findings, not Commander performance guarantees',
  },
  {
    file: 'packages/core/src/harness/defaultHarness.ts',
    pattern: /100% backward compatible/i,
    reason: 'compatibility intent must not be presented as an unqualified universal guarantee',
  },
  {
    file: 'packages/core/src/harness/codeAgentHarness.ts',
    pattern: /100% compatible/i,
    reason: 'compatibility intent must not be presented as an unqualified universal guarantee',
  },
  {
    file: 'packages/python-sdk/src/commander/_client.py',
    pattern: /full compliance report/i,
    reason: 'SDK posture output is self-assessed control coverage, not a compliance certification',
  },
  {
    file: 'packages/python-sdk/src/commander/_types.py',
    pattern: /Full compliance report/i,
    reason: 'SDK posture output is self-assessed control coverage, not a compliance certification',
  },
  {
    file: 'apps/web/src/api.ts',
    pattern: /real compliance report/i,
    reason:
      'web API posture output is self-assessed control coverage, not a compliance certification',
  },
  {
    file: 'apps/web/src/pages/SecurityPosturePage.tsx',
    pattern: /Generates ATLAS Navigator heatmaps \+ compliance reports/i,
    reason:
      'posture UI must label mapping output as control coverage, not compliance certification',
  },
  {
    file: 'packages/core/src/security/complianceAuditReport.ts',
    pattern:
      /name: 'EU AI Act Compliance Reporter'|Automated Article 12\/13\/14 compliance reports with HMAC signing/i,
    reason:
      'report catalog must identify a self-assessment scaffold rather than certified compliance',
  },
];

const DEFAULT_FILES = [...new Set(RULES.map((rule) => rule.file))];

export function scanPublicClaims(root: string, options: ScanOptions = {}): ClaimViolation[] {
  const files = options.files ?? DEFAULT_FILES;
  const violations: ClaimViolation[] = [];

  for (const file of files) {
    const contents = options.contents?.[file] ?? readFileSync(join(root, file), 'utf8');
    const lines = contents.split('\n');
    for (const rule of RULES.filter((candidate) => candidate.file === file)) {
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const match = line.match(rule.pattern);
        if (!match) continue;
        violations.push({
          file,
          line: index + 1,
          match: match[0],
          reason: rule.reason,
        });
      }
    }
  }

  return violations;
}

function main(): void {
  const violations = scanPublicClaims(process.cwd());
  if (violations.length === 0) {
    console.log('Claim honesty gate: PASS');
    return;
  }
  for (const violation of violations) {
    console.error(
      `FAIL ${violation.file}:${violation.line} ${violation.match} — ${violation.reason}`,
    );
  }
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith('claim-honesty-gate.ts')) main();
