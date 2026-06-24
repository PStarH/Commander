import type {
  ComplianceAuditReport,
  SecurityPosture,
  DimensionScore,
  IsoClause,
  IsoCoverageEntry,
  IsoComplianceSummary,
  NistRmfAlignmentSummary,
  TrendAnalysis,
  AuditChecklistItem,
} from '../types';

const ISO_CLAUSE_DESC: Record<string, string> = {
  '6.1': 'Actions to address risks and opportunities',
  '6.2': 'AI objectives and planning to achieve them',
  '7.1': 'Resources for the AI management system',
  '7.2': 'Competence of persons doing AI work',
  '7.3': 'Awareness of the AI management system',
  '7.4': 'Communication relevant to the AI management system',
  '7.5': 'Documented information',
  '8.1': 'Operational planning and control',
  '8.2': 'AI system design and development controls',
  '8.3': 'AI system deployment and operational controls',
  '9.1': 'Monitoring, measurement, analysis and evaluation',
  '9.2': 'Internal audit',
  '9.3': 'Management review',
  '10.1': 'Nonconformity and corrective action',
  '10.2': 'Continual improvement',
};

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/**
 * Generate a realistic mock compliance audit report.
 * Scores trend upward over 14 snapshots (improving posture).
 */
export function generateMockReport(): ComplianceAuditReport {
  const now = new Date().toISOString();

  // Build 14 days of snapshots with improving scores
  const history = Array.from({ length: 14 }, (_, i) => {
    const baseScore = 76 + Math.round((i / 13) * 10);
    const timestamp = daysAgo(13 - i);
    const posture = buildPosture(baseScore, timestamp);
    return {
      id: `POSTURE-${1700000000000 + i * 86400000}`,
      timestamp,
      posture,
      trigger: i % 7 === 0 ? ('scheduled' as const) : ('ci_cd' as const),
    };
  });

  const currentPosture = history[history.length - 1].posture;

  const isoCoverage = buildIsoCoverage();
  const nistAlignment = buildNistAlignment();
  const trend: TrendAnalysis = {
    snapshotCount: history.length,
    scoreDelta: currentPosture.overallScore - history[0].posture.overallScore,
    scoreDeltaRecent:
      currentPosture.overallScore - history[history.length - 6].posture.overallScore,
    trend: 'improving',
    averageScore: Math.round(
      history.reduce((s, h) => s + h.posture.overallScore, 0) / history.length,
    ),
    minScore: history[0].posture.overallScore,
    maxScore: currentPosture.overallScore,
    volatility: 3,
    projectedScore: Math.min(100, currentPosture.overallScore + 2),
  };

  return {
    metadata: {
      reportId: `AUDIT-${Date.now()}-a1b2c3d4`,
      generatedAt: now,
      version: 1,
      commitHash: 'a3f8c21',
      branch: 'main',
    },
    posture: currentPosture,
    postureHistory: history,
    isoCompliance: isoCoverage,
    nistRmfAlignment: nistAlignment,
    trendAnalysis: trend,
    auditChecklist: buildChecklist(),
    redTeam: {
      securityScore: 89,
      totalScenarios: 44,
      blocked: 36,
      detected: 5,
      missed: 1,
      errors: 2,
      mode: 'full',
      regressions: 0,
      passed: true,
    },
    signature: 'a1b2c3d4e5f6...',
  };
}

