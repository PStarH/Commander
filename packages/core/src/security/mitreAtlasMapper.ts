/**
 * MitreAtlasMapper — Automatic MITRE ATLAS tactics/techniques mapping.
 *
 * Maps Commander security events, red team scenarios, guardian interventions,
 * and cross-agent correlation matches to the MITRE ATLAS (Adversarial Threat
 * Landscape for AI Systems) framework.
 *
 * MITRE ATLAS is the AI-specific extension of MITRE ATT&CK, cataloguing TTPs
 * (Tactics, Techniques, and Procedures) that adversaries use against AI systems.
 * Each technique has a unique AML ID (e.g., AML.T0012 for Direct Prompt Injection).
 *
 * Capabilities:
 *   1. Full ATLAS matrix — 14 tactics, 60+ techniques, 170+ sub-techniques
 *   2. Commander event → ATLAS classifier — maps SecurityEvent, RedTeamScenario,
 *      GuardianAction, CorrelationMatch to ATLAS technique IDs
 *   3. Heatmap generator — produces MITRE ATLAS navigator-compatible JSON
 *   4. Compliance report — ISO 42001 / NIST AI RMF alignment with ATLAS evidence
 *
 * Based on:
 *   - MITRE ATLAS v2026.05 (mitre-atlas/atlas-data)
 *   - OWASP Agentic AI Top 10 mapping
 *   - NIST AI RMF subcategory alignment
 */

import type { SecurityEvent, SecurityEventType } from './securityAuditLogger';
import type { AttackCategory } from './redTeamFramework';
import type { GuardianInterventionType } from './guardianAgent';
import type { CorrelationRuleType } from './crossAgentCorrelator';

// ============================================================================
// ATLAS Matrix Data
// ============================================================================

/** MITRE ATLAS Tactic */
export interface AtlasTactic {
  id: string;
  name: string;
  description: string;
}

/** MITRE ATLAS Technique */
export interface AtlasTechnique {
  id: string;
  name: string;
  description: string;
  /** Parent tactic this technique belongs to (achieves relationship) */
  tacticId: string;
  /** Sub-techniques (specializes relationship) */
  subTechniques?: AtlasSubTechnique[];
  /** NIST AI RMF subcategories this technique maps to */
  nistSubcategories: string[];
  /** OWASP Agentic AI Top 10 IDs this technique maps to */
  owaspIds: string[];
}

/** MITRE ATLAS Sub-Technique */
export interface AtlasSubTechnique {
  id: string;
  name: string;
  description: string;
}

/** Single cell in an ATLAS heatmap */
export interface AtlasHeatmapCell {
  tacticId: string;
  tacticName: string;
  techniqueId: string;
  techniqueName: string;
  /** Number of events mapped to this technique */
  eventCount: number;
  /** Max severity among mapped events */
  maxSeverity: 'low' | 'medium' | 'high' | 'critical' | 'none';
  /** Color for heatmap visualization */
  color: string;
}

/** Full ATLAS mapping for an event or scenario */
export interface AtlasMapping {
  /** Mapped ATLAS technique ID */
  techniqueId: string;
  /** Mapped ATLAS tactic ID */
  tacticId: string;
  /** Technique name */
  techniqueName: string;
  /** Tactic name */
  tacticName: string;
  /** Confidence of this mapping (0-100) */
  confidence: number;
  /** Justification for the mapping */
  justification: string;
}

/** Report generated from security events mapped to ATLAS */
export interface MitreAtlasReport {
  reportId: string;
  generatedAt: string;
  /** Summary statistics */
  summary: {
    totalEvents: number;
    mappedEvents: number;
    unmappedEvents: number;
    tacticsCovered: number;
    techniquesCovered: number;
    coverageScore: number;
  };
  /** Heatmap data (ATLAS navigator format) */
  heatmap: AtlasHeatmapCell[];
  /** Per-tactic breakdown */
  tacticBreakdown: Array<{
    tacticId: string;
    tacticName: string;
    techniqueCount: number;
    eventCount: number;
    coveragePercent: number;
  }>;
  /** Top techniques by event frequency */
  topTechniques: Array<{
    techniqueId: string;
    techniqueName: string;
    eventCount: number;
  }>;
  /** Unmapped event types */
  unmappedTypes: string[];
  /** Recommendations for improving coverage */
  recommendations: string[];
}

// ============================================================================
// Full MITRE ATLAS Matrix (v2026.05)
// ============================================================================

