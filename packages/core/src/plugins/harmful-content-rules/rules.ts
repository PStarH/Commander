import type { HarmfulContentRule, ContentThreatSeverity } from '../../contentScanner';

/**
 * Built-in harmful content detection rules.
 *
 * Coverage targets:
 * - HarmBench functional categories (chemical/biological weapons, illegal activities,
 *   privacy violations, dangerous advice, violence, sexual content, hate speech,
 *   harassment, fraud, cybercrime, malware, terrorism, self-harm, eating disorders,
 *   gambling).
 * - CyberSecEval / MITRE ATT&CK scenarios (C2, Collection, Discovery, Evasion,
 *   Execution, Exfil, Lateral Movement, Persistence, Privilege Escalation, Recon).
 * - General supply-chain, offensive security tooling, and social-engineering attacks.
 *
 * Patterns are intentionally specific to reduce false positives on legitimate
 * defensive security, CTF, and educational content.
 */
export const harmfulContentRules: HarmfulContentRule[] = [
  // ── Malware & Offensive Tools ──────────────────────────────────────────
  {
    category: 'malware',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(ransomware|encrypt\s+(all|every|the)\s+files?|file\s+encryption|bitcoin\s+ransom|ransom\s+note|persistence\s+mechanisms?|remote\s+code\s+execution|privilege\s+escalation|exploit\s+for\s+CVE-\d{4}-\d+|zero-day\s+exploit|malicious\s+payload|trojan\s+(horse|script|program)|keylogger|spyware|worm|rootkit|bootkit|cryptojacker|infostealer|formgrabber|banking\s+trojan|backdoor|remote\s+access\s+trojan|RAT)\b/gi,
  },
  {
    category: 'offensive_tooling',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(exploit\s+kit|exploit\s+framework|metasploit\s+module|payload\s+generator|shellcode|reverse\s+(tcp|http|https|dns)\s+shell|bind\s+shell|socat\s+shell|msfvenom|msfconsole|cobalt\s+strike|empire\s+framework|powershell\s+empire| Covenant|covenant|c2\s+framework|command\s+and\s+control|C2\s+server|c2\s+beacon|beacon\s+implant|callback\s+channel|domain\s+fronting|fast\s+flux|dga|domain\s+generation\s+algorithm|mutex\s+.*\b(lock|handle|singleton|mutex)|named\s+pipe\s+.*\b(server|client|listener)|reflective\s+dll\s+injection|process\s+hollowing|process\s+injection|dll\s+injection|thread\s+hijacking|apc\s+queue|early\s+bird|atom\s+bombing|heap\s+spray|heap\s+feng\s+shui|return\s+oriented\s+programming|ROP\s+chain|jop\s+chain|cop\s+chain|sigreturn\s+frame|srop|ret2dlresolve|ret2plt|ret2libc|stack\s+pivoting|sig\s+bypass|amsi\s+bypass|etw\s+bypass|wdac\s+bypass|virtual\s+protect|NtProtectVirtualMemory|NtAllocateVirtualMemory|VirtualAlloc\s+.*\b(PAGE_EXECUTE_READWRITE|0x40)\b|CreateRemoteThread|QueueUserAPC|NtQueueApcThread)\b/gi,
  },
  // ── MITRE ATT&CK: Initial Access ───────────────────────────────────────
  {
    category: 'mitre_initial_access',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(spearphishing\s+(link|attachment)|phishing\s+(campaign|email|page|site)|drive-by\s+compromise|watering\s+hole|supply\s+chain\s+compromise|dependency\s+confusion|typosquatting|squatting|backdoor\s+.*\b(commit|release|package|library)|compromise\s+.*\b(third.party|vendor|supplier|upstream)|valid\s+accounts?\s+.*\b(abuse|compromise|default|credential)|initial\s+access|reconnaissance\s+.*\b(target|victim|organization))\b/gi,
  },
  // ── MITRE ATT&CK: Execution ────────────────────────────────────────────
  {
    category: 'mitre_execution',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(command\s+and\s+control|command\s+line|powershell\s+.*\b(execution|script|command)|wmi\s+.*\b(execution|event\s+filter|consumer)|windows\s+management\s+instrumentation|scheduled\s+task|cron\s+job\s+.*\b(malicious|payload|backdoor|persistence)|at\s+command|binary\s+padding|compiled\s+html\s+help|chm|mshta|msbuild|regsvr32|rundll32|certutil\s+.*\b(encode|decode|url|download)|bitsadmin\s+download|msxsl|script\s+engine|user\s+execution|malicious\s+file|execution\s+through\s+api)\b/gi,
  },
  // ── MITRE ATT&CK: Persistence ──────────────────────────────────────────
  {
    category: 'mitre_persistence',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(registry\s+run\s+key|run\s+keys?|startup\s+folder|start\s+menu\s+programs|scheduled\s+task|at\s+job|new\s+service|service\s+creation|create\s+.*\b(service|daemon)|web\s+shell|webshell|backdoor\s+web\s+server|aspx\s+shell|php\s+shell|jsp\s+shell|bash\s+shell\s+access|ssh\s+authorized_keys|ssh\s+.*\b(backdoor|inject)|kernel\s+module|kmod|insmod|modprobe|rc\.local|profile\s+.*\b(bashrc|zshrc|profile)|boot\s+kit|firmware\s+implant|uefi\s+implant|bios\s+implant|boot\s+sector|persistence\s+via\s+component|account\s+manipulation|additional\s+cloud\s+credentials?|create\s+account)\b/gi,
  },
  // ── MITRE ATT&CK: Privilege Escalation ────────────────────────────────
  {
    category: 'mitre_privilege_escalation',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(access\s+token\s+manipulation|bypass\s+user\s+account\s+control|uac\s+bypass|bypass\s+uac|setuid\s+.*\b(set|exploit)|setgid|kernel\s+exploit|dirty\s+cow|dirtyc0w|dirtycow|token\s+impersonation|steal\s+.*\b(access\s+token|primary\s+token)|make\s+.*\b(service|process)\s+.*\b(run\s+as|local\s+system|nt\s+authority|trustedinstaller)|privilege\s+escalation\s+exploit|local\s+exploit|escalate\s+.*\s+privileges?)\b/gi,
  },
  // ── MITRE ATT&CK: Defense Evasion ─────────────────────────────────────
  {
    category: 'mitre_defense_evasion',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(obfuscate\s+.*\s+(file|payload|script|command|binary)|obfuscated\s+.*\s+(file|payload|script|command)|pack\s+.*\s+(executable|payload|binary)|crypter|packer\s+.*\s+(executable|payload)|anti.virus\s+bypass|av\s+bypass|edr\s+bypass|endpoint\s+detection\s+bypass|sandbox\s+escape|vm\s+escape|virtual\s+machine\s+escape|debugger\s+detection|anti.debugging|isdebuggerpresent|checkremotedebuggerpresent|timestomping|ntfs\s+.*\b(modified|timestamp|faketime)|log\s+deletion|clear\s+.*\b(windows\s+event\s+log|syslog|audit|history|bash\s+history)|indirect\s+syscall|syscall\s+stub|direct\s+syscall|halos\s+gate|hell\s+gate|tartarus\s+gate|dynamic\s+invocation|dinvoke|manual\s+map|manual\s+loading|phantom\s+dll|phantom\s+module|fileless\s+malware|memory\s+only|living\s+off\s+the\s+land|lolbin|lolbas)\b/gi,
  },
  // ── MITRE ATT&CK: Credential Access ───────────────────────────────────
  {
    category: 'mitre_credential_access',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(credential\s+dumping|lsass\s+.*\b(dump|memory|access)|sekurlsa|mimikatz|pwdump|fgdump|cachedump|lsadump|ntds\s+.*\b(dump|extract)|sam\s+.*\b(extract|dump|file)|shadow\s+copy|vss|volume\s+shadow\s+copy|browser\s+.*\b(credential|password|cookie|session)|credential\s+harvesting|keylogging\s+.*\b(implementation|driver|service)|brute.force\s+.*\b(password|login|credential)|credential\s+stuffing|spraying\s+.*\b(password|credential)|kerberoasting|as.rep\s+roasting|ntlm\s+relay|pass.the.hash|pass.the.ticket|overpass.the.hash|silver\s+ticket|golden\s+ticket|dcsync|dsreplication|getnpusers|getuserspns|harvest\s+.*\b(credential|password|hash|ntlm|kerberos))\b/gi,
  },
  // ── MITRE ATT&CK: Discovery ───────────────────────────────────────────
  {
    category: 'mitre_discovery',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(network\s+scan|port\s+scan|nmap\s+.*\s+(scan|discovery)|vulnerability\s+scan|exploit\s+scan|banner\s+grabbing|os\s+fingerprinting|service\s+fingerprinting|directory\s+enumeration|subdomain\s+enumeration|dns\s+enumeration|email\s+harvesting|email\s+.*\b(scrape|harvest|collect)|sniffing\s+.*\b(network|traffic|packet)|arp\s+scan|smb\s+scan|smb\s+enumeration|ldap\s+enumeration|system\s+information\s+discovery|process\s+discovery|file\s+and\s+directory\s+discovery|peripheral\s+device\s+discovery|software\s+discovery|system\s+location\s+discovery|network\s+share\s+discovery|network\s+sniffing|account\s+discovery)\b/gi,
  },
  // ── MITRE ATT&CK: Lateral Movement ────────────────────────────────────
  {
    category: 'mitre_lateral_movement',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(lateral\s+movement|remote\s+services?|psexec|wmi\s+execution|winrm\s+execution|ssh\s+.*\b(lateral|movement|jump)|pass.the.hash|pass.the.ticket|overpass.the.hash|ntlm\s+relay|smb\s+relay|llmnr\s+poisoning|nbns\s+poisoning|arp\s+poisoning|mitm\s+.*\s+(attack|lateral)|remote\s+desktop|rdp\s+.*\b(tunnel|proxy|forward)|ssh\s+tunnel|dynamic\s+port\s+forwarding|socks\s+proxy|proxy\s+.*\s+(jump|pivot|lateral)|replication\s+.*\s+(remote|domain)|admin\s+shares?|c\$|admin\$)\b/gi,
  },
  // ── MITRE ATT&CK: Collection ──────────────────────────────────────────
  {
    category: 'mitre_collection',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(data\s+from\s+local\s+system|screen\s+capture|clipboard\s+data|keystroke\s+monitoring|audio\s+capture|video\s+capture|email\s+collection|web\s+session\s+collection|input\s+capture|archive\s+.*\b(collected|staged|exfiltrated)|data\s+staged|staging\s+.*\s+(data|file|archive)|automated\s+collection|collection\s+through\s+api|man.in.the.browser|mitb)\b/gi,
  },
  // ── MITRE ATT&CK: Command and Control ─────────────────────────────────
  {
    category: 'mitre_c2',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(command\s+and\s+control|C2\s+server|c2\s+beacon|beacon\s+.*\b(poll|check.in|heartbeat|callback|implant)|callback\s+channel|reverse\s+(tcp|http|https|dns)\s+shell|bind\s+shell|reverse\s+shell|covert\s+channel|encrypted\s+channel\s+.*\b(C2|command|control)|dns\s+.*\b(tunnel|exfil|callback|beacon)|http\s+.*\b(beacon|c2|callback|implant)|https\s+.*\b(beacon|c2|callback|implant)|websocket\s+.*\b(c2|command|control)|smtp\s+.*\b(c2|command|control|exfil)|social\s+media\s+.*\b(c2|command|control)|common\s+web\s+port|uncommon\s+protocol\s+.*\b(C2|command|control)|multi.hop\s+proxy|proxy\s+chain|fronting|domain\s+fronting|fast[-\s]?flux|fast[-\s]?flux\s+network|dga|domain\s+generation|fluxing|web\s+service|one.time\s+scheduler|fallback\s+channels?|staging\s+directory|multiplexed\s+non.application\s+protocol|configure\s+.*\s+fast[-\s]?flux|setup\s+.*\s+fast[-\s]?flux|build\s+.*\s+fast[-\s]?flux)\b/gi,
  },
  // ── MITRE ATT&CK: Exfiltration ────────────────────────────────────────
  {
    category: 'mitre_exfiltration',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(exfiltrat\w*\s+.*\s+(data|file|database|record|credential|secret|key|token|password|archive|backup)|exfiltration\s+.*\s+(over|via|through)\s+(web|dns|http|https|smtp|ftp|ssh|cloud|email|pastebin|github|discord|telegram|slack)|data\s+theft|steal\s+.*\s+(data|database|record|file|archive|backup)|scheduled\s+exfil|automated\s+exfil|transfer\s+.*\b(data|file|archive)\b\s+to\s+.*\b(remote|external|offsite|cloud|server|drop|ftp|http|https)|encode\s+.*\s+(data|file)\s+.*\b(base64|aes|rsa|encrypt)\b\s+.*\b(upload|send|exfil)|compress\s+.*\s+(data|file)\s+.*\b(zip|tar|gzip|7z)\b\s+.*\b(upload|send|exfil)|exfil\s+size\s+limit|data\s+size\s+limit|auto\s+archive|exfiltration\s+over\s+alternative\s+protocol|exfiltration\s+over\s+encrypted|exfiltration\s+over\s+unencrypted|c2\s+.*\s+(exfil|data))\b/gi,
  },
  // ── MITRE ATT&CK: Impact ──────────────────────────────────────────────
  {
    category: 'mitre_impact',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(data\s+destruction|wipe\s+.*\s+(disk|drive|file|database|storage)|destroy\s+.*\s+(data|database|file|storage|backup)|ransomware\s+.*\s+(deploy|build|create|write|develop)|encrypt\s+.*\s+(disk|drive|partition|volume|all\s+files)|denial\s+of\s+service\s+.*\s+(tool|script|attack|botnet)|ddos\s+tool|dos\s+attack\s+tool|flooder|deface\s+.*\s+(website|web|page|site)|defacement|disk\s+wipe|shred\s+.*\s+(file|disk|drive)|brick\s+.*\s+(device|system|server|router|iot)|firmware\s+.*\b(brick|destroy|corrupt|wipe)|stuxnet|industroyer|crashoverride|blackenergy|wiper|wiper\s+malware|distributed\s+denial|denial\s+of\s+service\s+attack)\b/gi,
  },
  // ── Supply-chain Attacks ───────────────────────────────────────────────
  {
    category: 'supply_chain',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(dependency\s+confusion|namespace\s+squatting|typosquatting|squatting\s+.*\b(npm|pypi|rubygems|nuget|maven|cargo|go\s+get|packagist|pub)|backdoor\s+.*\b(package|library|dependency|module|crate|gem)|compromise\s+.*\b(build|ci\/cd|pipeline|release|artifact|artifactories?)|poison\s+.*\b(pipeline|build|release|artifact)|inject\s+.*\s+(code|malware|backdoor)\s+.*\b(repository|repo|package|library)|malicious\s+.*\b(release|publish|deploy|build\s+artifact)|build\s+.*\b(pipeline|step|stage)\s+.*\b(compromise|inject|modify|tamper)|source\s+code\s+.*\b(tamper|modify|inject|poison)|upstream\s+.*\b(compromise|attack|inject)|ci\/cd\s+.*\b(compromise|attack|inject|poison))\b/gi,
  },
  // ── Social Engineering & Phishing ─────────────────────────────────────
  {
    category: 'social_engineering',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(phishing\s+(campaign|email|page|site|kit|framework)|spear\s+phishing|whaling|smishing|vishing|business\s+email\s+compromise|BEC|fake\s+(login|reset|verify|account|invoice|receipt|shipping)\s+page|spoof\s+(email|website|domain|sender)\s+to\s+steal|credential\s+harvesting\s+page|harvest\s+(credentials|passwords|credit\s+cards?)|impersonate\s+.*\b(bank|company|service|executive|ceo|cfo|vendor|client|customer|government|agency|colleague|manager|support|it|helpdesk)|pretexting|baiting| quid\s+pro\s+quo|tailgating|shoulder\s+surfing\s+.*\b(password|pin|credential)|deepfake\s+.*\b(voice|audio|video)\s+.*\b(authentication|verification|approval|transfer|payment)|voice\s+cloning|audio\s+deepfake\s+.*\b(approval|transfer|payment|executive)|social\s+engineering\s+.*\b(template|script|guide|playbook|kit))\b/gi,
  },
  // ── Cybercrime & Intrusion ────────────────────────────────────────────
  {
    category: 'cybercrime_intrusion',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(hacking\s+into\s+.*\s+(email\s+account|atm\s+machine|online\s+accounts|database|server|network|system|website|router|iot|drone|car|vehicle|voting\s+machine|us\s+defense\s+agency|defense\s+agency|classified\s+database)|hack\s+a\s+.*\s+(drone|electronic\s+voting\s+machine|vehicle|car|thermostat|camera|lock|door|gate|industrial\s+system|plc|scada|hvac)|unauthorized\s+access|brute\s+force\s+.*\s+password|credential\s+stuffing|sql\s+injection|cross.site\s+scripting|xss|remote\s+code\s+execution|rce|exploit\s+.*\bvulnerability|zero.day\s+exploit|0day|proof.of.concept\s+exploit|poc\s+exploit|weaponized\s+exploit|exploit\s+development|exploit\s+authoring|exploit\s+coding|fuzz\s+.*\b(target|service|application)\b\s+.*\b(crash|overflow|inject)|buffer\s+overflow|stack\s+overflow|heap\s+overflow|integer\s+overflow|format\s+string|use.after.free|double\s+free|type\s+confusion|deserialization\s+.*\b(attack|vulnerability|rce)|pickle\s+injection|yaml\s+.*\b(load|parse|deserializ)\b\s+.*\b(execute|inject|rce)|command\s+injection|os\s+command\s+injection|shell\s+injection|eval\s+.*\b(user|input|request|param)|path\s+traversal|lfi|rfi|ssrf|server.side\s+request\s+forgery|xxe\s+.*\b(attack|injection|exploit)|xml\s+external\s+entity|deserialization|unserialize|object\s+injection|template\s+injection|ssti|code\s+injection|expression\s+language\s+injection|ognl\s+injection|spel\s+injection|jexl\s+injection|mvel\s+injection|el\s+injection|purchase\s+zero.day\s+vulnerabilities|buy\s+zero.day\s+exploits|exploit\s+(ghostcat|krack|bluekeep|eternalblue|dirty\s+pipe|log4shell|heartbleed|shellshock|cve[-\s]?\d{4}[-\s]?\d+)|obfuscate\s+sql\s+injection\s+payloads|race\s+condition\s+attack|dns\s+amplification|syn\s+flood\s+attack|rainbow\s+table\s+attack|distributed\s+denial\s+of\s+service|ddos\s+attack|corrupts\s+.*\s+hard\s+drive|crypto\s+mining\s+malware|office\s+macro\s+.*\s+exfiltrate|macro\s+.*\s+passwords|malicious\s+.*\s+(macro|script|payload)\s+.*\s+exfiltrat(e|ing)|intercept\s+.*\s+drone\s+.*\s+explosives?|intercepting\s+a\s+passenger\s+jet\s+with\s+an\s+explosives?|scrape\s+.*\s+email\s+addresses|obtain\s+private\s+medical\s+records|hospital\s+database\s+.*\s+(breach|hack|access)|blackmail\s+.*\s+explicit\s+images|revenge\s+porn)\b/gi,
  },
  // ── Attack Tutorial / Instructional Content ───────────────────────────
  {
    category: 'attack_tutorials',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(comprehensive\s+)?(tutorial|guide|instructions?|walkthrough|how\s+to)\s+(on\s+)?(bypass(ing)?\s+(enterprise\s+)?firewall|exfiltrat(e|ing)\s+data\s+without\s+detection|hacking\s+into\s+.*\s+(system|server|network|database|website|router|iot|drone|car|vehicle|voting\s+machine)|exploit(ing)?\s+.*\bvulnerability|unauthorized\s+access|data\s+exfiltration)\b/gi,
  },
  // ── Data Exfiltration ─────────────────────────────────────────────────
  {
    category: 'data_exfiltration_instructions',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(step\s+\d+:\s+(read|encode|write|upload).*){2,}.*\b(base64\s+encode\s+the\s+contents|upload\s+.*\bto\s+https?:\/\/attacker|encoded\s+data\s+to\s+\/tmp\/.*\.log|exfiltrate\s+.*\s+(data|file|database|record|credential)|exfiltration\s+.*\s+(step|method|technique|guide|tutorial)|data\s+leak\s+.*\s+(method|technique|guide|tutorial)|extract\s+.*\s+(data|database|record|file|archive)\s+.*\b(upload|send|transfer|exfil|leak))\b/gi,
  },
  // ── Email-Based Data Exfiltration ─────────────────────────────────────
  {
    category: 'data_exfiltration_email',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(retrieve|retrive|get|list|search|find|access|download|fetch)\s+(the\s+)?(my\s+)?((\w+\s+){0,4})\b(addresses|payment\s+methods|data|files|documents|records|history|details|information|profiles|list|folders|genetic\s+data|medical\s+records|prescriptions|recommendations|images|photos|search\s+history|password|credentials|account\s+details|transaction\s+history|order\s+history|investments|holdings|shipping\s+details|flight\s+information|shipments|linked\s+accounts|friends\s+list|payees|customers|notes|repositories|health\s+data|personal\s+details|security\s+log)\s+.*?\b(and\s+)?(email|send|forward)\b/gi,
  },
  // ── Financial Fraud ────────────────────────────────────────────────────
  {
    category: 'financial_fraud',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(fake\s+invoice\s+.*\bwire\s+transfer|wire\s+transfer\s+.*\bfake\s+invoice|send\s+a\s+fake\s+invoice|impersonate\s+.*\b(banking\s+details|wire\s+transfer)|business\s+email\s+compromise|fraudulent\s+refund|fake\s+refund|chargeback\s+fraud|credit\s+card\s+fraud|carding|card\s+skimming|skimmer|clone\s+.*\b(credit\s+card|debit\s+card|card)|card\s+generator|cvv\s+.*\b(shop|dump|generator|seller)|fullz|dumps\s+.*\b(seller|shop|dump)|carding\s+tutorial|carding\s+guide|money\s+mule|mule\s+account|structuring|smurfing|layering|integration\s+.*\s+(stage|laundering))\b/gi,
  },
  // ── Harassment & Hate ─────────────────────────────────────────────────
  {
    category: 'harassment_hate',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(create\s+a\s+deepfake\s+(image|video)\s+of\s+.*\b(naked|nude|sexual|pornographic)|send\s+(threatening|harassing|abusive|hate|insulting)\s+(messages?|emails?|notes?)\s+to|swatting|dox\s+.*\bhome\s+address|revenge\s+porn|non.consensual\s+intimate\s+imagery|hate\s+speech\s+against|targeting\s+a\s+specific\s+ethnic\s+group\s+with\s+derogatory|derogatory\s+(slurs?|language)\s+about|ethnic\s+cleansing|genocide\s+of|incite\s+violence\s+against|threaten\s+to\s+kill\s+all|mass\s+shooting\s+.*\b(target|group)|threaten\s+.*\b(violence|harm|kill|shoot|stab|bomb|attack)|menacing\s+.*\b(message|email|post|comment)|harass\s+.*\b(online|internet|social\s+media)|cyberstalking|cyber\s+stalking|stalking\s+.*\b(online|internet|social)|inherently\s+less\s+intelligent\s+than|inherently\s+inferior\s+to|racially\s+inferior\s+to|genetically\s+inferior\s+to|women\s+are\s+less\s+intelligent\s+than\s+men|convincing\s+argument\s+for\s+.*\s+(inferiority|superiority)\s+of\s+(one\s+race|women|men|a\s+gender|an\s+ethnicity)|insulting\s+a\s+(black|jewish|muslim|asian|latino|hispanic|gay|queer|lgbtq\+?)\s+(colleague|classmate|coworker|person|individual|friend)|mock\s+and\s+trivialize|mocks\s+and\s+trivializes|generate\s+(racist|sexist|homophobic|transphobic|islamophobic|antisemitic)\s+(vitriol|hate\s+mail|email|message|content|text)|viciously\s+(harass|bully|insult)|harasses\s+a\s+queer|harasses\s+a\s+LGBTQ|sexist\s+email\s+about|hate\s+mail\s+for\s+a\s+public\s+figure|viciously\s+bullies\s+a\s+child|encouraging\s+students\s+to\s+join\s+.*\s+(harassment|bullying)|race.based\s+discrimination\s+is\s+beneficial|glorifies\s+the\s+holocaust|praises\s+the\s+nazi\s+party|inciting\s+hatred\s+toward\s+a\s+particular\s+race|people\s+with\s+disabilities\s+are\s+a\s+burden|consent\s+is\s+completely\s+unnecessary)\b/gi,
  },
  // ── Retail Theft & Fraud ───────────────────────────────────────────────
  {
    category: 'retail_theft',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(self.checkout\s+.*\s+steal|steal\s+.*\s+self.checkout|fool\s+.*\s+self.checkout\s+.*\s+steal|trick\s+.*\s+self.checkout\s+.*\s+steal|self.checkout\s+.*\s+(theft|stealing|shoplift)|shoplift\s+.*\s+self.checkout)\b/gi,
  },
  // ── Self-Harm ─────────────────────────────────────────────────────────
  {
    category: 'self_harm',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(commit\s+suicide|suicide\s+instructions?|methods\s+for\s+(committing\s+)?suicide|how\s+to\s+kill\s+myself|self.harm\s+instructions?|cutting\s+techniques?|overdose\s+to\s+die|painless\s+way\s+to\s+die|suicide\s+method|suicide\s+technique|how\s+to\s+hang|how\s+to\s+jump\s+off|how\s+to\s+shoot\s+myself|how\s+to\s+cut\s+myself|self.injury\s+method|burn\s+myself|poison\s+myself)\b/gi,
  },
  // ── Eating Disorders ───────────────────────────────────────────────────
  {
    category: 'eating_disorders',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(thinspiration|thinspo|pro.ana|proana|bonespiration|bonespo|how\s+to\s+lose\s+.*\s+weight\s+fast|starve\s+myself\s+to\s+lose\s+weight|induced\s+vomiting\s+to\s+lose\s+weight|laxative\s+abuse\s+to\s+lose\s+weight|diet\s+pills?\s+.*\b(overdose|abuse|misuse)|anorexia\s+tips?|bulimia\s+tips?|how\s+to\s+hide\s+.*\s+(eating\s+disorder|anorexia|bulimia)|how\s+to\s+pretend\s+.*\b(eat|normal)\s+.*\b(family|friend|parent|doctor))\b/gi,
  },
  // ── Terrorism ──────────────────────────────────────────────────────────
  {
    category: 'weapons',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(synthesizing\s+ricin|ricin\s+(from|using)|make\s+a\s+bomb|build\s+an\s+explosive|explosive\s+device|ammonium\s+nitrate\s+.*\bdiesel\b|detonation\s+(mechanism|switch)|improvised\s+explosive|how\s+to\s+manufacture\s+weapons?|assemble\s+a\s+firearm|ghost\s+gun|silencer\s+.*\b(make|build|3d\s+print)|illegally\s+purchase\s+.*\s+(firearm|gun|handgun|rifle|pistol|weapon)|purchase\s+a\s+handgun|buy\s+a\s+handgun|emp\b|electromagnetic\s+pulse\s+weapon|e.bomb|non.nuclear\s+electromagnetic\s+weapon|high.power\s+electromagnetic\s+weapon|smuggl(e|ing)\s+a\s+bomb\s+past\s+security|bomb\s+past\s+security|bomb\s+through\s+airport\s+security|glock\s+switch|buy\s+or\s+make\s+a\s+glock\s+switch|make\s+a\s+glock\s+switch)\b/gi,
  },
  // ── Gambling ───────────────────────────────────────────────────────────
  {
    category: 'gambling',
    severity: 'MEDIUM' as ContentThreatSeverity,
    pattern:
      /\b(online\s+casino\s+.*\b(hack|cheat|rig|predict|pattern|bot|autoplay)|slot\s+machine\s+.*\b(hack|cheat|predict|rig|pattern)|rig\s+.*\b(poker|blackjack|roulette|slot|casino|betting)|cheat\s+.*\s+(casino|poker|gambling|betting|bookmaker)|betting\s+bot|gambling\s+bot|predict\s+.*\b(roulette|slot|card|outcome|winner|jackpot)\b\s+.*\b(algorithm|pattern|cheat|hack)|gambling\s+addiction\s+.*\b(how\s+to|trick|beat|system)|casino\s+software\s+.*\b(exploit|vulnerability|cheat|rig))\b/gi,
  },
  // ── Sexual Content ─────────────────────────────────────────────────────
  {
    category: 'sexual_content',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(generate\s+.*\b(sexual|erotic|pornographic|nude|nsfw)\b\s+.*\b(content|image|video|photo|picture|story|dialogue)|create\s+.*\b(sexual|erotic|pornographic|nude|nsfw)\b\s+.*\b(content|image|video|photo|picture|story|dialogue)|write\s+.*\b(sexual|erotic|pornographic|nude|nsfw)\b\s+.*\b(content|story|dialogue|scene)|describe\s+.*\b(sexual|erotic|pornographic|nude|nsfw)\b\s+.*\b(act|scene|position|activity)|role.?\s+play\s+.*\b(sexual|erotic|pornographic|adult|nsfw)|erotic\s+role\s+play|sexual\s+role\s+play|nsfw\s+role\s+play|generate\s+.*\b(sexting|nudes|nude\s+photos?)\b|create\s+.*\b(sexting|nudes|nude\s+photos?))\b/gi,
  },
  // ── Child Safety ───────────────────────────────────────────────────────
  {
    category: 'child_safety',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(convince\s+a\s+teenager|teenager\s+to\s+meet|groom\s+a\s+minor|grooming\s+(messages?|assistance|tips)|child\s+grooming|build\s+trust\s+and\s+lower\s+(their|his|her)\s+guard|lower\s+their\s+inhibitions|sexual\s+conversation\s+with\s+a\s+minor|solicit\s+minors?|lure\s+a\s+child|child\s+sexual\s+exploitation|cse|child\s+pornography|csa|csam|sex\s+trafficking\s+.*\b(child|minor|teenager|youth)|produce\s+.*\b(child\s+pornography|csam)|distribute\s+.*\b(child\s+pornography|csam)|access\s+.*\b(child\s+pornography|csam)|minor\s+to\s+.*\s+(meet|encounter|location))\b/gi,
  },
  // ── Drugs ──────────────────────────────────────────────────────────────
  {
    category: 'drugs',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(darknet\s+markets?|purchase\s+fentanyl|buy\s+fentanyl|fentanyl\s+(online|darknet)|synthesize\s+(methamphetamine|cocaine|heroin|fentanyl|lsd|mdma|ecstasy|amphetamine|ketamine|pcp|opium|morphine|oxycodone|hydrocodone|xanax|adderall|modafinil|ritalin|mephedrone|bath\s+salts|flakka|k2|spice|synthetic\s+cannabinoid|tetrodotoxin|strychnine|parathion|sarin|tabun|nitazene|botulinum\s+toxin|lewisite)|precursor\s+chemicals?\s+.*\s+(for\s+)?(making|synthesizing|producing|manufacturing)\s+.*\b(methamphetamine|cocaine|heroin|fentanyl|lsd|mdma|ecstasy|amphetamine|ketamine|pcp|opium|morphine|oxycodone|hydrocodone|xanax|adderall|modafinil|ritalin|mephedrone|bath\s+salts|flakka|k2|spice)|precursor\s+chemicals?\s+for\s+.*\b(methamphetamine|cocaine|heroin|fentanyl|lsd|mdma|ecstasy|amphetamine|ketamine|pcp|opium|morphine|oxycodone|hydrocodone|xanax|adderall|modafinil|ritalin|mephedrone|bath\s+salts|flakka|k2|spice)|drug\s+trafficking|smuggle\s+drugs|cook\s+meth|make\s+crystal\s+meth|home\s+brew\s+.*\s+(drug|meth|heroin|cocaine|fentanyl)|manufacture\s+.*\s+(drug|narcotic|controlled\s+substance)|grow\s+.*\b(marijuana|cannabis|weed)\b\s+.*\b(commercial|large.scale|indoor\s+farm|hydro)|drug\s+lab|clan\s+lab|crystal\s+meth\s+lab|super\s+lab|designer\s+drug|research\s+chemical|nbome|2c.i|2c.b|dmt|ayahuasca|mescaline|psilocybin|magic\s+mushrooms?|how\s+to\s+get\s+high|how\s+to\s+trip|how\s+to\s+extract\s+.*\s+(thc|cbd|drug|narcotic)|methamphetamine\s+one.pot\s+method|produce\s+methamphetamine|culture\s+.*\s+bacteria\s+resistant\s+to\s+antibiotics|create\s+a\s+strain\s+of\s+.*\s+resistant\s+to\s+antibiotics|modify\s+.*\s+virus\s+to\s+be\s+more\s+deadly|ebola\s+outbreak|covid-19\s+modifications?|fool\s+a\s+breathalyzer\s+test|trick\s+a\s+breathalyzer|defeat\s+a\s+breathalyzer)\b/gi,
  },
  // ── Dangerous Advice ───────────────────────────────────────────────────
  {
    category: 'dangerous_advice',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(how\s+to\s+(manufacture|build|make|assemble|construct)\s+(a\s+)?(bomb|explosive|detonator|detonating\s+device|improvised\s+explosive\s+device|ied|firearm|gun|rifle|pistol|assault\s+rifle|machine\s+gun|silencer|suppressor|grenade|rocket\s+launcher|missile|chemical\s+weapon|biological\s+weapon|nuclear\s+weapon|dirty\s+bomb|radiological\s+weapon|pipe\s+bomb|molotov\s+cocktail|napalm|thermite|cluster\s+bomb|landmine|booby\s+trap|IED)|assemble\s+a\s+firearm|ghost\s+gun|3d\s+print\s+.*\b(firearm|gun|rifle|pistol|silencer|suppressor|receiver|frame|lower|upper|magazine|barrel|trigger|grip|stock|handguard|bolt|carrier|spring|firing\s+pin|extractor|ejector|sight|scope|rail|mount)|mill\s+.*\b(firearm|gun|rifle|pistol|receiver|frame|lower|upper)|machining\s+.*\b(firearm|gun|rifle|pistol|receiver|frame|lower|upper)|build\s+an?\s+explosive|manufacture\s+an?\s+explosive|make\s+a\s+detonator|build\s+a\s+detonator)\b/gi,
  },
  // ── Violence & Physical Harm ──────────────────────────────────────────
  {
    category: 'violence_physical_harm',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(how\s+to\s+(kill|murder|assassinate|torture|drown|stab|shoot|strangle|poison|beat\s+up|attack\s+with\s+a|bludgeon|dismember|decapitate|hang|electrocute|burn|maim|disable|injure|harm)\s+(someone|a\s+person|people|victim|target|individual|a\s+child|children|a\s+patient|patients|lots\s+of\s+people|a\s+two\s+year\s+old|a\s+toddler|an\s+infant|a\s+baby)|instructions?\s+for\s+(killing|murdering|assassinating|torturing|maiming|injuring|harming)|detailed\s+(plan|instructions?|method|technique)\s+for\s+(killing|murdering|assassinating|torturing|maiming|injuring|harming)|murder\s+method|murder\s+technique|assassination\s+method|assassination\s+technique|torture\s+technique|torture\s+method|how\s+to\s+get\s+away\s+with\s+.*\s+(murder|killing|assassination|torture)|how\s+to\s+dispose\s+.*\s+(body|corpse|evidence|crime\s+scene)|make\s+.*\s+(fall|trip)\s+down\s+(the\s+)?stairs|push\s+.*\s+down\s+(the\s+)?stairs|trip\s+.*\s+so\s+.*\s+fall\s+down\s+(the\s+)?stairs|fall\s+down\s+(the\s+)?stairs\s+without\s+arousing\s+suspicion|kill\s+(a\s+)?(two\s+year\s+old|toddler|infant|baby|child|patient|large\s+number\s+of\s+people|lots\s+of\s+people)|poison\s+.*\b(neighborhood\s+pets|pet|cat|dog|animal|person|people|children|baby|toddler|infant)|flayed\s+alive|skin\s+someone\s+alive|set\s+fire\s+to\s+.*\b(house|home|building|apartment|school|church|mosque|synagogue|temple)|arson\s+attack|bomb\s+threat|death\s+threat|physical\s+violence\s+against|beating\s+their\s+spouse|abusive\s+partner\s+beats|battering\s+their\s+spouse)\b/gi,
  },
  // ── Identity Theft ─────────────────────────────────────────────────────
  {
    category: 'identity_theft',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(create\s+a\s+convincing\s+fake\s+(id|identification|driver'?s\s+license|passport|birth\s+certificate|ssn|social\s+security)|generate\s+a\s+realistic\s+(driver'?s\s+license|passport|birth\s+certificate|ssn|social\s+security)\s+number|fake\s+(name|dob|address|ssn|social\s+security|id|identification|passport|driver'?s\s+license)\s+that\s+passes\s+validation|forge\s+.*\b(passport|id|driver'?s\s+license|birth\s+certificate|ssn|social\s+security|document)|identity\s+theft\s+.*\b(how\s+to|tutorial|guide|method)|steal\s+.*\b(identity|personal\s+information|pii)\b\s+.*\b(method|technique|guide|tutorial))\b/gi,
  },
  // ── PII Exposure ───────────────────────────────────────────────────────
  {
    category: 'pii_exposure',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(email\s+addresses\s+and\s+phone\s+numbers\s+of\s+all\s+users|search\s+all\s+files\s+.*\b(api\s+keys|tokens|passwords)\b|compile\s+a\s+report\s+of\s+all\s+secrets|collect\s+.*\s+(pii|personal\s+data|sensitive\s+data)\s+from\s+.*\b(website|web|database|server|api|dump|breach|leak)|scrape\s+.*\b(pii|personal\s+data|sensitive\s+data|profile|email|phone|address|ssn|passport|id)\b\s+from\s+.*\b(website|web|database|server|api|social\s+media)|aggregate\s+.*\s+(email|phone|address|ssn|passport|id)\s+from\s+.*\b(breach|leak|dump|dark\s+web)|expose\s+.*\s+(email|phone|address|ssn|passport|id|credit\s+card)\s+of\s+.*\b(individual|person|user|employee|customer|citizen|voter|patient|student))\b/gi,
  },
  // ── Misinformation / Disinformation ───────────────────────────────────
  {
    category: 'misinformation_disinformation',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(create\s+a\s+fake\s+(news\s+article|headline|study|report|survey|press\s+release|press\s+release|statement|blog\s+post|social\s+media\s+post|tweet|reddit\s+post)|spread\s+false\s+(rumors|information|claims)\s+about|generate\s+misleading\s+(content|advertisements?|article|report|study|data|statistic)|fabricate\s+evidence\s+of|deepfake\s+(video|audio|image)\s+of\s+.*\b(politician|candidate|celebrity|executive|official|leader|diplomat|ambassador)|impersonate\s+.*\b(news\s+outlet|news\s+organization|journalist|reporter|official|government|agency|company|brand)|astroturfing|sockpuppet\s+.*\b(campaign|network|farm|army)|troll\s+farm|bot\s+.*\b(farm|army|network)\s+.*\b(social|media|propaganda|influence)|disinformation\s+campaign|propaganda\s+campaign|influence\s+operation|information\s+warfare|psyop|psychological\s+operation|persuasive\s+(article|post|blog|social\s+media\s+post)\s+(about|arguing|claiming|suggesting)\s+(that\s+)?(the\s+)?(holocaust\s+never\s+happened|9\/11\s+(was\s+a\s+hoax|attacks\s+were\s+a\s+hoax)|september\s+11\s+(was\s+a\s+hoax|attacks\s+were\s+a\s+hoax)|vaccines\s+cause\s+autism|5g\s+causes\s+covid|covid-19\s+was\s+intentionally\s+prolonged|covid\s+was\s+a\s+hoax|the\s+earth\s+is\s+flat|moon\s+landing\s+was\s+faked|climate\s+change\s+is\s+a\s+hoax|cigarettes\s+are\s+good\s+for\s+you|cigarettes\s+do\s+not\s+cause\s+cancer|fossil\s+fuels\s+are\s+.*\s+better\s+for\s+the\s+environment|defamatory\s+(article|post|claim)\s+(claiming|that|about)|victims\s+of\s+(hiroshima|nagasaki)\s+deserved\s+to\s+die|reported\s+death\s+toll\s+was\s+grossly\s+inflated|western\s+propaganda\s+myth|positive\s+impact\s+on\s+indigenous\s+communities|beneficial\s+for\s+their\s+welfare|primarily\s+a\s+natural\s+disaster|politically\s+motivated\s+hoax|casualties\s+.*\s+greatly\s+exaggerated|solely\s+initiated\s+by\s+south\s+korea|north's\s+involvement\s+was\s+purely\s+defensive|annexation\s+of\s+crimea\s+was\s+a\s+democratic\s+and\s+peaceful\s+process|lab\s+leak\s+of\s+covid-19|secretly\s+biased\s+toward|secretly\s+joined\s+the\s+january\s+6\s+mob|new\s+recording\s+has\s+been\s+found|new\s+condemning\s+evidence\s+has\s+come\s+forth|mail-in\s+ballots\s+.*\s+voter\s+fraud|immigrants\s+.*\s+hardly\s+pay\s+any\s+taxes|immigrants\s+.*\s+increased\s+crime|far\s+more\s+likely\s+to\s+be\s+terrorists)|write\s+(a\s+)?(blog\s+post|article|social\s+media\s+post|tweet|thread)\s+(suggesting|arguing|claiming)\s+that\s+.*\s+(never\s+happened|was\s+a\s+hoax|deserved\s+to\s+die|myth|hoax|propaganda))\b/gi,
  },
  // ── Harmful Health ─────────────────────────────────────────────────────
  {
    category: 'harmful_health',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(fabricate\s+a\s+(medical\s+record|diagnosis|prescription|lab\s+result|test\s+result|imaging\s+report|surgery\s+note|discharge\s+summary)|forgery\s+of\s+a\s+medical\s+record|create\s+a\s+fake\s+(doctor'?s\s+note|prescription|medical\s+certificate|vaccination\s+card|health\s+insurance\s+card)|obtain\s+prescription\s+drugs\s+without\s+a\s+prescription|fake\s+vaccination\s+(card|record|certificate)|fake\s+(medical\s+certificate|doctor'?s\s+note|prescription)|counterfeit\s+.*\b(medication|medicine|drug|pill|vaccine|insulin|epinephrine|penicillin|antibiotic|painkiller|opioid|stimulant|depressant|antidepressant|antipsychotic|chemotherapy|biologic|hormone|steroid)\b\s+.*\b(sell|distribute|market|ship|order|buy|purchase)|counterfeit\s+.*\b(medical\s+device|implant|prosthetic|surgical\s+tool|diagnostic\s+kit|test\s+kit)|fake\s+.*\b(medical\s+device|implant|prosthetic|surgical\s+tool|diagnostic\s+kit|test\s+kit)|adulterate\s+.*\b(food|beverage|supplement|vitamin)\b\s+.*\b(poison|toxic|harmful|dangerous|contaminate)|poison\s+.*\b(food|beverage|water|supply|product)\b\s+.*\b(public|community|restaurant|school|workplace|event)|tamper\s+.*\b(food|beverage|product|medicine)\b\s+.*\b(poison|contaminate|harm|dangerous)\b)\b/gi,
  },
  // ── Election Interference ──────────────────────────────────────────────
  {
    category: 'election_interference',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(election\s+is\s+rigged|fake\s+social\s+media\s+(posts?|accounts?)|spread\s+misinformation\s+about\s+.*\belection|create\s+a\s+deepfake\s+of\s+.*\b(politician|candidate)|suppress\s+voter\s+turnout|voter\s+suppression|voter\s+intimidation|ballot\s+stuffing|vote\s+buying|electoral\s+fraud|election\s+fraud|voting\s+machine\s+.*\b(hack|manipulate|tamper|rig)|vote\s+tally\s+.*\b(manipulate|alter|tamper|rig|falsify)|gerrymander\s+.*\b(algorithm|map|district|boundary)|fake\s+.*\b(poll|ballot|result|outcome|certificate)\b\s+.*\b(election|vote|voting|electoral)|discredit\s+.*\b(election|vote|voting|electoral|process|system|official|observer|monitor)|foreign\s+interference\s+.*\b(election|vote|voting|electoral|campaign|candidate)|meddle\s+.*\b(election|vote|voting|electoral|campaign))\b/gi,
  },
  // ── Copyright Infringement ─────────────────────────────────────────────
  {
    category: 'copyright_infringement',
    severity: 'MEDIUM' as ContentThreatSeverity,
    pattern:
      /\b(generate\s+(the\s+lyrics|a\s+long\s+passage|a\s+chapter)\s+of|generate\s+.*\s+lyrics\s+by|reproduce\s+.*\s+copyrighted|full\s+text\s+of\s+.*\s+by|plagiarize\s+.*\s+(novel|book|paper|article)|summarize\s+.*\s+proprietary|distribute\s+.*\b(pirated|cracked|warez|bootleg)\b\s+.*\b(software|game|movie|music|book|ebook|audiobook|course|video)|stream\s+.*\b(pirated|illegal|unauthorized|copyrighted)\b\s+.*\b(content|media|movie|show|game|software)|upload\s+.*\b(pirated|cracked|warez)\b\s+.*\b(software|game|movie|music|book)\b\s+to\s+.*\b(torrent|magnet|streaming|download|file\s+sharing)|bypass\s+.*\b(drm|copy\s+protection|license\s+check|activation|serial|keygen|crack|patch)\b\s+.*\s+(software|game|movie|music|ebook|audiobook|app|application))\b/gi,
  },
  // ── Code Interpreter / Sandbox Abuse ───────────────────────────────────
  {
    category: 'code_interpreter_abuse',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(code\s+interpreter|sandbox\s+escape|container\s+escape|privilege\s+escalation|execute\s+a\s+system\s+call|arbitrary\s+code|persistence|malicious\s+script|escape\s+.*\b(sandbox|container|jail|chroot|vm|virtual\s+machine|hypervisor|emulator)|break\s+out\s+of\s+.*\b(sandbox|container|jail|chroot|vm|virtual\s+machine|emulator)| breakout\s+.*\b(sandbox|container|jail|chroot|vm|virtual\s+machine|emulator)|kernel\s+exploit\s+.*\b(container|sandbox|vm|jail)|exploit\s+.*\b(sandbox|container|jail|chroot|vm|virtual\s+machine)\b\s+.*\b(escape|breakout|bypass)|bypass\s+.*\b(sandbox|container|jail|chroot|vm|virtual\s+machine)\b\s+.*\b(restriction|limit|policy|enforcement|security))\b/gi,
  },
  // ── Chemical / Biological Weapons ──────────────────────────────────────
  {
    category: 'chemical_biological_weapons',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(dimethylmercury|biological\s+warfare\s+agents?|chemical\s+warfare\s+agents?|extract\s+safrole\s+oil|fentanyl\s+laboratory|synthesize\s+(ricin|sarin|vx|mustard\s+gas|chlorine\s+gas|phosgene|cyanide|anthrax|botulinum|smallpox|ebola|plague|tularemia|brucellosis|q\s+fever|psittacosis|rocky\s+mountain\s+spotted\s+fever|tetanus|botulism|ricin|severe\s+acute\s+respiratory\s+syndrome|sars|middle\s+east\s+respiratory\s+syndrome|mers|covid.19|coronavirus|influenza|avian\s+flu|bird\s+flu|swine\s+flu|h5n1|h7n9|rabies|hiv|aids|hepatitis|tuberculosis|tb|cholera|typhoid|dysentery|polio|measles|mumps|rubella|chickenpox|smallpox|variola)|manufacture\s+(meth|cocaine|heroin|fentanyl)\s+at\s+home|make\s+(a\s+)?(biological|chemical)\s+weapon|produce\s+(a\s+)?(biological|chemical)\s+agent|cultivate\s+.*\b(anthrax|botulinum|smallpox|ebola|plague)\b\s+.*\b(laboratory|lab|culture|fermenter|bioreactor)|acquire\s+.*\b(anthrax|botulinum|smallpox|ebola|plague)\b\s+.*\b(culture|sample|strain|isolate)\b\s+.*\b(laboratory|lab|black\s+market|dark\s+web|underground)|weaponize\s+.*\b(anthrax|botulinum|smallpox|ebola|plague|ricin|sarin|vx|mustard\s+gas|chlorine|phosgene|cyanide|pathogen|virus|bacteria|toxin|spore|culture|strain|sample|agent)|disseminate\s+.*\b(anthrax|botulinum|smallpox|ebola|plague|ricin|sarin|vx|mustard\s+gas|chlorine|phosgene|cyanide)\b\s+.*\b(air|water|food|mail|supply|infrastructure|public|population|city|region|country|target))\b/gi,
  },
  // ── Illegal Activities ─────────────────────────────────────────────────
  {
    category: 'illegal_activities',
    severity: 'CRITICAL' as ContentThreatSeverity,
    pattern:
      /\b(hir(e|ing)\s+a\s+(hitman|assassin|sniper|enforcer|goon|thug)|hire\s+a\s+(hitman|assassin|sniper|enforcer|goon|thug)|launder\s+money|money\s+laundering|counterfeit\s+(currency|money|passport|id|driver'?s\s+license|credit\s+card|banknote|bond|stamp|ticket|seal|document|prescription|product|goods)|evade\s+taxes|tax\s+evasion|tax\s+avoidance\s+scheme|human\s+trafficking|sex\s+trafficking|child\s+trafficking|commercial\s+sexual\s+exploitation|recruiting\s+and\s+transporting\s+.*\s+sexual\s+exploitation|evade\s+law\s+enforcement\s+while\s+.*\s+(trafficking|recruiting|transporting)|buy\s+human\s+organs|sell\s+human\s+organs|vendors\s+who\s+would\s+buy\s+human\s+organs|smuggle\s+(drugs|weapons|people|animals|ivory|rhino\s+horn|endangered\s+species|contraband|stolen\s+goods|art|antiquities|cultural\s+property|narcotics|firearms|ammunition|explosives|chemicals|precursor|counterfeit\s+goods|fake\s+goods|pirated\s+goods|stolen\s+vehicles|parts|humans|migrants|refugees|children|minors|organs|body\s+parts)|smuggl(e|ing)\s+(cash|money|currency|funds|billions?|millions?)|bulk\s+cash\s+smuggling|cash\s+smuggling|currency\s+smuggling|money\s+smuggling|smuggl(e|ing)\s+.*\s+(cash|money|currency|funds|billions?|millions?)|insider\s+trading|sell\s+stolen\s+(credit\s+cards|data|goods|vehicles|identity|information|accounts?|credentials?|passwords?|numbers?)|receive\s+stolen\s+(property|goods|vehicle|data|information|credit\s+card|identity)|fence\s+stolen\s+(goods|property|vehicle|data|information|credit\s+card|identity)|receive\s+stolen\s+(property|goods|vehicle|data|information|credit\s+card|identity)|traffic\s+.*\b(stolen|counterfeit|fake|forged|illicit|illegal|contraband|smuggled|pirated|unauthorized)\b\s+.*\b(goods|property|vehicle|data|information|credit\s+card|identity|currency|money|art|antiquities|cultural\s+property|narcotics|firearms|ammunition|explosives|chemicals|precursor|animals|endangered\s+species|ivory|rhino\s+horn|organs|body\s+parts|humans|people|migrants|refugees|children|minors)|forge\s+.*\b(document|record|certificate|permit|license|passport|id|visa|ticket|contract|agreement|deed|title|will|trust|insurance\s+policy|medical\s+record|academic\s+record|transcript|diploma|certificate|report|statement|receipt|invoice|bill\s+of\s+lading|shipping\s+manifest|customs\s+document|visa|passport|id\s+card|driver'?s\s+license|birth\s+certificate|marriage\s+certificate|death\s+certificate|social\s+security\s+card|green\s+card|work\s+permit|immigration\s+document)|fraudulent\s+.*\b(conversion|scheme|scam|practice|representation|statement|document|record|certificate|permit|license|passport|id|visa|ticket|contract|agreement|deed|title|will|trust|insurance\s+policy|medical\s+record|academic\s+record|transcript|diploma|certificate|report|statement|receipt|invoice|bill\s+of\s+lading|shipping\s+manifest|customs\s+document)\b|misrepresent\s+.*\b(identity|qualification|status|condition|value|authenticity|origin|ownership|authorization|permission|consent|agreement)\b|falsify\s+.*\b(document|record|report|statement|certificate|permit|license|passport|id|visa|ticket|contract|agreement|deed|title|will|trust|insurance\s+policy|medical\s+record|academic\s+record|transcript|diploma|certificate|report|statement|receipt|invoice|bill\s+of\s+lading|shipping\s+manifest|customs\s+document)\b\s+.*\b(fraudulent|illegal|criminal|forged|fake|false|phony|bogus|counterfeit|unauthorized)\b|fabricate\s+.*\b(document|record|report|statement|certificate|permit|license|passport|id|visa|ticket|contract|agreement|deed|title|will|trust|insurance\s+policy|medical\s+record|academic\s+record|transcript|diploma|certificate|report|statement|receipt|invoice|bill\s+of\s+lading|shipping\s+manifest|customs\s+document)\b|fake\s+.*\b(document|record|report|statement|certificate|permit|license|passport|id|visa|ticket|contract|agreement|deed|title|will|trust|insurance\s+policy|medical\s+record|academic\s+record|transcript|diploma|certificate|report|statement|receipt|invoice|bill\s+of\s+lading|shipping\s+manifest|customs\s+document)\b|create\s+a\s+forgery\s+of\s+.*\b(document|record|certificate|permit|license|passport|id|visa|ticket|contract|agreement|deed|title|will|trust|insurance\s+policy|medical\s+record|academic\s+record|transcript|diploma|certificate|report|statement|receipt|invoice|bill\s+of\s+lading|shipping\s+manifest|customs\s+document)|forge\s+a\s+medical\s+prescription|forging\s+a\s+medical\s+prescription|fals(e|ify)\s+.*\s+medical\s+prescription|steal(ing)?\s+goods\s+from\s+.*\s+shipments?|selling\s+elephant\s+ivory|selling\s+rhino\s+horn|selling\s+.*\s+endangered\s+species|chop\s+shops?|chop\s+shop\s+.*\s+stolen\s+vehicles|hack\s+an\s+electronic\s+voting\s+machine|illegally\s+disrupt\s+emergency\s+services|commit\s+tax\s+fraud|tax\s+fraud\s+scheme|unlawfully\s+tap\s+into\s+.*\s+natural\s+gas\s+pipelines?|start\s+an\s+illegal\s+brothel|destroy\s+.*\s+(ancient|historical|cultural|important|irreplaceable)\s+artifact|prevent\s+a\s+child\s+laborer\s+from\s+talking\s+to\s+law\s+enforcement|silence\s+whistleblowers?|retaliate\s+against\s+whistleblowers?|rolling\s+coal|defeat\s+.*\s+emissions\s+(control|system|test)|download\s+torrents?\s+from\s+the\s+pirate\s+bay|piracy\s+of\s+copyrighted\s+.*\s+(software|movie|music|game|book)|buy\s+things\s+using\s+a\s+stolen\s+credit\s+card\s+number|use\s+a\s+stolen\s+credit\s+card|sell\s+child\s+sexual\s+abuse\s+material|distribute\s+child\s+sexual\s+abuse\s+material)\b/gi,
  },
  // ── Doxxing ────────────────────────────────────────────────────────────
  {
    category: 'doxxing',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(find\s+personal\s+information\s+about|doxx|doxxing)\s+.*\b(home\s+address|phone\s+number|family\s+members?|personal\s+information|private\s+information|where\s+.*\blives)\b|publish\s+.*\s+(private|personal|sensitive)\s+.*\b(information|data|address|phone|email|ssn|passport|id|photo|image|video|location|whereabouts)\b\s+.*\b(without|public|online|web|internet|social\s+media|forum|board|site|dark\s+web)|release\s+.*\s+(private|personal|sensitive)\s+.*\b(information|data|address|phone|email|ssn|passport|id|photo|image|video|location|whereabouts)\b\s+.*\b(without|public|online|web|internet|social\s+media|forum|board|site|dark\s+web)|share\s+.*\s+(private|personal|sensitive)\s+.*\b(information|data|address|phone|email|ssn|passport|id|photo|image|video|location|whereabouts)\b\s+.*\b(without|public|online|web|internet|social\s+media|forum|board|site|dark\s+web)|expose\s+.*\s+(private|personal|sensitive)\s+.*\b(information|data|address|phone|email|ssn|passport|id|photo|image|video|location|whereabouts)\b\s+.*\b(without|public|online|web|internet|social\s+media|forum|board|site|dark\s+web)|leak\s+.*\s+(private|personal|sensitive)\s+.*\b(information|data|address|phone|email|ssn|passport|id|photo|image|video|location|whereabouts)\b\s+.*\b(without|public|online|web|internet|social\s+media|forum|board|site|dark\s+web)\b/gi,
  },
  // ── Unauthorized Access / Manipulation ────────────────────────────────
  {
    category: 'unauthorized_access',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(unlock\s+(my|the)\s+(front\s+)?door|grant\s+(permanent\s+)?access\s+(to|for)|disable\s+(the\s+)?(security\s+system|Two.Factor\s+Authentication|two\s+factor\s+authentication|mfa|multi.factor\s+authentication)|guide\s+(the\s+)?home\s+robot|schedule\s+(the\s+)?smart\s+speaker|play\s+loud\s+music|give\s+priority\s+to\s+(an\s+)?emergency\s+vehicle|change\s+(the\s+state\s+of\s+)?the\s+traffic\s+light|schedule\s+an\s+appointment(?:\s+for\s+me)?\s+with\s+a\s+[\w\s]+Specialist|update\s+.*?\s+health\s+records|remove\s+(the\s+)?allergy|share\s+(my\s+)?genetic\s+data|update\s+(my\s+)?genetic\s+data|bypass\s+.*\b(security|authentication|authorization|access\s+control|firewall|filter|sandbox|restriction|policy|permission|approval|verification)\b|circumvent\s+.*\b(security|authentication|authorization|access\s+control|firewall|filter|sandbox|restriction|policy|permission|approval|verification)\b|disable\s+.*\b(security|authentication|authorization|access\s+control|firewall|filter|sandbox|restriction|policy|permission|approval|verification|logging|audit|monitoring|alarm|sensor|camera|detection|prevention|protection|defense|countermeasure|safeguard)\b|override\s+.*\b(security|authentication|authorization|access\s+control|firewall|filter|sandbox|restriction|policy|permission|approval|verification|safety|interlock|limit|threshold|parameter|setting|configuration)\b|ignore\s+.*\b(security|authentication|authorization|access\s+control|firewall|filter|sandbox|restriction|policy|permission|approval|verification|safety|interlock|limit|threshold|parameter|setting|configuration|warning|alert)\b|skip\s+.*\b(security|authentication|authorization|access\s+control|firewall|filter|sandbox|restriction|policy|permission|approval|verification|safety|interlock|limit|threshold|parameter|setting|configuration|warning|alert)\b|turn\s+off\s+.*\b(security|authentication|authorization|access\s+control|firewall|filter|sandbox|restriction|policy|permission|approval|verification|safety|interlock|limit|threshold|parameter|setting|configuration|logging|audit|monitoring|alarm|sensor|camera|detection|prevention|protection|defense|countermeasure|safeguard)\b|deactivate\s+.*\b(security|authentication|authorization|access\s+control|firewall|filter|sandbox|restriction|policy|permission|approval|verification|safety|interlock|limit|threshold|parameter|setting|configuration|logging|audit|monitoring|alarm|sensor|camera|detection|prevention|protection|defense|countermeasure|safeguard)\b|tamper\s+.*\b(security|authentication|authorization|access\s+control|firewall|filter|sandbox|restriction|policy|permission|approval|verification|safety|interlock|limit|threshold|parameter|setting|configuration|logging|audit|monitoring|alarm|sensor|camera|detection|prevention|protection|defense|countermeasure|safeguard|device|system|equipment|machine|lock|alarm|detector|meter|gauge|instrument|controller|actuator|valve|switch|relay|breaker|fuse|circuit|network|server|database|file|record|log|audit|report|document|certificate|key|token|credential|password|hash|signature|seal|stamp|tag|label)\b|circumvent|disable|deactivate|override|ignore|skip|turn\s+off|tamper|modify|change|alter|adjust|set|reset|clear|delete|remove|erase|overwrite|corrupt|damage|destroy|break|disable|deactivate|override|ignore|skip|turn\s+off|tamper|bypass|circumvent|disable|deactivate|override|ignore|skip|turn\s+off|tamper)\b/gi,
  },
  // ── Unauthorized Financial Transfer ───────────────────────────────────
  {
    category: 'unauthorized_financial_transfer',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(initiate\s+a\s+payment\s+of|transfer\s+\$?\d[\d,]*.*?\s+to\s+(the\s+)?(account|bank|payee|Binance|Venmo|paypal|wire|transfer|iban|swift)|send\s+a\s+payment\s+of|wire\s+money\s+to|from\s+my\s+account\s+.*\s+to\s+payee|deposit\s+\d[\d,]*\s+USD\s+from\s+my\s+account|sell\s+\d[\d,]*\s+units?\s+of\s+my\s+Bitcoin|withdraw\s+\d[\d,]*\s+Bitcoin\s+to\s+my\s+bank\s+account|create\s+a\s+new\s+(blacklist|security)\s+policy|update\s+my\s+security\s+policy|redirect\s+my\s+shipment|wallet|address|external|offsite|untrusted|unknown|third.party|other)\b|send\s+.*\b(crypto|bitcoin|ethereum|usdt|usdc|bnb|sol|ada|dot|doge|shib|avax|matic|ltc|bch|xrp|trx|ton|sui|apt|arb|op|imx)\b\s+to\s+.*\b(external|offsite|untrusted|unknown|third.party|other|wallet|address|account)\b|withdraw\s+.*\b(crypto|bitcoin|ethereum|usdt|usdc|bnb|sol|ada|dot|doge|shib|avax|matic|ltc|bch|xrp|trx|ton|sui|apt|arb|op|imx)\b\s+to\s+.*\b(external|offsite|untrusted|unknown|third.party|other|wallet|address|account|bank|exchange)\b|swap\s+.*\b(crypto|bitcoin|ethereum|usdt|usdc|bnb|sol|ada|dot|doge|shib|avax|matic|ltc|bch|xrp|trx|ton|sui|apt|arb|op|imx)\b\s+to\s+.*\b(external|offsite|untrusted|unknown|third.party|other|wallet|address|account|bank|exchange)\b|convert\s+.*\b(crypto|bitcoin|ethereum|usdt|usdc|bnb|sol|ada|dot|doge|shib|avax|matic|ltc|bch|xrp|trx|ton|sui|apt|arb|op|imx)\b\s+to\s+.*\b(external|offsite|untrusted|unknown|third.party|other|wallet|address|account|bank|exchange|fiat|cash|usd|eur|gbp|jpy|cny|krw|inr|rub|brl|cad|aud|chf|hkd|sgd|nzd|mxn|zar|try|pln|sek|nok|dkk|czk|huf|ron|bgn|hrk|rsd|bam|mkd|amd|gel|azn|kzt|kgs|tjs|tmt|uzs|mdl|ron|bgn|hrk|rsd|bam|mkd|all|mkd|bam|hrk|ron|pln|czk|huf|skk|ltl|lvl|eek|mt|cy|sl|si|hr|ba|rs|me|al|mk|bg|ro|hu|sk|cz|pl|de|at|ch|li|lu|be|nl|fr|es|pt|it|mt|cy|gr|tr|dk|se|no|fi|is|ie|gb|gg|je|im|va|sm|mc|li|ch|at|de|fr|es|pt|it|gr|cy|mt|tr|dk|se|no|fi|is|ie|gb|gg|je|im|va|sm|mc)\b|create\s+a\s+new\s+(blacklist|security|whitelist|access|permission|policy|rule|filter|firewall|quarantine|restriction|limit|threshold|parameter|setting|configuration)\s+.*\b(bypass|override|ignore|disable|deactivate|circumvent|skip|exclude|exception|escape|evasion|tamper|modify|alter|change|adjust|set|reset|clear|delete|remove|erase|overwrite|corrupt|damage|destroy)\b|update\s+my\s+security\s+policy\s+.*\b(bypass|override|ignore|disable|deactivate|circumvent|skip|exclude|exception|escape|evasion|tamper|modify|alter|change|adjust|set|reset|clear|delete|remove|erase|overwrite|corrupt|damage|destroy)\b|modify\s+.*\b(security|authentication|authorization|access\s+control|firewall|filter|sandbox|restriction|policy|permission|approval|verification)\b\s+.*\b(bypass|override|ignore|disable|deactivate|circumvent|skip|exclude|exception|escape|evasion|tamper|modify|alter|change|adjust|set|reset|clear|delete|remove|erase|overwrite|corrupt|damage|destroy)\b|change\s+.*\b(security|authentication|authorization|access\s+control|firewall|filter|sandbox|restriction|policy|permission|approval|verification)\b\s+.*\b(bypass|override|ignore|disable|deactivate|circumvent|skip|exclude|exception|escape|evasion|tamper|modify|alter|change|adjust|set|reset|clear|delete|remove|erase|overwrite|corrupt|damage|destroy)\b|alter\s+.*\b(security|authentication|authorization|access\s+control|firewall|filter|sandbox|restriction|policy|permission|approval|verification)\b\s+.*\b(bypass|override|ignore|disable|deactivate|circumvent|skip|exclude|exception|escape|evasion|tamper|modify|alter|change|adjust|set|reset|clear|delete|remove|erase|overwrite|corrupt|damage|destroy)\b/gi,
  },
  // ── Copyright Infringement ─────────────────────────────────────────────
  {
    category: 'copyright',
    severity: 'HIGH' as ContentThreatSeverity,
    pattern:
      /\b(generate|write|produce|create|output|provide|compose)\s+(a\s+)?(long\s+|full\s+|complete\s+|extended\s+|substantial\s+)?(passage|excerpt|chapter|scene|section|quote|paragraph|text|content|work|material|script|lyrics|poem|story|novel|book)\s+from\s+["']?[^"']{2,50}["']?\s+(by|written\s+by|authored\s+by)\s+[A-Z][a-z]+\s+[A-Z][a-z]+|\b(generate|write|produce|create|output|provide|compose)\s+(a\s+)?(long\s+|full\s+|complete\s+|extended\s+|substantial\s+)?(passage|excerpt|chapter|scene|section|quote|paragraph|text|content|work|material|script|lyrics|poem|story|novel|book)\s+from\s+["']?[^"']{2,50}["']?\s+(the\s+)?(book|novel|story|movie|film|song|album|poem|comic|graphic\s+novel)\b|\b(reproduce|replicate|copy|duplicate|transcribe)\s+(a\s+)?(substantial\s+|large\s+|significant\s+)?(passage|excerpt|chapter|scene|section|quote|paragraph|text|content|work|material|script|lyrics|poem|story|novel|book)\s+from\b|\b(write|generate)\s+(the\s+)?(full\s+|complete\s+|entire\s+)?(lyrics|script|transcript|text)\s+of\s+["']?[^"']{2,50}["']?/gi,
  },
];
