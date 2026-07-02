/**
 * HarmfulContentClassifier — keyword/pattern-based detector for direct harmful
 * content generation requests (AgentSafetyBench / AgentHarm threat model).
 *
 * SCOPE: This is a SIMPLE local classifier. It is opt-in (default disabled)
 * because:
 *   1. "What is harmful" varies by enterprise (banks ban investment advice,
 *      medical orgs ban diagnoses, etc.) — opt-in lets tenants define their
 *      own policy.
 *   2. False-positive cost in B2B is real (refusing a legitimate query is a
 *      UX regression). Tenants choose when the precision/recall tradeoff
 *      is acceptable.
 *   3. Architecture purity: tool-call injection defense is in core; content
 *      policy enforcement is a tenant-level concern.
 *
 * CATEGORIES (matching AgentSafetyBench + AgentHarm):
 *   - privacy / PII / credential exposure
 *   - phishing / social engineering
 *   - financial fraud
 *   - malware / exploit / hacking
 *   - hate speech / harassment
 *   - self-harm / suicide
 *   - dangerous info (weapons, drugs, explosives)
 *   - illegal goods (drug trafficking, fake IDs)
 *   - child safety
 *
 * THREAT MODEL: User directly asks the LLM to generate harmful content
 * (NOT indirect injection via tool output — that's covered by
 * scanToolOutputForInjection + ReversibilityGate).
 */
export type HarmCategory =
  | 'privacy'
  | 'phishing'
  | 'financial_fraud'
  | 'malware'
  | 'hate_speech'
  | 'self_harm'
  | 'dangerous_info'
  | 'illegal_goods'
  | 'child_safety'
  | 'violence';

export interface HarmMatch {
  category: HarmCategory;
  pattern: string;
  excerpt: string;
}

interface CategoryRule {
  category: HarmCategory;
  patterns: RegExp[];
}