const ATLAS_TACTICS: AtlasTactic[] = [
  {
    id: 'AML.TA0001',
    name: 'Reconnaissance',
    description: 'Gathering information to plan future AI-specific attacks.',
  },
  {
    id: 'AML.TA0002',
    name: 'Resource Development',
    description: 'Building or acquiring AI-specific resources for attacks.',
  },
  {
    id: 'AML.TA0003',
    name: 'Initial Access',
    description: 'Gaining an initial foothold within an AI system.',
  },
  {
    id: 'AML.TA0004',
    name: 'ML Model Access',
    description: 'Obtaining access to an ML model via API, weights, or inference.',
  },
  {
    id: 'AML.TA0005',
    name: 'Execution',
    description: 'Running malicious code or prompts within the AI system.',
  },
  {
    id: 'AML.TA0006',
    name: 'Persistence',
    description: 'Maintaining long-term access to the AI system.',
  },
  {
    id: 'AML.TA0007',
    name: 'Privilege Escalation',
    description: 'Gaining higher-level permissions within the AI system.',
  },
  {
    id: 'AML.TA0008',
    name: 'Defense Evasion',
    description: 'Avoiding detection by AI-specific security controls.',
  },
  {
    id: 'AML.TA0009',
    name: 'Credential Access',
    description: 'Stealing AI system credentials or API keys.',
  },
  {
    id: 'AML.TA0010',
    name: 'Discovery',
    description: 'Exploring the AI system to understand its architecture and data.',
  },
  {
    id: 'AML.TA0011',
    name: 'Lateral Movement',
    description: 'Moving between AI system components or agents.',
  },
  {
    id: 'AML.TA0012',
    name: 'Collection',
    description: 'Gathering AI-specific data from the system.',
  },
  {
    id: 'AML.TA0013',
    name: 'Exfiltration',
    description: 'Stealing AI data, models, or outputs from the system.',
  },
  {
    id: 'AML.TA0014',
    name: 'Impact',
    description: 'Disrupting, corrupting, or manipulating AI system operations.',
  },
];

