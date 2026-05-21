# P0 Gap Closure: Commander → General AI Agent

**Goal**: Close the gap with OpenClaw/Hermes on 3 critical dimensions while keeping orchestration moat.

## Track 1: Tools — 25 → 60+ (估算 5-7 天)

### 现有工具清单 (25)
```
web_search, web_fetch, browser_search, browser_fetch,
file_read, file_write, file_edit, file_search, file_list,
python_execute, shell_execute,
memory_store, memory_recall, memory_list,
git, execute_script,
vision_analyze, pdf_extract, screenshot_capture,
code_search, apply_patch, refine_code, verify_answer, fix_code,
agent (delegate)
```

### 新增工具 (估算 ~35 个)

#### Batch 1: Hermes 对标核心工具 (P0-P1)

| 工具名 | 功能 | 参考实现 | 文件 |
|--------|------|---------|------|
| `web_extract` | 增强版 web fetch，支持 CSS selector | Hermes web_extract | `tools/webExtractTool.ts` |
| `delegate_task` | 单 agent 级子任务委托（不经过 orchestrator） | Hermes delegate_task | `tools/delegateTool.ts` |
| `session_search` | 跨历史会话全文搜索 | Hermes session_search | `tools/sessionSearchTool.ts` |
| `todo` | 任务清单管理（create/update/list） | Hermes todo | `tools/todoTool.ts` |
| `cron_schedule` | 定时任务注册/管理 | Hermes cronjob | `tools/cronTool.ts` |
| `send_message` | 多渠道消息推送（预留 gateway 接口） | Hermes send_message | `tools/messageTool.ts` |
| `skill_list` | 查看已保存技能 | Hermes skills_list | `tools/skillTool.ts` |
| `skill_view` | 查看单个技能详情 | Hermes skill_view | `tools/skillTool.ts` |
| `skill_manage` | 创建/编辑/删除技能 | Hermes skill_manage | `tools/skillTool.ts` |
| `web_search_enhanced` | 多后端 web search（SearXNG/Tavily/Exa） | Hermes web_search | `tools/webSearchEnhanced.ts` |

#### Batch 2: Developer 工具 (P1)

| 工具名 | 功能 |
|--------|------|
| `code_review` | 自动代码审查 |
| `code_format` | 代码格式化 |
| `db_query` | 数据库查询（SQLite/PostgreSQL） |
| `db_schema` | 数据库 schema 查看 |
| `http_request` | 通用 HTTP 请求（curl wrapper） |
| `json_parse` | JSON 处理/验证 |
| `yaml_parse` | YAML 处理 |
| `diff` | 文件 diff 比较 |
| `archive` | 压缩/解压（zip/tar） |

#### Batch 3: AI 能力 (P1-P2)

| 工具名 | 功能 |
|--------|------|
| `mixture_of_agents` | 多模型并行推理（Hermes 同名） |
| `image_generate` | 图片生成（DALL-E/Stable Diffusion） |
| `text_to_speech` | TTS |
| `embedding` | 文本向量化 |
| `classify` | 文本分类 |
| `extract` | 结构化信息提取 |

### 工具实现模式（每个工具）

每个新工具遵循现有模式：
```typescript
// tools/webExtractTool.ts
import type { Tool, ToolDefinition } from '../runtime/types';
import { ToolRegistry } from './toolRegistry';

export class WebExtractTool implements Tool {
  definition: ToolDefinition = {
    name: 'web_extract',
    description: 'Extract structured content from a URL using CSS selectors',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to extract from' },
        selector: { type: 'string', description: 'CSS selector to target elements' },
      },
      required: ['url'],
    },
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    // implementation
  }
}

// Auto-register
ToolRegistry.register(new WebExtractTool(), 'web');
```

然后在 `tools/index.ts` 的 `createAllTools()` 添加实例。

---

## Track 2: 技能系统 (估算 5-7 天)

### 问题
MetaLearner 已经用 Thompson Sampling + Reflexion 在学习，但它的学习结果藏在 JSON 文件里，Agent 自己感知不到。Hermes 的技能系统是用户可见、Agent 可用的。

### 实施方案

#### 2.1 Skill Storage Layer (新增文件)

```
packages/core/src/skills/
├── types.ts           # Skill 类型定义
├── skillStore.ts      # 技能持久化（markdown 文件 + FTS5 索引）
├── skillManager.ts    # 技能 CRUD + 查询 + 自动管理
├── skillHub.ts        # 社区技能市场接口（预留）
└── index.ts           # 导出
```

