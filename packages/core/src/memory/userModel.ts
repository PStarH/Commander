/**
 * User Modeling System
 *
 * Builds and maintains a deepening model of the user across sessions, similar
 * to Hermes Agent's Honcho dialectic user modeling. Tracks preferences,
 * expertise, communication style, and interaction patterns to provide
 * increasingly personalized agent behavior.
 *
 * Key capabilities:
 * - Preference tracking (coding style, tool choices, verbosity, etc.)
 * - Expertise level estimation per domain
 * - Communication style analysis (formal/casual, detailed/concise)
 * - Tool usage pattern tracking
 * - Topic interest profiling
 * - Interaction pattern recognition (time-of-day, session length, etc.)
 *
 * The model is stored persistently and updated after each interaction.
 * It uses a "dialectic" approach: observations are made, hypotheses are formed,
 * and confidence increases as more evidence accumulates.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { getGlobalLogger } from '../logging';
import { mkdir, readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface UserProfile {
  userId: string;
  createdAt: string;
  updatedAt: string;

  /** Explicit preferences set by the user or inferred from behavior */
  preferences: UserPreferences;

  /** Expertise levels per domain (0-1 scale) */
  expertise: Map<string, ExpertiseLevel>;

  /** Communication style analysis */
  communicationStyle: CommunicationStyle;

  /** Tool usage patterns */
  toolPatterns: ToolUsagePatterns;

  /** Topic interests and engagement levels */
  topicInterests: Map<string, number>;

  /** Interaction patterns (time, frequency, session characteristics) */
  interactionPatterns: InteractionPatterns;

  /** Free-form observations the agent has made about the user */
  observations: UserObservation[];

  /** Confidence in the overall model (increases with more interactions) */
  modelConfidence: number;

  /** Total interactions tracked */
  interactionCount: number;
}

export interface UserPreferences {
  /** Preferred coding style: verbose|minimal|balanced */
  codingStyle: 'verbose' | 'minimal' | 'balanced';
  /** Preferred language for communication */
  language: string;
  /** Preferred level of explanation detail */
  explanationLevel: 'brief' | 'moderate' | 'detailed';
  /** Whether to show code diffs inline */
  showDiffs: boolean;
  /** Whether to ask before making changes */
  askBeforeEditing: boolean;
  /** Preferred test framework (inferred) */
  preferredTestFramework?: string;
  /** Preferred package manager (inferred) */
  preferredPackageManager?: string;
  /** Custom preferences (extensible) */
  custom: Map<string, string>;
}

export interface ExpertiseLevel {
  domain: string;
  level: number; // 0-1 scale (0=beginner, 1=expert)
  confidence: number; // How confident we are in this assessment
  evidenceCount: number; // Number of observations supporting this
  lastAssessed: string;
  signals: string[]; // What signals led to this assessment
}

export interface CommunicationStyle {
  formality: number; // 0=casual, 1=formal
  verbosity: number; // 0=concise, 1=verbose
  technicality: number; // 0=layman, 1=expert
  emojiUsage: number; // 0=never, 1=frequent
  questionStyle: 'direct' | 'exploratory' | 'contextual';
  confidence: number;
}

export interface ToolUsagePatterns {
  mostUsedTools: Map<string, number>;
  avoidedTools: Set<string>;
  preferredSearchMethod: 'semantic' | 'keyword' | 'regex';
  averageSessionLength: number;
  peakUsageHours: number[]; // Hours of day (0-23)
}

export interface InteractionPatterns {
  averageMessageLength: number;
  prefersQuickFixes: boolean;
  asksFollowUpQuestions: boolean;
  providesContext: boolean;
  usesMultilineInput: boolean;
  sessionFrequency: 'daily' | 'weekly' | 'occasional';
  lastInteractionAt: string;
}

export interface UserObservation {
  id: string;
  category: 'preference' | 'expertise' | 'behavior' | 'feedback' | 'pattern';
  content: string;
  confidence: number;
  evidenceCount: number;
  firstObserved: string;
  lastConfirmed: string;
  tags: string[];
}

export interface UserModelConfig {
  /** Path to persist the user model */
  modelPath: string;
  /** Minimum observations before making a hypothesis */
  minObservationsForHypothesis: number;
  /** Confidence threshold for including in model */
  confidenceThreshold: number;
  /** Maximum observations to keep */
  maxObservations: number;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: UserModelConfig = {
  modelPath: '.commander/user-models',
  minObservationsForHypothesis: 3,
  confidenceThreshold: 0.6,
  maxObservations: 500,
};

// ============================================================================
// User Model Manager
// ============================================================================

export class UserModelManager {
  private config: UserModelConfig;
  private models: Map<string, UserProfile> = new Map();