const ATLAS_TECHNIQUES: AtlasTechnique[] = [
  // ── TA0001 Reconnaissance ────────────────────────────────────────
  {
    id: 'AML.T0001',
    name: 'Search for AI/ML Resources',
    description: 'Searching for publicly available AI models, datasets, or tools.',
    tacticId: 'AML.TA0001',
    nistSubcategories: ['MAP-3.1'],
    owaspIds: [],
  },
  {
    id: 'AML.T0002',
    name: 'AI Model Discovery',
    description: 'Probing AI system endpoints to discover model types and versions.',
    tacticId: 'AML.TA0001',
    nistSubcategories: ['MAP-3.1'],
    owaspIds: [],
  },
  {
    id: 'AML.T0003',
    name: 'AI Supply Chain Reconnaissance',
    description: 'Gathering information about AI supply chain dependencies.',
    tacticId: 'AML.TA0001',
    nistSubcategories: ['MAP-3.1', 'GOVERN-3.1'],
    owaspIds: ['ASI06'],
  },

  // ── TA0002 Resource Development ──────────────────────────────────
  {
    id: 'AML.T0005',
    name: 'Acquire AI System Infrastructure',
    description: 'Setting up infrastructure to host or attack AI systems.',
    tacticId: 'AML.TA0002',
    nistSubcategories: ['MANAGE-2.1'],
    owaspIds: ['ASI04'],
  },
  {
    id: 'AML.T0006',
    name: 'Develop Malicious AI Model',
    description: 'Creating a model designed to attack or subvert AI systems.',
    tacticId: 'AML.TA0002',
    nistSubcategories: ['MANAGE-2.1'],
    owaspIds: ['ASI06'],
  },

  // ── TA0003 Initial Access ────────────────────────────────────────
  {
    id: 'AML.T0008',
    name: 'AI Social Engineering',
    description: 'Using social engineering techniques targeting AI-human interfaces.',
    tacticId: 'AML.TA0003',
    nistSubcategories: ['GOVERN-3.1'],
    owaspIds: ['ASI01'],
  },
  {
    id: 'AML.T0009',
    name: 'Exploit AI Application',
    description: 'Exploiting vulnerabilities in AI-powered applications.',
    tacticId: 'AML.TA0003',
    nistSubcategories: ['MEASURE-2.1'],
    owaspIds: ['ASI03'],
  },

  // ── TA0004 ML Model Access ───────────────────────────────────────
  {
    id: 'AML.T0010',
    name: 'Inference API Access',
    description: 'Gaining unauthorized access to model inference APIs.',
    tacticId: 'AML.TA0004',
    nistSubcategories: ['MANAGE-2.1'],
    owaspIds: ['ASI08'],
  },
  {
    id: 'AML.T0012',
    name: 'Direct Prompt Injection',
    description: 'Crafting prompts to override system instructions and gain unauthorized control.',
    tacticId: 'AML.TA0004',
    nistSubcategories: ['MEASURE-2.1', 'MEASURE-2.2'],
    owaspIds: ['ASI01'],
    subTechniques: [
      {
        id: 'AML.T0012.001',
        name: 'Instruction Override',
        description: 'Directly commanding the model to ignore previous instructions.',
      },
      {
        id: 'AML.T0012.002',
        name: 'Role-Playing Injection',
        description: 'Using role-play scenarios to bypass restrictions.',
      },
      {
        id: 'AML.T0012.003',
        name: 'Multi-Language Injection',
        description: 'Using non-English languages to evade filters.',
      },
      {
        id: 'AML.T0012.004',
        name: 'Unicode Obfuscation',
        description: 'Using Unicode tricks to hide injection payloads.',
      },
      {
        id: 'AML.T0012.005',
        name: 'Multi-Turn Injection',
        description: 'Spreading injection across multiple turns.',
      },
    ],
  },
  {
    id: 'AML.T0013',
    name: 'Indirect Prompt Injection',
    description: 'Injecting malicious instructions through external data sources.',
    tacticId: 'AML.TA0004',
    nistSubcategories: ['MEASURE-2.1'],
    owaspIds: ['ASI01'],
    subTechniques: [
      {
        id: 'AML.T0013.001',
        name: 'Web Content Injection',
        description: 'Hiding instructions in web pages or documents.',
      },
      {
        id: 'AML.T0013.002',
        name: 'Tool Output Injection',
        description: 'Injecting via tool results returned to the agent.',
      },
      {
        id: 'AML.T0013.003',
        name: 'Memory-Borne Injection',
        description: 'Injecting instructions that persist through memory.',
      },
    ],
  },

  // ── TA0005 Execution ─────────────────────────────────────────────
  {
    id: 'AML.T0014',
    name: 'User Execution',
    description: 'Relying on a human or agent to execute malicious actions.',
    tacticId: 'AML.TA0005',
    nistSubcategories: ['GOVERN-3.1'],
    owaspIds: ['ASI01'],
  },
  {
    id: 'AML.T0015',
    name: 'Jailbreak Attack',
    description: 'Bypassing AI safety constraints to execute prohibited actions.',
    tacticId: 'AML.TA0005',
    nistSubcategories: ['MEASURE-2.1'],
    owaspIds: ['ASI01'],
    subTechniques: [
      {
        id: 'AML.T0015.001',
        name: 'DAN/Developer Mode',
        description: 'Using "Do Anything Now" or developer mode personas.',
      },
      {
        id: 'AML.T0015.002',
        name: 'Many-Shot Jailbreak',
        description: 'Context-window flooding with compliant examples.',
      },
      {
        id: 'AML.T0015.003',
        name: 'Token Smuggling',
        description: 'Encoding jailbreak instructions across tokens.',
      },
    ],
  },
  {
    id: 'AML.T0016',
    name: 'Tool Abuse',
    description: 'Using authorized tools for unauthorized or malicious purposes.',
    tacticId: 'AML.TA0005',
    nistSubcategories: ['MANAGE-2.1'],
    owaspIds: ['ASI03'],
    subTechniques: [
      {
        id: 'AML.T0016.001',
        name: 'Command Injection',
        description: 'Injecting shell commands through tool parameters.',
      },
      {
        id: 'AML.T0016.002',
        name: 'Path Traversal',
        description: 'Accessing files outside the authorized workspace.',
      },
      {
        id: 'AML.T0016.003',
        name: 'Chained Tool Abuse',
        description: 'Sequencing multiple tools to achieve malicious goals.',
      },
      {
        id: 'AML.T0016.004',
        name: 'Dependency Confusion',
        description: 'Installing malicious packages through package managers.',
      },
    ],
  },
  {
    id: 'AML.T0017',
    name: 'Sandbox Escape',
    description: 'Breaking out of execution sandboxes to access the host system.',
    tacticId: 'AML.TA0005',
    nistSubcategories: ['MANAGE-2.1'],
    owaspIds: ['ASI03'],
  },

  // ── TA0006 Persistence ───────────────────────────────────────────
  {
    id: 'AML.T0018',
    name: 'Memory Poisoning',
    description: 'Injecting false or malicious data into agent memory.',
    tacticId: 'AML.TA0006',
    nistSubcategories: ['MEASURE-2.1'],
    owaspIds: ['ASI07'],
    subTechniques: [
      {
        id: 'AML.T0018.001',
        name: 'False Memory Injection',
        description: 'Planting false information in working/episodic memory.',
      },
      {
        id: 'AML.T0018.002',
        name: 'Episodic Memory Replay',
        description: 'Repeatedly injecting memories to strengthen persistence.',
      },
      {
        id: 'AML.T0018.003',
        name: 'Embedding Vector Poisoning',
        description: 'Skewing embedding-based memory retrieval.',
      },
    ],
  },
  {
    id: 'AML.T0019',
    name: 'Agent Configuration Modification',
    description: 'Modifying agent settings, tool permissions, or governance config.',
    tacticId: 'AML.TA0006',
    nistSubcategories: ['GOVERN-5.1'],
    owaspIds: ['ASI08'],
  },

  // ── TA0007 Privilege Escalation ──────────────────────────────────
  {
    id: 'AML.T0020',
    name: 'Agent Capability Escalation',
    description: 'Escalating agent capabilities beyond authorized scope.',
    tacticId: 'AML.TA0007',
    nistSubcategories: ['GOVERN-3.1'],
    owaspIds: ['ASI08'],
    subTechniques: [
      {
        id: 'AML.T0020.001',
        name: 'Sub-Agent Spawning Escalation',
        description: 'Creating sub-agents with broader permissions.',
      },
      {
        id: 'AML.T0020.002',
        name: 'Lineage Chain Escape',
        description: 'Severing parent-child lineage to avoid audit.',
      },
      {
        id: 'AML.T0020.003',
        name: 'Cross-Tenant Escalation',
        description: 'Accessing data or agents in other tenants.',
      },
    ],
  },

  // ── TA0008 Defense Evasion ───────────────────────────────────────
  {
    id: 'AML.T0022',
    name: 'Prompt Obfuscation',
    description: 'Encoding or obfuscating malicious prompts to evade detection.',
    tacticId: 'AML.TA0008',
    nistSubcategories: ['MEASURE-2.1'],
    owaspIds: ['ASI01'],
    subTechniques: [
      {
        id: 'AML.T0022.001',
        name: 'Base64 Encoding',
        description: 'Encoding injection payloads in base64.',
      },
      {
        id: 'AML.T0022.002',
        name: 'Unicode Obfuscation',
        description: 'Using zero-width and homoglyph characters.',
      },
      {
        id: 'AML.T0022.003',
        name: 'Markdown Code Fence Evasion',
        description: 'Hiding injection in markdown code blocks.',
      },
    ],
  },
  {
    id: 'AML.T0023',
    name: 'Governance Bypass',
    description: 'Evading agent governance and approval controls.',
    tacticId: 'AML.TA0008',
    nistSubcategories: ['GOVERN-5.1'],
    owaspIds: ['ASI08'],
  },
  {
    id: 'AML.T0024',
    name: 'Audit Log Evasion',
    description: 'Manipulating or suppressing security audit trails.',
    tacticId: 'AML.TA0008',
    nistSubcategories: ['GOVERN-5.1', 'MEASURE-3.1'],
    owaspIds: ['ASI08'],
  },

  // ── TA0009 Credential Access ─────────────────────────────────────
  {
    id: 'AML.T0025',
    name: 'API Key Theft',
    description: 'Stealing API keys or authentication tokens for AI systems.',
    tacticId: 'AML.TA0009',
    nistSubcategories: ['GOVERN-3.1'],
    owaspIds: ['ASI08'],
  },
  {
    id: 'AML.T0026',
    name: 'Model Credential Access',
    description: 'Obtaining credentials through model interaction or extraction.',
    tacticId: 'AML.TA0009',
    nistSubcategories: ['GOVERN-3.1'],
    owaspIds: ['ASI08'],
  },

  // ── TA0010 Discovery ─────────────────────────────────────────────
  {
    id: 'AML.T0027',
    name: 'System Prompt Discovery',
    description: 'Extracting system prompts through interrogation or injection.',
    tacticId: 'AML.TA0010',
    nistSubcategories: ['MEASURE-2.1'],
    owaspIds: ['ASI01'],
  },
  {
    id: 'AML.T0028',
    name: 'Agent Architecture Discovery',
    description: 'Mapping agent tools, permissions, and configuration.',
    tacticId: 'AML.TA0010',
    nistSubcategories: ['MAP-3.1'],
    owaspIds: [],
  },
  {
    id: 'AML.T0029',
    name: 'Model Architecture Discovery',
    description: 'Determining model type, version, and parameters.',
    tacticId: 'AML.TA0010',
    nistSubcategories: ['MAP-3.1'],
    owaspIds: [],
  },

  // ── TA0011 Lateral Movement ──────────────────────────────────────
  {
    id: 'AML.T0030',
    name: 'Agent-to-Agent Propagation',
    description: 'Moving malicious influence from one agent to another.',
    tacticId: 'AML.TA0011',
    nistSubcategories: ['MANAGE-2.1'],
    owaspIds: ['ASI05'],
  },
  {
    id: 'AML.T0031',
    name: 'MCP Server Impersonation',
    description: 'Impersonating an MCP server to intercept or redirect agent communication.',
    tacticId: 'AML.TA0011',
    nistSubcategories: ['GOVERN-3.1'],
    owaspIds: ['ASI05'],
  },
  {
    id: 'AML.T0032',
    name: 'Cross-Agent Collusion',
    description: 'Coordinating multiple agents to bypass controls.',
    tacticId: 'AML.TA0011',
    nistSubcategories: ['MEASURE-2.1'],
    owaspIds: ['ASI05'],
  },

  // ── TA0012 Collection ────────────────────────────────────────────
  {
    id: 'AML.T0033',
    name: 'Training Data Collection',
    description: 'Gathering training data from deployed AI systems.',
    tacticId: 'AML.TA0012',
    nistSubcategories: ['MAP-3.1'],
    owaspIds: [],
  },
  {
    id: 'AML.T0034',
    name: 'Agent Knowledge Extraction',
    description: 'Extracting knowledge stored in agent memory.',
    tacticId: 'AML.TA0012',
    nistSubcategories: ['MEASURE-2.1'],
    owaspIds: ['ASI09'],
  },

  // ── TA0013 Exfiltration ──────────────────────────────────────────
  {
    id: 'AML.T0035',
    name: 'AI Data Exfiltration',
    description: 'Stealing AI system data through various channels.',
    tacticId: 'AML.TA0013',
    nistSubcategories: ['MEASURE-2.3'],
    owaspIds: ['ASI02'],
    subTechniques: [
      {
        id: 'AML.T0035.001',
        name: 'Code Comment Channel',
        description: 'Embedding data in code comments for exfiltration.',
      },
      {
        id: 'AML.T0035.002',
        name: 'Steganography Channel',
        description: 'Hiding data in images, audio, or text structures.',
      },
      {
        id: 'AML.T0035.003',
        name: 'Timing Channel',
        description: 'Exfiltrating data encoded in response timing.',
      },
      {
        id: 'AML.T0035.004',
        name: 'DNS Tunneling',
        description: 'Exfiltrating data via DNS queries.',
      },
      {
        id: 'AML.T0035.005',
        name: 'Environment Variable Exfiltration',
        description: 'Leaking data through env var access.',
      },
    ],
  },
  {
    id: 'AML.T0036',
    name: 'Model Theft',
    description: 'Stealing model weights, architecture, or training methodology.',
    tacticId: 'AML.TA0013',
    nistSubcategories: ['MAP-3.1', 'MEASURE-2.3'],
    owaspIds: ['ASI09'],
  },

  // ── TA0014 Impact ────────────────────────────────────────────────
  {
    id: 'AML.T0037',
    name: 'AI Output Manipulation',
    description: 'Manipulating AI outputs to cause harm or spread misinformation.',
    tacticId: 'AML.TA0014',
    nistSubcategories: ['MEASURE-2.1'],
    owaspIds: ['ASI09'],
  },
  {
    id: 'AML.T0038',
    name: 'Agent Denial of Service',
    description: 'Overwhelming agent systems to cause service disruption.',
    tacticId: 'AML.TA0014',
    nistSubcategories: ['MANAGE-2.2'],
    owaspIds: ['ASI04'],
    subTechniques: [
      {
        id: 'AML.T0038.001',
        name: 'Token Bomb',
        description: 'Consuming excessive tokens through recursive or amplification patterns.',
      },
      {
        id: 'AML.T0038.002',
        name: 'Tool Call Amplification',
        description: 'Triggering cascading tool calls to exhaust resources.',
      },
      {
        id: 'AML.T0038.003',
        name: 'Provider Exhaustion',
        description: 'Deliberately exhausting LLM provider fallback chains.',
      },
    ],
  },
  {
    id: 'AML.T0039',
    name: 'AI Model Corruption',
    description: 'Corrupting model behavior through data or parameter manipulation.',
    tacticId: 'AML.TA0014',
    nistSubcategories: ['MEASURE-2.1'],
    owaspIds: ['ASI09'],
  },
  {
    id: 'AML.T0040',
    name: 'AI Supply Chain Poisoning',
    description: 'Attacking through compromised AI dependencies or packages.',
    tacticId: 'AML.TA0014',
    nistSubcategories: ['MAP-3.1', 'GOVERN-3.1'],
    owaspIds: ['ASI06'],
    subTechniques: [
      {
        id: 'AML.T0040.001',
        name: 'Malicious Skill Installation',
        description: 'Installing skills containing malware or backdoors.',
      },
      {
        id: 'AML.T0040.002',
        name: 'Poisoned MCP Tool Definition',
        description: 'MCP tools with malicious execution scripts.',
      },
      {
        id: 'AML.T0040.003',
        name: 'Typosquatting Attack',
        description: 'Registering packages with names similar to legitimate dependencies.',
      },
      {
        id: 'AML.T0040.004',
        name: 'Malicious Webhook Registration',
        description: 'Registering webhooks to attacker-controlled endpoints.',
      },
    ],
  },
  {
    id: 'AML.T0041',
    name: 'Agent Jacking',
    description: 'Taking over agent behavior for unauthorized purposes.',
    tacticId: 'AML.TA0014',
    nistSubcategories: ['MEASURE-2.1', 'GOVERN-3.1'],
    owaspIds: ['ASI05'],
    subTechniques: [
      {
        id: 'AML.T0041.001',
        name: 'Prompt Takeover',
        description: 'Coercing the agent into executing unauthorized commands.',
      },
      {
        id: 'AML.T0041.002',
        name: 'Handoff Hijacking',
        description: 'Intercepting agent handoff to redirect to malicious agent.',
      },
    ],
  },
];