**Skill 类型定义** (`types.ts`):
```typescript
export interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;        // 'coding' | 'research' | 'analysis' | 'writing' | ...
  content: string;         // Markdown 格式的步骤说明
  usage: {
    count: number;
    lastUsed: string;
    avgSuccessRate: number;
  };
  tags: string[];
  createdAt: string;
  updatedAt: string;
  source: 'builtin' | 'learned' | 'community' | 'user';
}
```

**Skill 存储** (`skillStore.ts`):
- 每个 skill 存为 `.commander_skills/<name>.md`，YAML frontmatter + markdown body
- SQLite FTS5 索引（可复用 Hermes 的设计）
- 从 `commander memory` 目录加载

**关键接口**:
```typescript
class SkillManager {
  async create(name: string, content: string, category: string): Promise<Skill>;
  async get(id: string): Promise<Skill | null>;
  async search(query: string, limit?: number): Promise<Skill[]>;
  async list(category?: string): Promise<Skill[]>;
  async update(id: string, content: string): Promise<Skill>;
  async delete(id: string): Promise<boolean>;
  async recordUsage(id: string, success: boolean): Promise<void>;
  async suggestForTask(goal: string): Promise<Skill[]>;  // 根据任务描述推荐技能
}
```

#### 2.2 MetaLearner → Skill Bridge (关键改动)

在 `selfEvolution/metaLearner.ts` 中增加：

```typescript
class MetaLearner {
  // ... 现有代码 ...

  /**
   * NEW: 从执行经验中提取技能
   * 当 Thompson Sampling 发现某个策略对某类任务持续有效时，
   * 自动生成一个 Skill 供后续 Agent 使用
   */
  async extractSkills(skillManager: SkillManager): Promise<Skill[]> {
    const newSkills: Skill[] = [];
    for (const [taskType, priors] of this.thompsonPriors) {
      const bestIdx = priors.map(p => p.mean).indexOf(Math.max(...priors.map(p => p.mean)));
      const bestStrategy = STRATEGY_NAMES[bestIdx];
      const bestScore = priors[bestIdx].mean;
      const totalTrials = priors[bestIdx].totalTrials;

      // 策略经过足够验证且效果显著 → auto-create skill
      if (totalTrials >= 5 && bestScore > 0.7) {
        const skillName = `strategy-${taskType}-${bestStrategy}`;
        const existing = await skillManager.search(skillName);
        if (existing.length === 0) {
          const skill = await skillManager.create(
            skillName,
            this.generateSkillContent(taskType, bestStrategy, bestScore),
            taskType,
          );
          newSkills.push(skill);
        }
      }
    }
    return newSkills;
  }

  /**
   * NEW: 生成人类可读 + Agent 可用的 skill markdown
   */
  private generateSkillContent(
    taskType: string, strategy: string, confidence: number
  ): string {
    return generateSkillDocumentation(taskType, strategy, confidence);
  }
}
```

#### 2.3 Agent-Loadable Skills

在 `agentRuntime.ts` 中增加 hook：

```typescript
// 在运行时，Agent 执行前，自动加载相关 skills 到 system prompt
const relevantSkills = await skillManager.suggestForTask(goal);
if (relevantSkills.length > 0) {
  context.systemPrompt += '\n\n## Relevant Skills\n' + 
    relevantSkills.map(s => `- ${s.name}: ${s.description}`).join('\n');
}
```

#### 2.4 Skill Auto-Creation Hook

在 `orchestrator.ts` 的 `execute()` 结束时增加：

```typescript
// Phase 9: 执行经验 → 技能提取
if (allSuccess && metrics.qualityScore > 0.8) {
  try {
    const newSkills = getMetaLearner().extractSkills(skillManager);
    if (newSkills.length > 0) {
      getMessageBus().publish('skills.created', 'ultimate-orch', {
        skills: newSkills.map(s => s.name),
      });
    }
  } catch (e) {
    // non-critical
  }
}
```

---

## Track 3: Provider 覆盖 — 6 → 15+ (估算 3-4 天)

### 现有 Provider (6)
```
OpenAI, Anthropic, Google, DeepSeek, GLM, MiMo, Xiaomi, OpenRouter
```

### 新增 Provider (10)