function buildPosture(overallScore: number, timestamp: string): SecurityPosture {
  const dims: DimensionScore[] = [
    {
      dimension: 'input_security',
      label: 'Input Security',
      weight: 0.2,
      score: Math.min(100, overallScore - 2 + Math.round(Math.random() * 6)),
      controls: [
        {
          id: 'CTL-001',
          name: 'Content Scanning',
          description: 'Prompt injection detection (5-language)',
          isoClauses: ['8.2', '8.3'],
          nistSubcategories: ['MEASURE-2.1', 'MEASURE-2.2'],
          effectivenessScore: 85,
          automated: true,
        },
        {
          id: 'CTL-002',
          name: 'Tool Output Scanning',
          description: 'Injection check on tool results',
          isoClauses: ['8.2', '8.3'],
          nistSubcategories: ['MEASURE-2.2'],
          effectivenessScore: 80,
          automated: true,
        },
        {
          id: 'CTL-003',
          name: 'Privacy Router',
          description: 'Sensitive data detection + local model fallback',
          isoClauses: ['8.1', '8.3'],
          nistSubcategories: ['MAP-3.1', 'MEASURE-2.3'],
          effectivenessScore: 82,
          automated: true,
        },
        {
          id: 'CTL-021',
          name: 'ML Injection Detector',
          description: 'Embedding-based semantic injection detection (64-dim char n-gram)',
          isoClauses: ['8.2', '8.3'],
          nistSubcategories: ['MEASURE-2.1', 'MEASURE-2.2'],
          effectivenessScore: 75,
          automated: true,
        },
        {
          id: 'CTL-022',
          name: 'Multimodal Scanner',
          description: 'Image/video/audio threat scanning (15 file types)',
          isoClauses: ['8.2', '8.3'],
          nistSubcategories: ['MEASURE-2.1', 'MANAGE-2.1'],
          effectivenessScore: 72,
          automated: true,
        },
        {
          id: 'CTL-029',
          name: 'Voice Content Scanner',
          description: 'Voice command injection + DTMF/spectrogram/LSB stego detection',
          isoClauses: ['8.2', '8.3'],
          nistSubcategories: ['MEASURE-2.1', 'MEASURE-2.2'],
          effectivenessScore: 74,
          automated: true,
        },
      ],
      isoClausesCovered: ['8.1', '8.2', '8.3'],
      nistSubcategoriesCovered: [
        'MEASURE-2.1',
        'MEASURE-2.2',
        'MEASURE-2.3',
        'MAP-3.1',
        'MANAGE-2.1',
      ],
      status: 'excellent',
      recommendations: ['Fine-tune n-gram thresholds for higher precision'],
    },
    {
      dimension: 'tool_safety',
      label: 'Tool Safety',
      weight: 0.2,
      score: Math.min(100, overallScore + Math.round(Math.random() * 4)),
      controls: [
        {
          id: 'CTL-004',
          name: 'Sandbox Manager',
          description: 'OS-level isolation (Seatbelt/Bubblewrap/Docker)',
          isoClauses: ['8.1', '8.3'],
          nistSubcategories: ['MANAGE-2.1'],
          effectivenessScore: 90,
          automated: true,
        },
        {
          id: 'CTL-005',
          name: 'Tool Approval',
          description: '5-mode approval system',
          isoClauses: ['8.1', '8.2'],
          nistSubcategories: ['GOVERN-3.1'],
          effectivenessScore: 85,
          automated: true,
        },
        {
          id: 'CTL-006',
          name: 'Path Security',
          description: 'Path traversal prevention',
          isoClauses: ['8.3'],
          nistSubcategories: ['MANAGE-2.1'],
          effectivenessScore: 88,
          automated: true,
        },
        {
          id: 'CTL-023',
          name: 'Seccomp BPF',
          description: 'Linux syscall filtering via BPF bytecode',
          isoClauses: ['8.1', '8.3'],
          nistSubcategories: ['MANAGE-2.1'],
          effectivenessScore: 88,
          automated: true,
        },
        {
          id: 'CTL-030',
          name: 'AppContainer Sandbox',
          description: 'Windows AppContainer isolation (PowerShell profiles, capability SIDs)',
          isoClauses: ['8.1', '8.3'],
          nistSubcategories: ['MANAGE-2.1'],
          effectivenessScore: 82,
          automated: true,
        },
      ],
      isoClausesCovered: ['8.1', '8.2', '8.3'],
      nistSubcategoriesCovered: ['MANAGE-2.1', 'GOVERN-3.1'],
      status: 'excellent',
      recommendations: [],
    },
    {
      dimension: 'runtime_defense',
      label: 'Runtime Defense',
      weight: 0.2,
      score: Math.min(100, overallScore - 3 + Math.round(Math.random() * 5)),
      controls: [
        {
          id: 'CTL-007',
          name: 'Guardian Agent',
          description: 'Single-agent behavioral anomaly detection',
          isoClauses: ['9.1', '9.2'],
          nistSubcategories: ['MEASURE-2.1'],
          effectivenessScore: 82,
          automated: true,
        },
        {
          id: 'CTL-008',
          name: 'Security Monitor',
          description: 'Continuous event monitoring + alerting',
          isoClauses: ['9.1', '9.2'],
          nistSubcategories: ['MEASURE-2.4'],
          effectivenessScore: 80,
          automated: true,
        },
        {
          id: 'CTL-009',
          name: 'Circuit Breaker',
          description: 'Provider failure protection (5 failures → 30s open)',
          isoClauses: ['8.1', '9.1'],
          nistSubcategories: ['MANAGE-2.2', 'MEASURE-2.1'],
          effectivenessScore: 85,
          automated: true,
        },
        {
          id: 'CTL-024',
          name: 'Cross-Agent Correlator',
          description: 'Multi-agent attack chain detection (6 rules)',
          isoClauses: ['9.1', '9.2'],
          nistSubcategories: ['MEASURE-2.1', 'MEASURE-2.4'],
          effectivenessScore: 78,
          automated: true,
        },
      ],
      isoClausesCovered: ['8.1', '9.1', '9.2'],
      nistSubcategoriesCovered: ['MEASURE-2.1', 'MEASURE-2.4', 'MANAGE-2.2'],
      status: 'excellent',
      recommendations: [],
    },
    {
      dimension: 'supply_chain',
      label: 'Supply Chain',
      weight: 0.15,
      score: Math.min(100, overallScore - 4 + Math.round(Math.random() * 6)),
      controls: [
        {
          id: 'CTL-010',
          name: 'Supply Chain Scanner',
          description: 'Malware signature detection (8 static sigs)',
          isoClauses: ['8.2', '8.3'],
          nistSubcategories: ['MAP-3.1', 'MEASURE-2.3'],
          effectivenessScore: 78,
          automated: true,
        },
        {
          id: 'CTL-011',
          name: 'Agent Lineage',
          description: 'Immutable parent-child tracking',
          isoClauses: ['8.1', '9.1'],
          nistSubcategories: ['GOVERN-3.1', 'MAP-2.2'],
          effectivenessScore: 85,
          automated: true,
        },
        {
          id: 'CTL-012',
          name: 'Capability Token',
          description: 'HMAC-signed authorization',
          isoClauses: ['8.1', '8.3'],
          nistSubcategories: ['GOVERN-3.1'],
          effectivenessScore: 88,
          automated: true,
        },
        {
          id: 'CTL-025',
          name: 'Threat Intel Feed',
          description: 'Dynamic threat feed (TLP 4-level, 8 emerging sigs)',
          isoClauses: ['8.2', '8.3'],
          nistSubcategories: ['MAP-3.1', 'MEASURE-2.3'],
          effectivenessScore: 76,
          automated: true,
        },
      ],
      isoClausesCovered: ['8.1', '8.2', '8.3', '9.1'],
      nistSubcategoriesCovered: ['MAP-3.1', 'MEASURE-2.3', 'GOVERN-3.1', 'MAP-2.2'],
      status: 'good',
      recommendations: ['Integrate external threat intelligence sources'],
    },
    {
      dimension: 'economic_defense',
      label: 'Economic Defense',
      weight: 0.1,
      score: Math.min(100, overallScore + 1 + Math.round(Math.random() * 3)),
      controls: [
        {
          id: 'CTL-013',
          name: 'CostGuard',
          description: 'Economic attack detection',
          isoClauses: ['8.1', '9.1'],
          nistSubcategories: ['MEASURE-2.1', 'MANAGE-2.2'],
          effectivenessScore: 85,
          automated: true,
        },
        {
          id: 'CTL-014',
          name: 'Token Governor',
          description: 'Budget enforcement',
          isoClauses: ['8.1', '9.1'],
          nistSubcategories: ['MEASURE-2.1'],
          effectivenessScore: 82,
          automated: true,
        },
      ],
      isoClausesCovered: ['8.1', '9.1'],
      nistSubcategoriesCovered: ['MEASURE-2.1', 'MANAGE-2.2'],
      status: 'good',
      recommendations: [],
    },
    {
      dimension: 'operational_readiness',
      label: 'Operational Readiness',
      weight: 0.1,
      score: Math.min(100, overallScore - 1 + Math.round(Math.random() * 4)),
      controls: [
        {
          id: 'CTL-015',
          name: 'AgentSOC',
          description: 'Incident response operations',
          isoClauses: ['9.1', '9.2', '10.1'],
          nistSubcategories: ['MANAGE-3.1', 'MANAGE-4.1'],
          effectivenessScore: 80,
          automated: true,
        },
        {
          id: 'CTL-016',
          name: 'Standby Manager',
          description: 'Hot standby failover',
          isoClauses: ['8.1', '8.3'],
          nistSubcategories: ['MANAGE-2.2'],
          effectivenessScore: 82,
          automated: true,
        },
        {
          id: 'CTL-017',
          name: 'AuditChainLedger',
          description: 'Tamper-evident audit trail',
          isoClauses: ['7.5', '9.1', '9.2'],
          nistSubcategories: ['GOVERN-5.1', 'MEASURE-3.1'],
          effectivenessScore: 90,
          automated: true,
        },
        {
          id: 'CTL-018',
          name: 'Red Team Framework',
          description: 'Adversarial testing',
          isoClauses: ['9.1', '9.2', '10.2'],
          nistSubcategories: ['MEASURE-2.4', 'MANAGE-4.1'],
          effectivenessScore: 85,
          automated: true,
        },
        {
          id: 'CTL-019',
          name: 'Red Team Baseline',
          description: 'Regression detection',
          isoClauses: ['9.1', '9.2', '10.2'],
          nistSubcategories: ['MEASURE-3.1', 'MEASURE-3.2'],
          effectivenessScore: 83,
          automated: true,
        },
        {
          id: 'CTL-020',
          name: 'EU AI Act Reporter',
          description: 'Automated compliance reports',
          isoClauses: ['7.5', '9.2', '9.3'],
          nistSubcategories: ['GOVERN-1.1', 'GOVERN-5.1'],
          effectivenessScore: 78,
          automated: true,
        },
        {
          id: 'CTL-031',
          name: 'Sandbox Verifier',
          description: 'Formal sandbox verification (7 tests: file/network/process isolation)',
          isoClauses: ['9.1', '9.2', '10.2'],
          nistSubcategories: ['MEASURE-2.4', 'MEASURE-3.1'],
          effectivenessScore: 80,
          automated: true,
        },
      ],
      isoClausesCovered: ['7.5', '8.1', '8.3', '9.1', '9.2', '9.3', '10.1', '10.2'],
      nistSubcategoriesCovered: [
        'MANAGE-3.1',
        'MANAGE-4.1',
        'MANAGE-2.2',
        'GOVERN-5.1',
        'MEASURE-3.1',
        'MEASURE-2.4',
        'MEASURE-3.2',
        'GOVERN-1.1',
      ],
      status: 'good',
      recommendations: ['Conduct quarterly incident response drills'],
    },
    {
      dimension: 'crypto_defense',
      label: 'Crypto Defense',
      weight: 0.05,
      score: Math.min(100, overallScore + 8 + Math.round(Math.random() * 4)),
      controls: [
        {
          id: 'CTL-026',
          name: 'Post-Quantum Crypto',
          description: 'PQ-safe hash (SHA-512 double-hash) + HMAC MAC (512-bit keys)',
          isoClauses: ['8.1', '8.3'],
          nistSubcategories: ['GOVERN-3.1', 'MANAGE-2.1'],
          effectivenessScore: 82,
          automated: true,
        },
        {
          id: 'CTL-027',
          name: 'Federated Identity',
          description: 'Cross-org trust delegation (HMAC+OIDC JWT)',
          isoClauses: ['8.1', '8.3'],
          nistSubcategories: ['GOVERN-3.1'],
          effectivenessScore: 85,
          automated: true,
        },
      ],
      isoClausesCovered: ['8.1', '8.3'],
      nistSubcategoriesCovered: ['GOVERN-3.1', 'MANAGE-2.1'],
      status: 'excellent',
      recommendations: ['Upgrade to ML-KEM-768 when Node.js ships native support'],
    },
    {
      dimension: 'fuzz_testing',
      label: 'Fuzz Testing',
      weight: 0.05,
      score: Math.min(100, overallScore + 5 + Math.round(Math.random() * 3)),
      controls: [
        {
          id: 'CTL-028',
          name: 'Fuzz Test Framework',
          description: 'Mutation-based tool input fuzzer (6 strategies, coverage-guided)',
          isoClauses: ['9.1', '9.2'],
          nistSubcategories: ['MEASURE-2.4', 'MEASURE-3.1'],
          effectivenessScore: 80,
          automated: true,
        },
      ],
      isoClausesCovered: ['9.1', '9.2'],
      nistSubcategoriesCovered: ['MEASURE-2.4', 'MEASURE-3.1'],
      status: 'good',
      recommendations: ['Run fuzz testing as part of CI/CD pre-merge'],
    },
  ];

  const grade = scoreToGrade(overallScore);

  return {
    calculatedAt: timestamp,
    overallScore,
    grade,
    dimensions: dims,
    status: overallScore >= 80 ? 'good' : overallScore >= 65 ? 'adequate' : 'needs_improvement',
    topRisks: dims
      .slice()
      .sort((a, b) => a.score - b.score)
      .slice(0, 2)
      .map((d) => `${d.label}: ${d.score}/100`),
    topStrengths: dims
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((d) => `${d.label}: ${d.score}/100`),
  };
}