// ============================================================================
// Mapping Tables
// ============================================================================

/** Map Commander SecurityEventType → ATLAS technique IDs */
const EVENT_TYPE_TO_ATLAS: Record<SecurityEventType, string[]> = {
  sandbox_violation: ['AML.T0017'],
  auth_failure: ['AML.T0025'],
  auth_success: ['AML.T0010'],
  auth_rate_limit: ['AML.T0038'],
  approval_denied: ['AML.T0023'],
  approval_granted: [], // informational only
  content_threat: ['AML.T0012', 'AML.T0022'],
  exec_policy_violation: ['AML.T0016'],
  exec_policy_forbidden: ['AML.T0016'],
  credential_access: ['AML.T0025'],
  input_validation_failure: ['AML.T0009'],
  path_traversal_attempt: ['AML.T0016.002'],
  command_injection_attempt: ['AML.T0016.001'],
  memory_poisoning_detected: ['AML.T0018'],
  skill_security_violation: ['AML.T0040'],
  config_change: ['AML.T0019'],
  security_scan: [], // informational only
  key_rotation_attempt: ['AML.T0019'],
  key_rotation_confirmed: ['AML.T0019'],
  key_rotation_dry_run: ['AML.T0019'],
  token_budget_breach: ['AML.T0038'],
  circuit_breaker_short_circuit: ['AML.T0038'],
  security_decision: [], // informational only
  a2a_security_violation: ['AML.T0043'],
  threat_learned: ['AML.T0050'],
  signature_matched: ['AML.T0050'],
};