  constructor(config?: Partial<UserModelConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get or create a user profile.
   */
  getProfile(userId: string): UserProfile {
    if (!this.models.has(userId)) {
      this.models.set(userId, this.createDefaultProfile(userId));
    }
    return this.models.get(userId)!;
  }

  /**
   * Load a user profile from disk.
   */
  async loadProfile(userId: string): Promise<UserProfile | null> {
    const filePath = this.getModelPath(userId);
    try {
      await access(filePath);
    } catch (err) {
      reportSilentFailure(err, 'userModel:181');
      return null;
    }

    try {
      const data = JSON.parse(await readFile(filePath, 'utf-8'));
      const profile = this.deserializeProfile(data);
      this.models.set(userId, profile);
      return profile;
    } catch (err) {
      getGlobalLogger().warn('UserModel', 'Failed to load profile', { userId, error: String(err) });
      return null;
    }
  }

  /**
   * Persist all loaded profiles to disk.
   */
  async close(): Promise<void> {
    await Promise.all(Array.from(this.models.keys()).map((userId) => this.saveProfile(userId)));
  }

  /**
   * Save a user profile to disk.
   */
  async saveProfile(userId: string): Promise<void> {
    const profile = this.models.get(userId);
    if (!profile) return;

    const dir = this.config.modelPath;
    await mkdir(dir, { recursive: true });

    const filePath = this.getModelPath(userId);
    const data = this.serializeProfile(profile);
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Record an interaction and update the user model.
   * This is called after each conversation turn to incrementally build the model.
   */
  recordInteraction(
    userId: string,
    params: {
      message: string;
      role: 'user' | 'assistant';
      toolUsed?: string;
      domain?: string;
      feedback?: 'positive' | 'negative' | 'neutral';
    },
  ): void {
    const profile = this.getProfile(userId);
    profile.interactionCount++;
    profile.updatedAt = new Date().toISOString();

    // Update communication style
    if (params.role === 'user') {
      this.updateCommunicationStyle(profile, params.message);
      this.updateInteractionPatterns(profile, params.message);
    }

    // Update tool usage
    if (params.toolUsed) {
      this.updateToolPatterns(profile, params.toolUsed);
    }

    // Update domain expertise
    if (params.domain) {
      this.updateExpertise(profile, params.domain, params.message);
    }

    // Update topic interests
    this.updateTopicInterests(profile, params.message);

    // Update model confidence (increases with interactions)
    profile.modelConfidence = Math.min(1, 0.1 + profile.interactionCount * 0.02);
  }

  /**
   * Add an explicit observation about the user.
   * Observations are the "dialectic" part — the agent records what it notices.
   */
  addObservation(
    userId: string,
    observation: Omit<UserObservation, 'id' | 'firstObserved' | 'lastConfirmed'>,
  ): void {
    const profile = this.getProfile(userId);

    // Check for duplicate observations
    const existing = profile.observations.find(
      (o) =>
        o.category === observation.category &&
        o.content.toLowerCase() === observation.content.toLowerCase(),
    );

    if (existing) {
      // Strengthen existing observation
      existing.evidenceCount++;
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      existing.lastConfirmed = new Date().toISOString();
    } else {
      profile.observations.push({
        ...observation,
        id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        firstObserved: new Date().toISOString(),
        lastConfirmed: new Date().toISOString(),
      });
    }

    // Trim old observations
    if (profile.observations.length > this.config.maxObservations) {
      profile.observations.sort((a, b) => b.confidence - a.confidence);
      profile.observations = profile.observations.slice(0, this.config.maxObservations);
    }
  }

  /**
   * Get a summary of the user model for context injection.
   * This is what gets included in the agent's system prompt.
   */
  getContextSummary(userId: string): string {
    const profile = this.getProfile(userId);
    if (profile.interactionCount < 3) return ''; // Not enough data

    const parts: string[] = ['## User Profile\n'];

    // Preferences
    if (profile.preferences.codingStyle !== 'balanced') {
      parts.push(`- Coding style: ${profile.preferences.codingStyle}`);
    }
    if (profile.preferences.explanationLevel !== 'moderate') {
      parts.push(`- Explanation preference: ${profile.preferences.explanationLevel}`);
    }
    if (profile.preferences.language !== 'en') {
      parts.push(`- Language: ${profile.preferences.language}`);
    }

    // Top expertise domains
    const topExpertise = Array.from(profile.expertise.entries())
      .filter(([, v]) => v.confidence >= this.config.confidenceThreshold)
      .sort((a, b) => b[1].level - a[1].level)
      .slice(0, 5);
    if (topExpertise.length > 0) {
      parts.push(
        `- Expertise: ${topExpertise.map(([d, v]) => `${d} (${Math.round(v.level * 100)}%)`).join(', ')}`,
      );
    }

    // Communication style
    if (profile.communicationStyle.confidence >= this.config.confidenceThreshold) {
      const style = profile.communicationStyle;
      if (style.formality > 0.7) parts.push('- Prefers formal communication');
      if (style.verbosity < 0.3) parts.push('- Prefers concise responses');
      if (style.technicality > 0.7) parts.push('- Highly technical');
    }

    // Top interests
    const topInterests = Array.from(profile.topicInterests.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    if (topInterests.length > 0) {
      parts.push(`- Interests: ${topInterests.map(([t]) => t).join(', ')}`);
    }

    // Key observations
    const keyObservations = profile.observations
      .filter((o) => o.confidence >= this.config.confidenceThreshold)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);
    if (keyObservations.length > 0) {
      parts.push('\n### Key Observations');
      for (const obs of keyObservations) {
        parts.push(`- ${obs.content} (confidence: ${Math.round(obs.confidence * 100)}%)`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Update user preferences explicitly (e.g., from /config command).
   */
  setPreference(userId: string, key: keyof UserPreferences, value: unknown): void {
    const profile = this.getProfile(userId);
    (profile.preferences as unknown as Record<string, unknown>)[key] = value;
    profile.updatedAt = new Date().toISOString();
  }

  // --------------------------------------------------------------------------
  // Internal Update Methods
  // --------------------------------------------------------------------------

  private updateCommunicationStyle(profile: UserProfile, message: string): void {
    const style = profile.communicationStyle;
    const n = profile.interactionCount;

    // Formality detection
    const formalIndicators = /\b(please|kindly|would you|could you|thank you|regards)\b/i;
    const casualIndicators = /\b(hey|yo|gonna|wanna|gotta|btw|thx|lol|idk)\b/i;
    const formalScore = formalIndicators.test(message)
      ? 1
      : casualIndicators.test(message)
        ? 0
        : 0.5;
    style.formality = this.runningAverage(style.formality, formalScore, n);

    // Verbosity detection
    const wordCount = message.split(/\s+/).length;
    const verboseScore = Math.min(1, wordCount / 100);
    style.verbosity = this.runningAverage(style.verbosity, verboseScore, n);

    // Technicality detection
    const technicalTerms =
      /\b(async|await|closure|recursion|polymorphism|dependency injection|middleware|ORM|API|SDK|CI\/CD)\b/gi;
    const techMatches = (message.match(technicalTerms) || []).length;
    const techScore = Math.min(1, techMatches / 3);
    style.technicality = this.runningAverage(style.technicality, techScore, n);

    // Emoji usage (simplified detection without unicode flag)
    const emojiCount = (message.match(/[☀-➿⭐❤✌✨☺✔✖➕➖➗❗❓❕❔]/g) || []).length;
    const emojiScore = Math.min(1, emojiCount / 3);
    style.emojiUsage = this.runningAverage(style.emojiUsage, emojiScore, n);

    style.confidence = Math.min(1, 0.1 + n * 0.03);
  }

  private updateInteractionPatterns(profile: UserProfile, message: string): void {
    const patterns = profile.interactionPatterns;
    const n = profile.interactionCount;

    // Message length
    const length = message.length;
    patterns.averageMessageLength = this.runningAverage(patterns.averageMessageLength, length, n);

    // Quick fix preference (short messages asking for specific changes)
    if (length < 100 && /\b(fix|change|update|rename|move|delete)\b/i.test(message)) {
      patterns.prefersQuickFixes = true;
    }

    // Follow-up questions
    if (message.includes('?')) {
      patterns.asksFollowUpQuestions = true;
    }

    // Context provision (longer messages with file paths, code snippets)
    if (length > 200 || /[\w/]+\.\w+/.test(message) || /```/.test(message)) {
      patterns.providesContext = true;
    }

    // Multiline input
    if (message.includes('\n')) {
      patterns.usesMultilineInput = true;
    }

    patterns.lastInteractionAt = new Date().toISOString();
  }

  private updateToolPatterns(profile: UserProfile, toolName: string): void {
    const patterns = profile.toolPatterns;
    const count = (patterns.mostUsedTools.get(toolName) ?? 0) + 1;
    patterns.mostUsedTools.set(toolName, count);
  }

  private updateExpertise(profile: UserProfile, domain: string, message: string): void {
    if (!profile.expertise.has(domain)) {
      profile.expertise.set(domain, {
        domain,
        level: 0.3,
        confidence: 0.1,
        evidenceCount: 0,
        lastAssessed: new Date().toISOString(),
        signals: [],
      });
    }

    const exp = profile.expertise.get(domain)!;
    exp.evidenceCount++;
    exp.lastAssessed = new Date().toISOString();

    // Detect expertise signals
    const expertSignals = [
      /\b(implement|architect|design pattern|refactor|optimize)\b/i,
      /\b(algorithm|complexity|trade-?off|scalab)\b/i,
      /\b(although|however|consider|alternatively)\b/i, // nuanced thinking
    ];

    const beginnerSignals = [
      /\b(how do I|what is|can you explain|I don't understand)\b/i,
      /\b(basic|simple|beginner|learn|tutorial)\b/i,
    ];

    let adjustment = 0;
    for (const signal of expertSignals) {
      if (signal.test(message)) {
        adjustment += 0.05;
        exp.signals.push(signal.source);
      }
    }
    for (const signal of beginnerSignals) {
      if (signal.test(message)) {
        adjustment -= 0.03;
      }
    }

    exp.level = Math.max(0, Math.min(1, exp.level + adjustment));
    exp.confidence = Math.min(1, 0.1 + exp.evidenceCount * 0.05);

    // Keep only recent signals
    if (exp.signals.length > 20) {
      exp.signals = exp.signals.slice(-20);
    }
  }

  private updateTopicInterests(profile: UserProfile, message: string): void {
    // Extract topics from message (simple keyword extraction)
    const topics = this.extractTopics(message);
    for (const topic of topics) {
      const current = profile.topicInterests.get(topic) ?? 0;
      profile.topicInterests.set(topic, current + 1);
    }
  }

  private extractTopics(text: string): string[] {
    const topicPatterns: [RegExp, string][] = [
      [/\b(react|vue|angular|svelte)\b/i, 'frontend'],
      [/\b(node|express|fastify|nestjs)\b/i, 'backend'],
      [/\b(python|django|flask|fastapi)\b/i, 'python'],
      [/\b(rust|cargo|tokio)\b/i, 'rust'],
      [/\b(golang?|gin|echo)\b/i, 'go'],
      [/\b(docker|kubernetes|k8s|container)\b/i, 'devops'],
      [/\b(postgres|mysql|sqlite|mongo|redis)\b/i, 'database'],
      [/\b(test|jest|vitest|pytest|cargo test)\b/i, 'testing'],
      [/\b(auth|oauth|jwt|session|cookie)\b/i, 'authentication'],
      [/\b(api|rest|graphql|grpc|websocket)\b/i, 'api'],
      [/\b(type|interface|generic|enum)\b/i, 'typescript'],
      [/\b(git|branch|merge|rebase|commit)\b/i, 'git'],
      [/\b(performance|optimize|cache|lazy|bundle)\b/i, 'performance'],
      [/\b(security|vulnerability|xss|csrf|injection)\b/i, 'security'],
      [/\b(ai|ml|llm|model|embedding|vector)\b/i, 'ai-ml'],
    ];

    const topics: string[] = [];
    for (const [pattern, topic] of topicPatterns) {
      if (pattern.test(text)) topics.push(topic);
    }
    return topics;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private createDefaultProfile(userId: string): UserProfile {
    return {
      userId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      preferences: {
        codingStyle: 'balanced',
        language: 'en',
        explanationLevel: 'moderate',
        showDiffs: true,
        askBeforeEditing: true,
        custom: new Map(),
      },
      expertise: new Map(),
      communicationStyle: {
        formality: 0.5,
        verbosity: 0.5,
        technicality: 0.5,
        emojiUsage: 0,
        questionStyle: 'contextual',
        confidence: 0,
      },
      toolPatterns: {
        mostUsedTools: new Map(),
        avoidedTools: new Set(),
        preferredSearchMethod: 'semantic',
        averageSessionLength: 0,
        peakUsageHours: [],
      },
      topicInterests: new Map(),
      interactionPatterns: {
        averageMessageLength: 0,
        prefersQuickFixes: false,
        asksFollowUpQuestions: false,
        providesContext: false,
        usesMultilineInput: false,
        sessionFrequency: 'occasional',
        lastInteractionAt: new Date().toISOString(),
      },
      observations: [],
      modelConfidence: 0,
      interactionCount: 0,
    };
  }

  private runningAverage(current: number, newValue: number, n: number): number {
    return current + (newValue - current) / Math.min(n, 100); // Bounded running average
  }

  private getModelPath(userId: string): string {
    const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.config.modelPath, `${safeId}.json`);
  }

  private serializeProfile(profile: UserProfile): Record<string, unknown> {
    return {
      ...profile,
      expertise: Object.fromEntries(profile.expertise),
      topicInterests: Object.fromEntries(profile.topicInterests),
      toolPatterns: {
        ...profile.toolPatterns,
        mostUsedTools: Object.fromEntries(profile.toolPatterns.mostUsedTools),
        avoidedTools: Array.from(profile.toolPatterns.avoidedTools),
      },
      preferences: {
        ...profile.preferences,
        custom: Object.fromEntries(profile.preferences.custom),
      },
    };
  }

  private deserializeProfile(data: Record<string, unknown>): UserProfile {
    if (typeof data !== 'object' || data === null) {
      throw new Error('Profile data is not an object');
    }

    const asObj = (v: unknown): Record<string, unknown> =>
      typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
    const asStr = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
    const asNum = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback);
    const asBool = (v: unknown, fallback = false): boolean =>
      typeof v === 'boolean' ? v : fallback;
    const asMap = (v: unknown): Map<string, unknown> => new Map(Object.entries(asObj(v)));

    const profile = data as unknown as UserProfile;
    profile.expertise = asMap(data.expertise) as Map<string, ExpertiseLevel>;
    profile.topicInterests = asMap(data.topicInterests) as Map<string, number>;

    const toolPatterns = asObj(data.toolPatterns);
    profile.toolPatterns = {
      mostUsedTools: asMap(toolPatterns.mostUsedTools) as Map<string, number>,
      avoidedTools: new Set(
        Array.isArray(toolPatterns.avoidedTools) ? toolPatterns.avoidedTools : [],
      ),
      preferredSearchMethod: ['semantic', 'keyword', 'regex'].includes(
        asStr(toolPatterns.preferredSearchMethod),
      )
        ? (asStr(toolPatterns.preferredSearchMethod) as ToolUsagePatterns['preferredSearchMethod'])
        : 'keyword',
      averageSessionLength: asNum(toolPatterns.averageSessionLength),
      peakUsageHours: Array.isArray(toolPatterns.peakUsageHours)
        ? toolPatterns.peakUsageHours.filter((h): h is number => typeof h === 'number')
        : [],
    };

    const preferences = asObj(data.preferences);
    profile.preferences = {
      codingStyle: ['verbose', 'minimal', 'balanced'].includes(asStr(preferences.codingStyle))
        ? (asStr(preferences.codingStyle) as UserPreferences['codingStyle'])
        : 'balanced',
      language: asStr(preferences.language, 'en'),
      explanationLevel: ['brief', 'moderate', 'detailed'].includes(
        asStr(preferences.explanationLevel),
      )
        ? (asStr(preferences.explanationLevel) as UserPreferences['explanationLevel'])
        : 'moderate',
      showDiffs: asBool(preferences.showDiffs),
      askBeforeEditing: asBool(preferences.askBeforeEditing, true),
      preferredTestFramework: preferences.preferredTestFramework
        ? asStr(preferences.preferredTestFramework)
        : undefined,
      preferredPackageManager: preferences.preferredPackageManager
        ? asStr(preferences.preferredPackageManager)
        : undefined,
      custom: asMap(preferences.custom) as Map<string, string>,
    };

    profile.modelConfidence = asNum(data.modelConfidence);
    profile.interactionCount = asNum(data.interactionCount);
    return profile;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalUserModelManager: UserModelManager | null = null;

export function getUserModelManager(config?: Partial<UserModelConfig>): UserModelManager {
  if (!globalUserModelManager) {
    globalUserModelManager = new UserModelManager(config);
  }
  return globalUserModelManager;
}
