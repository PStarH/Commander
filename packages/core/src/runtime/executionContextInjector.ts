/**
 * Extracted from AgentRuntime.execute() to shrink the god method.
 *
 * Responsible for dynamic context injection before the main LLM loop:
 *  - Agent inbox messages (pending inter-agent communication)
 *  - Three-layer memory recall (with DP sanitization)
 *  - Skills catalog (Level 0)
 *  - Auto-extracted skill recall (past success patterns)
 *
 * All context is consolidated into a single system message for KV-cache stability.
 * Token budget is capped at 20% of total budget to prevent pre-prompt bloat.
 */
import type { AgentExecutionContext } from './types';
import type { AgentInbox } from './agentInbox';
import type { ThreeLayerMemory } from '../threeLayerMemory';
import type { SecurityOrchestrator } from './securityOrchestrator';
import { getGlobalLogger } from '../logging';
import { getMetricsCollector } from './metricsCollector';
import { reportSilentFailure } from '../silentFailureReporter';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExecutionContextInjectorDeps {
  agentInbox: AgentInbox;
  getMemory: () => ThreeLayerMemory | null;
  securityOrch: SecurityOrchestrator;
}

export interface InjectContextParams {
  ctx: AgentExecutionContext;
  tokenBudget: number;
}

export interface InjectContextResult {
  /** The consolidated context block to splice into request.messages */
  content: string;
  /** Number of context parts that were injected */
  partCount: number;
}

// ── ExecutionContextInjector ─────────────────────────────────────────────────

export class ExecutionContextInjector {
  constructor(private readonly deps: ExecutionContextInjectorDeps) {}

  /**
   * Collect all dynamic context (inbox, memory, skills, skill recall)
   * and return a single consolidated system message content string.
   *
   * The caller is responsible for splicing it into request.messages.
   */
  async inject(params: InjectContextParams): Promise<InjectContextResult> {
    const { ctx } = params;
    const contextTokenCap = Math.max(2000, Math.floor((params.tokenBudget || 200000) * 0.2));
    let injectedContextTokens = 0;
    const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);
    const contextParts: string[] = [];

    // 1. Check agent inbox for pending messages.
    //
    // RCH-12: acknowledge only the messages that were actually injected. The
    // previous code acknowledged the whole batch even when the block did not fit
    // the context cap (or was skipped entirely), so queued instructions vanished
    // exactly under context pressure. The remainder stays unread and is
    // delivered by a later run.
    const inboxMessages = this.deps.agentInbox.peekInbox(ctx.agentId);
    if (inboxMessages.length > 0) {
      const inboxHeader = '## Pending Messages\n';
      const inboxFooter = '\n\nAddress these messages as part of your execution.';
      const includedLines: string[] = [];
      let inboxTokens = estimateTokens(inboxHeader + inboxFooter);
      for (const msg of inboxMessages) {
        const line = `[from:${msg.from}] ${msg.subject}: ${msg.body.slice(0, 300)}`;
        const lineTokens = estimateTokens(line) + 1;
        if (injectedContextTokens + inboxTokens + lineTokens >= contextTokenCap) break;
        includedLines.push(line);
        inboxTokens += lineTokens;
      }
      if (includedLines.length > 0) {
        contextParts.push(`${inboxHeader}${includedLines.join('\n')}${inboxFooter}`);
        injectedContextTokens += inboxTokens;
        for (let index = 0; index < includedLines.length; index++) {
          this.deps.agentInbox.acknowledge(ctx.agentId, inboxMessages[index]!.id);
        }
      }
    }