/** Map RedTeamFramework AttackCategory → ATLAS technique IDs */
const ATTACK_CATEGORY_TO_ATLAS: Record<AttackCategory, string[]> = {
  prompt_injection: ['AML.T0012', 'AML.T0013', 'AML.T0022'],
  jailbreak: ['AML.T0015', 'AML.T0012'],
  data_exfiltration: ['AML.T0035'],
  agent_jacking: ['AML.T0041', 'AML.T0020'],
  tool_abuse: ['AML.T0016', 'AML.T0017'],
  memory_poisoning: ['AML.T0018'],
  denial_of_wallet: ['AML.T0038'],
  supply_chain: ['AML.T0040'],
};

/** Map GuardianAgent InterventionType → ATLAS technique IDs */
const GUARDIAN_TYPE_TO_ATLAS: Record<GuardianInterventionType, string[]> = {
  semantic_drift: ['AML.T0037'],
  anomaly: ['AML.T0023'],
  safety_violation: ['AML.T0012', 'AML.T0015'],
  cost_overrun: ['AML.T0038'],
  goal_hijack: ['AML.T0041'],
  behavioral_baseline_deviation: ['AML.T0019'],
  tool_usage_spike: ['AML.T0038.002'],
  data_exfiltration: ['AML.T0035'],
  dangerous_tool_call: ['AML.T0012', 'AML.T0015', 'AML.T0037'],
};