function scoreToGrade(score: number): string {
  if (score >= 95) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 85) return 'B+';
  if (score >= 80) return 'B';
  if (score >= 75) return 'C+';
  if (score >= 70) return 'C';
  return 'D';
}

function buildIsoCoverage(): IsoComplianceSummary {
  const allClauses: IsoClause[] = [
    '6.1',
    '6.2',
    '7.1',
    '7.2',
    '7.3',
    '7.4',
    '7.5',
    '8.1',
    '8.2',
    '8.3',
    '9.1',
    '9.2',
    '9.3',
    '10.1',
    '10.2',
  ];
  const coverage: Record<string, IsoCoverageEntry> = {};
  const covered = [
    '6.1',
    '6.2',
    '7.1',
    '7.2',
    '7.3',
    '7.4',
    '7.5',
    '8.1',
    '8.2',
    '8.3',
    '9.1',
    '9.2',
    '10.1',
    '10.2',
  ];
  const uncovered = allClauses.filter((c) => !covered.includes(c));

  for (const c of covered) {
    coverage[c] = { covered: true, controls: ['CTL-001'], score: 85 };
  }
  for (const c of uncovered) {
    coverage[c] = { covered: false, controls: [], score: 0 };
  }

  return {
    fullyCompliant: uncovered.length === 0,
    clauseCoverage: coverage as Record<IsoClause, IsoCoverageEntry>,
    gaps: uncovered.map((c) => ({
      clause: c as IsoClause,
      description: ISO_CLAUSE_DESC[c] || c,
      severity: c.startsWith('9') ? ('critical' as const) : ('medium' as const),
      recommendation: `Implement controls for clause ${c}.`,
    })),
    compliancePercentage: Math.round((covered.length / allClauses.length) * 100),
  };
}