| Provider | Env Var | API Base | 模型示例 | 难度 |
|----------|---------|----------|---------|------|
| **Groq** | `GROQ_API_KEY` | `api.groq.com` | `llama-3.3-70b`, `mixtral-8x7b` | 🟢 低 (OpenAI 兼容) |
| **Together AI** | `TOGETHER_API_KEY` | `api.together.xyz` | `llama-3.3-70b`, `deepseek-v3` | 🟢 低 |
| **Fireworks AI** | `FIREWORKS_API_KEY` | `api.fireworks.ai` | `llama-3.3-70b`, `mixtral` | 🟢 低 |
| **Perplexity** | `PERPLEXITY_API_KEY` | `api.perplexity.ai` | `sonar-pro`, `sonar` | 🟢 低 |
| **xAI (Grok)** | `XAI_API_KEY` | `api.x.ai` | `grok-2`, `grok-3` | 🟢 低 |
| **Replicate** | `REPLICATE_API_KEY` | `api.replicate.com` | 各种开源模型 | 🟡 中 (API 不同) |
| **Cohere** | `COHERE_API_KEY` | `api.cohere.com` | `command-r+` | 🟢 低 |
| **Mistral AI** | `MISTRAL_API_KEY` | `api.mistral.ai` | `mistral-large`, `codestral` | 🟢 低 |
| **Anyscale** | `ANYSCALE_API_KEY` | `api.endpoints.anyscale.com` | `llama-3.3-70b` | 🟢 低 |
| **DeepInfra** | `DEEPINFRA_API_KEY` | `api.deepinfra.com` | `llama-3.3-70b` | 🟢 低 |

### 实现模式

9/10 个新增 provider 都是 **OpenAI-compatible API**（`/chat/completions` 接口），可以直接继承或拷贝 `OpenAIProvider` 模式。

```typescript
// providers/groqProvider.ts
export class GroqProvider extends OpenAIProvider {
  readonly name = 'groq';
  constructor() {
    super({
      apiKey: process.env.GROQ_API_KEY ?? '',
      baseUrl: 'https://api.groq.com/openai/v1',
      defaultModel: 'llama-3.3-70b-versatile',
    });
  }
}
```

**唯一例外**: Replicate 的 API 不同（预测式 API，需要轮询结果），需要独立实现。

### 注册改动

在 `runtime/index.ts` 中:

```typescript
export { GroqProvider } from './providers/groqProvider';
export { TogetherProvider } from './providers/togetherProvider';
// ... etc
```

在 `agentRuntime.ts` 的 provider 注册逻辑中自动检测环境变量。

---

## 执行顺序建议

```
Week 1: Tools Batch 1 (核心 10 个)
  ├── delegate_task     → 1 day
  ├── session_search    → 0.5 day
  ├── web_extract       → 0.5 day
  ├── todo              → 0.5 day
  ├── cron_schedule     → 1 day
  ├── send_message      → 1 day (需要 gateway 接口)
  ├── skill_* (3 tools) → 0.5 day（依赖技能系统）
  └── web_search_enhanced → 1 day

Week 2: 技能系统
  ├── Skill 类型 + 存储层    → 2 days
  ├── MetaLearner Bridge     → 1 day
  ├── Agent 自动加载 skills  → 1 day
  ├── Skill CLI 管理         → 1 day
  └── 用户体验打磨           → 1 day

Week 3: Provider + Tools Batch 2
  ├── 9 个 OpenAI-compatible provider → 2 days
  ├── Replicate provider              → 1 day
  ├── Tools Batch 2 (developer)       → 2 days
  └── 测试 + 文档                     → 1 day
```

## 验证标准

每个 Track 完成后验证：

### Track 1 (Tools):
- [ ] 每个新工具: `lsp_diagnostics` 零错误
- [ ] 每个新工具: 至少一个单元测试（`tests/tools/*.test.ts`）
- [ ] `npx tsc --noEmit` 通过
- [ ] `npx tsx --test tests/*.test.ts` 233+ 全绿

### Track 2 (Skills):
- [ ] Agent 完成复杂任务后自动创建 skill markdown 文件
- [ ] 下次同类任务 system prompt 中包含相关 skill
- [ ] CLI 命令 `commander skill list / view / create`
- [ ] FTS5 搜索正常工作
- [ ] `npx tsc --noEmit` 通过

### Track 3 (Providers):
- [ ] 每个新 provider: 能成功调用 `chat.completions`
- [ ] 自动检测环境变量并注册
- [ ] `commander status` 显示所有可用 provider
- [ ] `npx tsc --noEmit` 通过