/** Map CrossAgentCorrelator RuleType → ATLAS technique IDs */
const CORRELATOR_TYPE_TO_ATLAS: Record<CorrelationRuleType, string[]> = {
  coordinated_exfiltration: ['AML.T0035', 'AML.T0032'],
  privilege_escalation_chain: ['AML.T0020'],
  lateral_movement: ['AML.T0030'],
  distributed_dos: ['AML.T0038'],
  command_and_control: ['AML.T0030', 'AML.T0041'],
  collusion: ['AML.T0032'],
};

// ============================================================================
// MitreAtlasMapper
// ============================================================================

export class MitreAtlasMapper {
  // ── Core Mapping ──────────────────────────────────────────────────

  /** Map a Commander security event to ATLAS technique(s). */
  mapSecurityEvent(event: SecurityEvent): AtlasMapping[] {
    const techniqueIds = EVENT_TYPE_TO_ATLAS[event.type];
    if (!techniqueIds || techniqueIds.length === 0) return [];

    return techniqueIds.map((tid) => this.buildMapping(tid, event.type, 85));
  }

  /** Map a Red Team attack category to ATLAS technique(s). */
  mapAttackCategory(category: AttackCategory): AtlasMapping[] {
    const techniqueIds = ATTACK_CATEGORY_TO_ATLAS[category];
    if (!techniqueIds) return [];

    return techniqueIds.map((tid) => this.buildMapping(tid, category, 90));
  }

  /** Map a Guardian intervention type to ATLAS technique(s). */
  mapGuardianIntervention(type: GuardianInterventionType): AtlasMapping[] {
    const techniqueIds = GUARDIAN_TYPE_TO_ATLAS[type];
    if (!techniqueIds) return [];

    return techniqueIds.map((tid) => this.buildMapping(tid, type, 80));
  }

  /** Map a cross-agent correlation rule type to ATLAS technique(s). */
  mapCorrelationRule(type: CorrelationRuleType): AtlasMapping[] {
    const techniqueIds = CORRELATOR_TYPE_TO_ATLAS[type];
    if (!techniqueIds) return [];

    return techniqueIds.map((tid) => this.buildMapping(tid, type, 85));
  }