function buildNistAlignment(): NistRmfAlignmentSummary {
  return {
    functionCoverage: {
      GOVERN: {
        coveredSubcategories: 6,
        totalSubcategories: 8,
        coveragePercentage: 75,
        controls: ['CTL-005', 'CTL-011', 'CTL-012', 'CTL-017', 'CTL-020'],
      },
      MAP: {
        coveredSubcategories: 5,
        totalSubcategories: 7,
        coveragePercentage: 71,
        controls: ['CTL-003', 'CTL-010', 'CTL-011'],
      },
      MEASURE: {
        coveredSubcategories: 8,
        totalSubcategories: 8,
        coveragePercentage: 100,
        controls: [
          'CTL-001',
          'CTL-002',
          'CTL-007',
          'CTL-008',
          'CTL-013',
          'CTL-014',
          'CTL-018',
          'CTL-019',
        ],
      },
      MANAGE: {
        coveredSubcategories: 6,
        totalSubcategories: 8,
        coveragePercentage: 75,
        controls: ['CTL-004', 'CTL-006', 'CTL-009', 'CTL-015', 'CTL-016'],
      },
    },
    gaps: [
      {
        subcategory: 'GOVERN-1.2',
        description: 'AI risk tolerance not documented',
        severity: 'high',
        recommendation: 'Document organizational AI risk tolerance.',
      },
      {
        subcategory: 'GOVERN-5.2',
        description: 'AI accountability structure not formalized',
        severity: 'medium',
        recommendation: 'Formalize AI accountability roles.',
      },
      {
        subcategory: 'MAP-1.2',
        description: 'AI system context mapping incomplete',
        severity: 'medium',
        recommendation: 'Complete system context documentation.',
      },
      {
        subcategory: 'MANAGE-4.3',
        description: 'AI incident recovery procedures not tested',
        severity: 'high',
        recommendation: 'Conduct recovery procedure drills.',
      },
    ],
    alignmentPercentage: 80,
  };
}