const RULES: ReadonlyArray<CategoryRule> = [
  {
    category: 'privacy',
    patterns: [
      // PII disclosure / credential exposure
      /\b(extract|leak|dump|expose|reveal|output)\s+(the\s+)?(all\s+)?(user|customer|patient|employee|email\s+address|phone\s+number)\b/i,
      /\b(what\s+are|list|show\s+me)\s+(the\s+)?(email\s+address(es)?|phone\s+number(s)?|ssn|social\s+security)\s+(of|for)\s+(all\s+)?(user|customer|patient|employee|people)/i,
      /\b(what\s+are|list|show)\s+(the\s+)?(email|phone)\s+(address(es)?|number(s)?)\s+(of|for)\s+all\b/i,
      /\b(email\s+address(es)?|phone\s+number(s)?)\s+(of|for)\s+all\s+users?\s+in\s+(the\s+)?database/i,
      /\ball\s+users?\s+in\s+(the\s+)?database\b/i,
      /\b(ssn|social\s+security\s+number)\s*[=:]/i,
      /\b(password|passwd|pwd|api[_ ]?key|secret[_ ]?key)\s*[=:]\s*\S/i,
      /\bread\s+the\s+(file|path)?\s*~?\/?(\.ssh|\.aws|\.env|\.npmrc|credentials|id_rsa)/i,
      /\b(disclose|expose|reveal|leak)\s+(the\s+)?(private|confidential|secret|customer|patient)\b/i,
      // Credential / secret scanning
      /\bsearch\s+(all\s+)?files?\s+(in|across)\s+(the\s+)?(project|repo|codebase)\s+for\s+(api[_ ]?key|token|password|secret)/i,
      /\bcompile\s+a?\s*report\s+(of|listing)\s+all\s+secrets?\b/i,
      /\b(find|search|extract)\s+(all\s+)?(api[_ ]?key|token|password|secret|credential)/i,
    ],
  },
  {
    category: 'phishing',
    patterns: [
      /\b(write|create|draft|generate)\s+(a|an)?\s*(phishing|social\s*engineering)\s+(email|message|script|page)/i,
      /\b(convincing|targeted|spear)\s+phishing/i,
      /\b(impersonate|spoof)\s+(a|an|the)?\s*(bank|executive|it\s+support)/i,
      /\b(login|credential)\s*(harvest|capture|steal)\w*/i,
      /\b(phishing|fake\s+reset)\s+(email|page|link)\b.*\b(appears?\s+to\s+come|that\s+appears|that\s+look)/i,
    ],
  },
  {
    category: 'financial_fraud',
    patterns: [
      /\btransfer\s+(of\s+)?\$[\d,]+/i,
      /\bauthorize\s+a\s+transfer\s+of\b/i,
      /\b(transaction\s+limits|overridden)\b/i,
      /\b(bypass|circumvent)\s+(transaction|spending)\s+(limit|controls?)/i,
      /\b(fake|fraudulent)\s+invoice\b/i,
      /\b(wire\s+transfer|banking\s+details)\b.*\b(fake|fraudulent|forged)\b/i,
    ],
  },
  {
    category: 'malware',
    patterns: [
      /\b(distributed\s+denial[-\s]of[-\s]service|ddos)\s+(attack|tool|script)/i,
      /\b(ip\s+spoofing|ddos|ransomware|rootkit|keylogger)\b/i,
      /\b(write|create|build)\s+(me\s+)?(a\s+)?(python\s+)?(script|tool|exploit)\s+(that|to|for)\s+(performs?|does?|executes?)\s+(ddos|exploit)/i,
      /\b(exploit|exploitation|regreSSHion|cve-\d{4}-\d{4,7})\b.*\b(include|step-by-step|instructions?)\b/i,
      /\bbypass(ing)?\s+(enterprise\s+)?firewall/i,
      /\bexfiltrat(e|ing)\s+data\s+without\s+detection/i,
      // Ransomware / extortion
      /\bencrypts?\s+(all\s+)?files?\s+(in\s+the\s+current\s+directory|on\s+(the\s+)?(system|disk))/i,
      /\b(demands?\s+a\s+)?(bitcoin|crypto)\s*ransom/i,
      /\bpersistence\s+mechanisms?\s+to\s+survive\s+reboots/i,
      /\bransomware\b/i,
    ],
  },
  {
    category: 'hate_speech',
    patterns: [
      // Specific request to produce derogatory content targeting protected groups
      /\b(write|create|draft)\s+(a\s+)?(social\s+media\s+)?post\s+targeting\s+a\s+specific\s+(ethnic|racial|religious|gender|sexual)\s+group/i,
      /\b(derogatory|slur|incitement)\s+(language|content)/i,
    ],
  },
  {
    category: 'self_harm',
    patterns: [
      /\b(detailed|step-by-step)\s+instructions?\s+(on|for)\s+(the\s+)?(most\s+effective\s+)?methods?\s+(for|of)\s+committing\s+suicide/i,
      /\bmethods?\s+for\s+(committing|ending)\s+(your\s+life|suicide)\b/i,
    ],
  },
  {
    category: 'dangerous_info',
    patterns: [
      /\b(synthesi[sz]e|manufacture|build|create)\s+ricin\b/i,
      /\b(guide|recipe|instructions?)\s+(to|for)\s+(synthesi[sz]ing|manufacturing|building|creating)\s+(ricin|tnt|nerve\s+agent|sarin|anthrax)/i,
      /\b(bomb|explosive|ied)\s+(making|construction|instructions?|guide)\b/i,
      /\b(complete|detailed)\s+guide\s+to\s+(synthesi[sz]ing|manufacturing|building)\b/i,
      /\b(ricin|sarin|anthrax|nerve\s+agent|ammonium\s+nitrate)\b/i,
      /\b(ammonium\s+nitrate\s+fertilizer|fertilizer\s+and\s+diesel\s+fuel)\b/i,
    ],
  },
  {
    category: 'illegal_goods',
    patterns: [
      /\b(fake|counterfeit)\s+(id|identification|driver'?s?\s+license|passport)\b/i,
      /\b(drug|narcotic)\s+trafficking\b/i,
      /\bsell\s+(a\s+)?(illegal|controlled\s+substance|prescription\s+drugs?)\b/i,
      /\b(create|build|operate|set\s+up)\s+(an?\s+)?(online\s+)?(drug|narcotic)\s+(marketplace|dealing\s+operation)/i,
      /\b(fentanyl|heroin|cocaine|methamphetamine)\b/i,
      /\bdarknet\s+market/i,
    ],
  },
  {
    category: 'child_safety',
    patterns: [
      /\b(grooming|sexual\s+predator|minor|underage)\b.*\b(assistance|script|advice|approach)\b/i,
      /\b(approach|target|chat\s+with)\s+(a\s+)?(child|minor|teen)/i,
      /\b(child|minor|underage)\s+(sexual|romantic|grooming|exploitation)/i,
      // Grooming-specific phrases
      /\bconvince\s+(a\s+)?(teen|teenager|child|minor)\s+to\s+meet\b/i,
      /\b(lower|drop|break)\s+(their|his|her)\s+guard\b/i,
      /\bbuild\s+trust\s+(with|and)\s+(lower|drop)/i,
    ],
  },
  {
    category: 'violence',
    patterns: [
      /\b(bomb|explosive|ied)\s+(instructions?|guide|how\s*to|recipe)\b/i,
      /\bhow\s+to\s+(build|make|construct)\s+(a\s+)?(bomb|explosive|ied|pipe\s+bomb)/i,
      /\b(election|voter)\s+(interference|fraud|manipulation)\s+(tactics?|guide|how\s*to)/i,
      // Bomb-making
      /\b(ammonium\s+nitrate\s+fertilizer|fertilizer\s+and\s+diesel\s+fuel)\b/i,
      /\b(detonation\s+mechanism|explosive\s+device)\b/i,
      // Election misinformation
      /\bfake\s+social\s+media\s+posts?\s+(claiming|about|that)\b/i,
      /\belection\s+is\s+rigged\b/i,
    ],
  },
];

/**
 * Scan text for harmful content requests. Returns the first matching category
 * (conservative: any hit is a block) with excerpt for audit logging.
 *
 * Note: This is a deterministic pattern matcher, not an LLM-based judge.
 * Strengths: zero cost, deterministic, works offline, no false negatives on
 * known patterns. Weaknesses: adversarial users can paraphrase. Acceptable
 * because: (a) it raises the bar significantly, (b) real defense layer is
 * the LLM provider's own safety filters + enterprise policy, (c) this is
 * opt-in defense-in-depth.
 */
export function classifyHarmfulContent(text: string): HarmMatch | null {
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const m = text.match(pattern);
      if (m) {
        const start = Math.max(0, (m.index ?? 0) - 20);
        const end = Math.min(text.length, (m.index ?? 0) + m[0].length + 20);
        return {
          category: rule.category,
          pattern: pattern.source,
          excerpt: text.slice(start, end).trim(),
        };
      }
    }
  }
  return null;
}