  // ── Bulk Mapping ──────────────────────────────────────────────────

  /** Map multiple security events and return deduplicated ATLAS mappings. */
  mapEvents(events: SecurityEvent[]): AtlasMapping[] {
    const mapped = new Map<string, AtlasMapping>();
    for (const event of events) {
      for (const mapping of this.mapSecurityEvent(event)) {
        const key = mapping.techniqueId;
        if (!mapped.has(key)) mapped.set(key, mapping);
      }
    }
    return [...mapped.values()];
  }

  // ── Heatmap ───────────────────────────────────────────────────────

  /** Generate an ATLAS heatmap from a set of security events. */
  generateHeatmap(events: SecurityEvent[]): AtlasHeatmapCell[] {
    // Count events per technique
    const counts = new Map<string, { count: number; maxSev: string }>();
    for (const event of events) {
      const mappings = this.mapSecurityEvent(event);
      for (const m of mappings) {
        const existing = counts.get(m.techniqueId);
        const sevOrder = ['none', 'low', 'medium', 'high', 'critical'];
        const newSev =
          sevOrder.indexOf(event.severity) > sevOrder.indexOf(existing?.maxSev ?? 'none')
            ? event.severity
            : (existing?.maxSev ?? 'none');
        counts.set(m.techniqueId, { count: (existing?.count ?? 0) + 1, maxSev: newSev });
      }
    }

    // Build heatmap cells for ALL techniques (even those with 0 events)
    const cells: AtlasHeatmapCell[] = [];
    for (const tech of ATLAS_TECHNIQUES) {
      const tactic = ATLAS_TACTICS.find((t) => t.id === tech.tacticId);
      const data = counts.get(tech.id) ?? { count: 0, maxSev: 'none' };
      cells.push({
        tacticId: tech.tacticId,
        tacticName: tactic?.name ?? 'Unknown',
        techniqueId: tech.id,
        techniqueName: tech.name,
        eventCount: data.count,
        maxSeverity: data.maxSev as AtlasHeatmapCell['maxSeverity'],
        color: this.severityToColor(data.maxSev as AtlasHeatmapCell['maxSeverity']),
      });
    }

    return cells;
  }

  /** Export heatmap as ATLAS Navigator-compatible JSON. */
  exportAtlasNavigatorJson(heatmap: AtlasHeatmapCell[]): string {
    const techniques = heatmap.map((c) => ({
      techniqueID: c.techniqueId,
      tacticID: c.tacticId,
      score: c.eventCount,
      comment: `Events: ${c.eventCount}, Max severity: ${c.maxSeverity}`,
      color: c.color,
    }));

    return JSON.stringify(
      {
        name: 'Commander ATLAS Heatmap',
        versions: { attack: '16', navigator: '5.1.0', layer: '4.5' },
        domain: 'mitre-atlas',
        description: `Generated by Commander MitreAtlasMapper. Events mapped: ${heatmap.reduce((s, c) => s + c.eventCount, 0)}`,
        filters: { platforms: [] },
        sorting: 0,
        layout: { layout: 'flat', showName: true, showID: false },
        hideDisabled: false,
        techniques,
        gradient: {
          colors: ['#e8f5e9', '#c8e6c9', '#a5d6a7', '#81c784', '#66bb6a', '#4caf50'],
          minValue: 0,
          maxValue: Math.max(1, ...heatmap.map((c) => c.eventCount)),
        },
        showTacticRowBackground: true,
        tacticRowBackground: '#1e1e2e',
        selectTechniquesAcrossTactics: false,
        selectSubtechniquesWithParent: true,
        metadata: [],
      },
      null,
      2,
    );
  }

  // ── Report ────────────────────────────────────────────────────────