    // 2. Three-layer memory recall with DP sanitization
    const memory = this.deps.getMemory();
    if (memory) {
      try {
        const keywords = ctx.goal
          .split(/\s+/)
          .filter((w) => w.length > 4)
          .slice(0, 8);
        if (keywords.length > 0) {
          const rawMemories = await memory.query({
            keywords,
            limit: 5,
            importanceThreshold: 0.3,
          });
          const dpOutcome = this.deps.securityOrch.sanitizeMemoryShare(rawMemories, ctx.agentId);
          const memories = dpOutcome.result;
          if (memories && memories.length > 0) {
            const memoryBlock = memories
              .map(
                (m: { layer: string; content: string; importance: number; tags: string[] }) =>
                  `[${m.layer}] ${m.content.slice(0, 300)} (importance:${m.importance.toFixed(2)}, tags:${m.tags.join(',')})`,
              )
              .join('\n');
            const memoryTokens = estimateTokens(memoryBlock);
            if (injectedContextTokens + memoryTokens < contextTokenCap) {
              contextParts.push(
                `## Relevant Past Experiences\n${memoryBlock}\n\nLearn from these past experiences when working on the current task.`,
              );
              injectedContextTokens += memoryTokens;
            }
          }
        }
      } catch (e) {
        getGlobalLogger().debug('AgentRuntime', 'Memory initialization failed', {
          error: (e as Error)?.message,
        });
      }
    }

    // 3. Inject skills catalog (Level 0)
    try {
      const { SkillInjector, getSkillSystem } = await import('../skills');
      const injector = new SkillInjector(getSkillSystem().manager);
      const skillsBlock = await injector.buildSkillsBlock(ctx.goal, 0);
      const instructions = injector.buildSkillUsageInstructions();
      if (skillsBlock) {
        const skillsTokens = estimateTokens(skillsBlock + instructions);
        if (injectedContextTokens + skillsTokens < contextTokenCap) {
          contextParts.push(`${skillsBlock}\n\n${instructions}`);
          injectedContextTokens += skillsTokens;
        }
      }
    } catch (e) {
      getGlobalLogger().debug('AgentRuntime', 'Skills injection failed', {
        error: (e as Error)?.message,
      });
    }

    // 4. Inject auto-extracted skill recall
    try {
      const { getSkillExtractor } = await import('../intelligence/skillExtractor');
      const skillExtractor = getSkillExtractor();
      const matchingSkill = skillExtractor.findMatchingSkill(ctx.goal);
      if (matchingSkill && matchingSkill.confidence >= 0.5) {
        try {
          getMetricsCollector().recordSkillRecallHit(true, ctx.tenantId);
        } catch (err) {
          reportSilentFailure(err, 'agentRuntime:1889');
        }
        const skillLines = [
          '## Auto-Recalled Skill',
          `You've successfully handled a similar task before. Use this proven pattern:`,
          ``,
          `**${matchingSkill.name}** (${(matchingSkill.successRate * 100).toFixed(0)}% success, used ${matchingSkill.usageCount}×)`,
          `Description: ${matchingSkill.description}`,
        ];
        if (matchingSkill.steps.length > 0) {
          skillLines.push(`Steps: ${matchingSkill.steps.join(' → ')}`);
        }
        if (matchingSkill.tools.length > 0) {
          skillLines.push(`Recommended tools: ${matchingSkill.tools.join(', ')}`);
        }
        skillLines.push(
          ``,
          `Reuse this pattern if applicable. Adapt based on the current context.`,
        );
        const skillBlock = skillLines.join('\n');
        const skillTokens = estimateTokens(skillBlock);
        if (injectedContextTokens + skillTokens < contextTokenCap) {
          contextParts.push(skillBlock);
          injectedContextTokens += skillTokens;
        }
      } else {
        try {
          getMetricsCollector().recordSkillRecallHit(false, ctx.tenantId);
        } catch (err) {
          reportSilentFailure(err, 'agentRuntime:1919');
        }
      }
    } catch (e) {
      getGlobalLogger().debug('AgentRuntime', 'Skill recall injection failed (best-effort)', {
        error: (e as Error)?.message,
      });
    }

    return {
      content: contextParts.join('\n\n---\n\n'),
      partCount: contextParts.length,
    };
  }
}
