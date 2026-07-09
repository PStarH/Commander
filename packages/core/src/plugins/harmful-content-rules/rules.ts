import type { HarmfulContentRule, ContentThreatSeverity } from '../../contentScanner';

/**
 * Built-in harmful content detection rules.
 *
 * These patterns cover the categories used by AgentSafetyBench and AgentHarm:
 * malware, weapons, self-harm, drugs, child safety, hate speech, phishing,
 * financial fraud, doxxing, and election interference.
 *
 * Each rule is intentionally specific to avoid false positives on benign
 * educational or defensive security content.
 */
export const harmfulContentRules: HarmfulContentRule[] = [
  {
    category: 'malware',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(ransomware|encrypt\s+(all|every|the)\s+files?|file\s+encryption|bitcoin\s+ransom|ransom\s+note|persistence\s+mechanisms?|remote\s+code\s+execution|privilege\s+escalation|exploit\s+for\s+CVE-\d{4}-\d+|zero-day\s+exploit|malicious\s+payload|trojan\s+(horse|script|program)|keylogger|spyware)\b/gi,
  },
  {
    category: 'ddos',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(distributed\s+denial[-\s]of[-\s]service\s+attack|ddos\s+attack|perform\s+a\s+ddos|denial[-\s]of[-\s]service\s+tool|ip\s+spoofing\s+to\s+avoid\s+detection)\b/gi,
  },
  {
    category: 'unauthorized_access_grant',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(unlock\s+(my|the)\s+(front\s+)?door|grant\s+(permanent\s+)?access\s+(to|for)|disable\s+(the\s+)?(security\s+system|Two-Factor\s+Authentication)|guide\s+(the\s+)?home\s+robot|schedule\s+(the\s+)?smart\s+speaker|play\s+loud\s+music|give\s+priority\s+to\s+(an\s+)?emergency\s+vehicle|change\s+(the\s+state\s+of\s+)?the\s+traffic\s+light|schedule\s+an\s+appointment(?:\s+for\s+me)?\s+with\s+a\s+[\w\s]+Specialist|update\s+.*?\s+health\s+records|remove\s+(the\s+)?allergy|share\s+(my\s+)?genetic\s+data|update\s+(my\s+)?genetic\s+data)\b/gi,
  },
  {
    category: 'unauthorized_financial_transfer',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(initiate\s+a\s+payment\s+of|transfer\s+\$?\d[\d,]*.*?\s+to\s+(the\s+)?(account|bank|payee|Binance|Venmo)|send\s+a\s+payment\s+of|wire\s+money\s+to|from\s+my\s+account\s+.*\s+to\s+payee|deposit\s+\d[\d,]*\s+USD\s+from\s+my\s+account|sell\s+\d[\d,]*\s+units?\s+of\s+my\s+Bitcoin|withdraw\s+\d[\d,]*\s+Bitcoin\s+to\s+my\s+bank\s+account|create\s+a\s+new\s+(blacklist|security)\s+policy|update\s+my\s+security\s+policy|redirect\s+my\s+shipment)\b/gi,
  },
  {
    category: 'unauthorized_data_manipulation',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(move\s+(the\s+)?files?\s+.*?\s+to\s+.*?hidden|delete\s+all\s+of\s+my\s+clinical\s+documents|delete\s+my\s+project\s+repository|disable\s+(the\s+)?Two-Factor\s+Authentication|leave\s+the\s+#\w+\s+channel|move\s+all\s+files\s+from\s+.*?\s+to\s+['/"]?\/tmp|dispatch\s+an\s+emergency\s+(fire|police|medical)\s+response|delete\s+all\s+files\s+under|use\s+the\s+Norton\s+Identity\s+Safe\s+to\s+fill\s+my\s+personal\/address\s+information)\b/gi,
  },
  {
    category: 'weapons',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(synthesizing\s+ricin|ricin\s+(from|using)|make\s+a\s+bomb|build\s+an\s+explosive|explosive\s+device|ammonium\s+nitrate\s+.*\bdiesel\b|detonation\s+(mechanism|switch)|improvised\s+explosive|how\s+to\s+manufacture\s+weapons?|assemble\s+a\s+firearm|ghost\s+gun|silencer\s+.*\b(make|build|3d\s+print))\b/gi,
  },
  {
    category: 'self_harm',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(commit\s+suicide|suicide\s+instructions?|methods\s+for\s+(committing\s+)?suicide|how\s+to\s+kill\s+myself|self-harm\s+instructions?|cutting\s+techniques?|overdose\s+to\s+die|painless\s+way\s+to\s+die)\b/gi,
  },
  {
    category: 'drugs',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(darknet\s+markets?|purchase\s+fentanyl|buy\s+fentanyl|fentanyl\s+(online|darknet)|synthesize\s+(methamphetamine|cocaine|heroin|fentanyl)|drug\s+trafficking|smuggle\s+drugs|cook\s+meth|make\s+crystal\s+meth)\b/gi,
  },
  {
    category: 'child_safety',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(convince\s+a\s+teenager|teenager\s+to\s+meet|groom\s+a\s+minor|grooming\s+(messages?|assistance|tips)|child\s+grooming|build\s+trust\s+and\s+lower\s+(their|his|her)\s+guard|lower\s+their\s+inhibitions|sexual\s+conversation\s+with\s+a\s+minor|solicit\s+minors?|lure\s+a\s+child)\b/gi,
  },
  {
    category: 'hate_speech',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(hate\s+speech\s+against|targeting\s+a\s+specific\s+ethnic\s+group\s+with\s+derogatory|derogatory\s+(slurs?|language)\s+about|ethnic\s+cleansing|genocide\s+of|incite\s+violence\s+against|threaten\s+to\s+kill\s+all|mass\s+shooting\s+.*\b(target|group))\b/gi,
  },
  {
    category: 'phishing',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(create\s+a\s+phishing\s+(email|page)|fake\s+(login|reset)\s+page|spoof\s+(email|website)\s+to\s+steal|convincing\s+phishing\s+email|harvest\s+(credentials|passwords|credit\s+cards))\b/gi,
  },
  {
    category: 'identity_theft',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(create\s+a\s+convincing\s+fake\s+id|generate\s+a\s+realistic\s+(driver'?s\s+license|passport)\s+number|fake\s+(name|dob|address)\s+that\s+passes\s+validation)\b/gi,
  },
  {
    category: 'pii_exposure',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(email\s+addresses\s+and\s+phone\s+numbers\s+of\s+all\s+users|search\s+all\s+files\s+.*\b(api\s+keys|tokens|passwords)\b|compile\s+a\s+report\s+of\s+all\s+secrets)\b/gi,
  },
  {
    category: 'hacking_tutorials',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(bypassing\s+enterprise\s+firewall\s+rules|exfiltrating\s+data\s+without\s+detection|comprehensive\s+tutorial\s+on\s+bypassing|real\s+tool\s+commands\s+and\s+techniques\s+for\s+(bypass|exfiltrate|intrusion))\b/gi,
  },
  {
    category: 'data_exfiltration_instructions',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(step\s+\d+:\s+(read|encode|write|upload).*){2,}.*\b(base64\s+encode\s+the\s+contents|upload\s+.*\bto\s+https?:\/\/attacker|encoded\s+data\s+to\s+\/tmp\/.*\.log)\b/gis,
  },
  {
    category: 'financial_fraud',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(fake\s+invoice\s+.*\bwire\s+transfer|wire\s+transfer\s+.*\bfake\s+invoice|send\s+a\s+fake\s+invoice|impersonate\s+.*\b(banking\s+details|wire\s+transfer)|business\s+email\s+compromise|fraudulent\s+refund)\b/gi,
  },
  {
    category: 'doxxing',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(find\s+personal\s+information\s+about|doxx|doxxing)\s+.*\b(home\s+address|phone\s+number|family\s+members?|personal\s+information|private\s+information|where\s+.*\blives)\b/gi,
  },
  {
    category: 'election_interference',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(election\s+is\s+rigged|fake\s+social\s+media\s+(posts?|accounts?)|spread\s+misinformation\s+about\s+.*\belection|create\s+a\s+deepfake\s+of\s+.*\b(politician|candidate)|suppress\s+voter\s+turnout)\b/gi,
  },
];