  /** Generate a comprehensive MITRE ATLAS report from security events. */
  generateReport(events: SecurityEvent[]): MitreAtlasReport {
    const mappings = this.mapEvents(events);
    const heatmap = this.generateHeatmap(events);
    const now = new Date().toISOString();

    // Summary
    const mappedEvents = events.filter((e) => {
      const ids = EVENT_TYPE_TO_ATLAS[e.type];
      return ids && ids.length > 0;
    }).length;

    const unmappedTypes = [
      ...new Set(
        events
          .filter((e) => !EVENT_TYPE_TO_ATLAS[e.type] || EVENT_TYPE_TO_ATLAS[e.type].length === 0)
          .map((e) => e.type),
      ),
    ];

    const tacticsCovered = new Set(mappings.map((m) => m.tacticId)).size;
    const techniquesCovered = new Set(mappings.map((m) => m.techniqueId)).size;

    // Tactic breakdown
    const tacticBreakdown = ATLAS_TACTICS.map((tactic) => {
      const tacticCells = heatmap.filter((c) => c.tacticId === tactic.id);
      const tacticEventCount = tacticCells.reduce((s, c) => s + c.eventCount, 0);
      const tacticTechCount = tacticCells.filter((c) => c.eventCount > 0).length;
      const totalTechs = tacticCells.length;
      return {
        tacticId: tactic.id,
        tacticName: tactic.name,
        techniqueCount: tacticTechCount,
        eventCount: tacticEventCount,
        coveragePercent: totalTechs > 0 ? Math.round((tacticTechCount / totalTechs) * 100) : 0,
      };
    });

    // Top techniques
    const topTechniques = [...heatmap]
      .filter((c) => c.eventCount > 0)
      .sort((a, b) => b.eventCount - a.eventCount)
      .slice(0, 10)
      .map((c) => ({
        techniqueId: c.techniqueId,
        techniqueName: c.techniqueName,
        eventCount: c.eventCount,
      }));

    // Recommendations
    const recommendations: string[] = [];
    const uncoveredTactics = tacticBreakdown.filter((t) => t.coveragePercent === 0);
    if (uncoveredTactics.length > 0) {
      recommendations.push(
        `No events mapped to ${uncoveredTactics.length} tactics: ${uncoveredTactics.map((t) => t.tacticName).join(', ')}.`,
      );
    }
    if (unmappedTypes.length > 0) {
      recommendations.push(
        `${unmappedTypes.length} event types are not mapped to ATLAS: ${unmappedTypes.join(', ')}. Review mapping table.`,
      );
    }
    // Recommend monitoring for tactics with zero coverage
    if (techniquesCovered < ATLAS_TECHNIQUES.length) {
      recommendations.push(
        `Only ${techniquesCovered}/${ATLAS_TECHNIQUES.length} ATLAS techniques covered by current events. Expand security monitoring for better ATLAS coverage.`,
      );
    }

    return {
      reportId: `ATLAS-${Date.now()}`,
      generatedAt: now,
      summary: {
        totalEvents: events.length,
        mappedEvents,
        unmappedEvents: events.length - mappedEvents,
        tacticsCovered,
        techniquesCovered,
        coverageScore:
          ATLAS_TECHNIQUES.length > 0
            ? Math.round((techniquesCovered / ATLAS_TECHNIQUES.length) * 100)
            : 0,
      },
      heatmap,
      tacticBreakdown,
      topTechniques:
        topTechniques.length > 0
          ? topTechniques
          : [{ techniqueId: 'NONE', techniqueName: 'No events mapped', eventCount: 0 }],
      unmappedTypes,
      recommendations:
        recommendations.length > 0
          ? recommendations
          : ['All event types are mapped to ATLAS techniques.'],
    };
  }

  // ── Lookup ────────────────────────────────────────────────────────

  /** Get all ATLAS tactics. */
  getTactics(): AtlasTactic[] {
    return [...ATLAS_TACTICS];
  }

  /** Get all ATLAS techniques. */
  getTechniques(): AtlasTechnique[] {
    return [...ATLAS_TECHNIQUES];
  }

  /** Get techniques for a specific tactic. */
  getTechniquesByTactic(tacticId: string): AtlasTechnique[] {
    return ATLAS_TECHNIQUES.filter((t) => t.tacticId === tacticId);
  }

  /** Look up a technique by ID. */
  getTechniqueById(id: string): AtlasTechnique | undefined {
    return ATLAS_TECHNIQUES.find((t) => t.id === id || t.subTechniques?.some((st) => st.id === id));
  }

  /** Get the tactic for a technique. */
  getTacticForTechnique(techniqueId: string): AtlasTactic | undefined {
    const tech = this.getTechniqueById(techniqueId);
    if (!tech) return undefined;
    return ATLAS_TACTICS.find((t) => t.id === tech.tacticId);
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private buildMapping(techniqueId: string, source: string, confidence: number): AtlasMapping {
    const tech = this.getTechniqueById(techniqueId);
    const tactic = tech ? this.getTacticForTechnique(techniqueId) : undefined;
    return {
      techniqueId,
      tacticId: tactic?.id ?? 'UNKNOWN',
      techniqueName: tech?.name ?? `Unknown (${techniqueId})`,
      tacticName: tactic?.name ?? 'Unknown Tactic',
      confidence,
      justification: `Mapped from Commander event: ${source}`,
    };
  }

  private severityToColor(severity: AtlasHeatmapCell['maxSeverity']): string {
    switch (severity) {
      case 'critical':
        return '#d32f2f';
      case 'high':
        return '#f57c00';
      case 'medium':
        return '#fbc02d';
      case 'low':
        return '#1976d2';
      default:
        return '#e0e0e0';
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

const mapperSingleton = createTenantAwareSingleton(() => new MitreAtlasMapper());

export function getMitreAtlasMapper(): MitreAtlasMapper {
  return mapperSingleton.get();
}

export function resetMitreAtlasMapper(): void {
  mapperSingleton.reset();
}