function buildChecklist(): AuditChecklistItem[] {
  return [
    {
      id: 'ACK-01',
      category: 'Documentation',
      item: 'AI management system policy',
      status: 'passed',
      evidence: 'AGENTS.md + Security module docs',
    },
    {
      id: 'ACK-02',
      category: 'Documentation',
      item: 'Risk assessment methodology',
      status: 'passed',
      evidence: 'RedTeamFramework 44-scenario battery',
    },
    {
      id: 'ACK-03',
      category: 'Controls',
      item: 'Input filtering and content scanning',
      status: 'passed',
    },
    { id: 'ACK-04', category: 'Controls', item: 'Output sanitization', status: 'passed' },
    {
      id: 'ACK-05',
      category: 'Controls',
      item: 'AI system monitoring and anomaly detection',
      status: 'passed',
    },
    {
      id: 'ACK-06',
      category: 'Controls',
      item: 'Access control and authorization',
      status: 'passed',
    },
    {
      id: 'ACK-07',
      category: 'Controls',
      item: 'Audit trail with tamper evidence',
      status: 'passed',
    },
    { id: 'ACK-08', category: 'Controls', item: 'Incident response procedures', status: 'passed' },
    {
      id: 'ACK-09',
      category: 'Controls',
      item: 'Disaster recovery / business continuity',
      status: 'passed',
    },
    { id: 'ACK-10', category: 'Testing', item: 'Regular adversarial testing', status: 'passed' },
    {
      id: 'ACK-11',
      category: 'Testing',
      item: 'Regression testing for security controls',
      status: 'passed',
    },
    {
      id: 'ACK-12',
      category: 'Compliance',
      item: 'EU AI Act compliance reporting',
      status: 'passed',
    },
    {
      id: 'ACK-13',
      category: 'Compliance',
      item: 'Third-party security audit',
      status: 'pending',
      notes: 'Schedule external auditor.',
    },
    {
      id: 'ACK-14',
      category: 'Documentation',
      item: 'Model cards for AI systems',
      status: 'pending',
      notes: 'Document model versions and capabilities.',
    },
    {
      id: 'ACK-15',
      category: 'Documentation',
      item: 'Data protection impact assessment (DPIA)',
      status: 'pending',
      notes: 'Required under GDPR Article 35.',
    },
    {
      id: 'ACK-16',
      category: 'Testing',
      item: 'Fuzz testing in CI/CD pipeline',
      status: 'passed',
      evidence: 'FuzzTestFramework — 6 strategies, coverage-guided',
    },
    {
      id: 'ACK-17',
      category: 'Controls',
      item: 'Post-quantum cryptographic readiness',
      status: 'passed',
      evidence: 'SHA-512 double-hash, 512-bit HMAC keys',
    },
    {
      id: 'ACK-18',
      category: 'Controls',
      item: 'Multi-agent attack chain detection',
      status: 'passed',
      evidence: 'CrossAgentCorrelator — 6 correlation rules',
    },
    {
      id: 'ACK-19',
      category: 'Controls',
      item: 'Dynamic threat intelligence feed',
      status: 'passed',
      evidence: 'ThreatIntelFeed — TLP 4-level, 8 emerging sigs',
    },
    {
      id: 'ACK-20',
      category: 'Controls',
      item: 'Semantic injection detection (ML)',
      status: 'passed',
      evidence: 'MLInjectionDetector — 64-dim char n-gram + k-NN',
    },
    {
      id: 'ACK-21',
      category: 'Controls',
      item: 'Multimodal content scanning',
      status: 'passed',
      evidence: 'MultimodalScanner — 15 file types, SVG/GIFAR/PDF detection',
    },
    {
      id: 'ACK-22',
      category: 'Controls',
      item: 'SIEM/SOC external log forwarding',
      status: 'passed',
      evidence: 'SIEMForwarder — Syslog/Splunk/Datadog',
    },
    {
      id: 'ACK-23',
      category: 'Controls',
      item: 'Voice command injection detection',
      status: 'passed',
      evidence: 'VoiceContentScanner — DTMF/spectrogram/LSB stego',
    },
    {
      id: 'ACK-24',
      category: 'Controls',
      item: 'Windows sandbox isolation (AppContainer)',
      status: 'passed',
      evidence: 'AppContainerSandbox — PowerShell profiles + capability SIDs',
    },
    {
      id: 'ACK-25',
      category: 'Testing',
      item: 'Formal sandbox verification testing',
      status: 'passed',
      evidence: 'SandboxVerifier — 7 cross-platform isolation tests',
    },
  ];
}

export { ISO_CLAUSE_DESC };
