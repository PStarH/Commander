# Commander vs Claude Code vs Codex CLI — Harness 全面差距分析

> 2026-06-02 | 目标: PinchBench 100%, 单兵能力超越竞品

## 进度追踪

| 阶段 | 状态 | 改动文件 |
|------|------|----------|
| Phase 1: System Prompt 重写 | ✅ 已完成 | `promptBuilder.ts` |
| Phase 2: Multifile 专项修复 | ✅ 已完成 | `agentRuntime.ts`, `agentTool.ts` |
| Phase 3: Context Compaction 增强 | ⏳ 待做 | `contextCompactor.ts` |
| Phase 4: Verification Pipeline | ⏳ 待做 | 新文件 |
| Phase 5: Agent Budget 提升 | ✅ 已完成 | `agentTool.ts` (25K→50K, 15→30 steps) |
| Phase 6: Preamble Messages | ⏳ 待做 | — |

---

## 一、当前战绩

| 维度 | Commander | Claude Code | Codex CLI |
|------|-----------|-------------|-----------|
| PinchBench | **97.7%** (42/43) | 未公布 | 未公布 |
| OpenClaw 对比 | 已超越 (89.5%) | — | — |
| 输出质量 | 15KB/任务 | 166KB/任务 | 未测 |
| 单任务成功率 | 97.7% | ~95% (估) | ~90% (估) |

**唯一失败: `multifile.json` — 多文件重命名任务返回空答案**

---

## 二、差距分析 (23 个维度)

### 🔴 P0 — 致命差距 (直接影响 PinchBench 100%)

#### 1. System Prompt 太弱 — 缺少行为指令

**Claude Code 的 prompt (~2000+ chars):**
- "Do not propose changes to code you haven't read"
- "If an approach fails, diagnose why before switching tactics"
- "Don't add features, refactor code, or make improvements beyond what was asked"
- "Three similar lines of code is better than a premature abstraction"
- "Before reporting a task complete, verify it actually works"
- Tool preference hierarchy: "Do NOT use Bash when a relevant dedicated tool is provided"

**Codex CLI 的 prompt (~276 lines):**
- "fix root cause, minimal changes, no inline comments unless asked"
- Preamble messages: "8-12 words for quick updates"
- "keep going until resolved"
- "start specific then broaden, up to 3 formatting retries"

**Commander 的 prompt (~60 lines):**
```
You are agent "{agentId}" in project "{projectId}". You help users with software engineering tasks.
This is a complex task. Use file_read to read the relevant files, then produce a comprehensive analysis...
```
- ❌ 没有代码质量规则
- ❌ 没有错误恢复指令
- ❌ 没有工具优先级指令
- ❌ 没有验证完成的指令
- ❌ "complex task" 路径只引导做分析报告,不引导做文件编辑

**差距:** Commander 的 system prompt 是竞品的 1/10 长度,缺少关键行为约束。

#### 2. 文件编辑引导缺失 — multifile 失败根因

**multifile 任务要求:** 跨 4 个 Python 文件重命名函数 `calculate_total_price` → `compute_order_total`

**失败原因链:**
1. System prompt 说 "produce a comprehensive analysis" — 模型以为要写分析报告
2. 没有 "read files first, then edit" 的工作流指令
3. Two-tier tool loading 只 promote 8 个工具 — `file_edit` 可能不在其中
4. Hallucination rejection gate 拦截了未 promote 的工具调用
5. 模型困惑 → 返回空答案

**Claude Code 的做法:**
- "Do not propose changes to code you haven't read" — 强制先读后改
- Edit tool 有 `FILE_UNEXPECTEDLY_MODIFIED_ERROR` — 并发修改检测
- Write tool 说 "Prefer the Edit tool for modifying existing files"

**Codex CLI 的做法:**
- `apply_patch` 格式: `*** Update File: src/app.py` — 明确的文件编辑语义
- "keep going until resolved" — 不会中途放弃

#### 3. 缺少验证指令

**Claude Code:**
- "Before reporting a task complete, verify it actually works: run the test, execute the script, check the output"
- "If you can't verify, say so explicitly rather than claiming success"
- Verification agent: 独立对抗性验证

**Codex CLI:**
- "start specific then broaden, up to 3 formatting retries"
- Completion audit: "verify against actual state, not intent"

**Commander:**
- ❌ 没有验证指令
- ❌ post-loop 的 "force text" 硬编码为 "security audit report" 格式
- ❌ 没有 "edit 后 verify" 的闭环

---

### 🟡 P1 — 重要差距 (影响输出质量和可靠性)

#### 4. Context Compaction 缺少 LLM Summarization

**Claude Code:**
- 9-section structured summary (Primary Request, Key Concepts, Files/Code, Errors, Problem Solving, User Messages, Pending Tasks, Current Work, Next Step)
- `<analysis>` tags as drafting scratchpad
- Post-compact: restores key files (5 files, 50K budget), re-injects skills

**Codex CLI:**
- "Memento" compaction: summary + selected user messages (20K budget)
- Mid-turn vs pre-turn compaction with different strategies
- Remote compaction support

**Commander:**
- 4-layer progressive compaction (好的架构!)
- ❌ 但 Layer 3/4 的 summary 全是 regex 提取,没有 LLM 参与
- ❌ 丢失语义信息: "The answer is 42" 会被当重要决策保留
- ❌ 没有 post-compact 恢复关键文件

#### 5. 缺少 Tool Preference Hierarchy

**Claude Code 明确规定:**
- FileReadTool > cat/head/tail/sed
- FileEditTool > sed/awk
- FileWriteTool > cat with heredoc
- GlobTool > find/ls
- GrepTool > grep/rg
- "Reserve Bash exclusively for system commands"

**Commander:** ❌ 没有这个层级,模型可能用 Bash 做文件操作

#### 6. 缺少 Code Style Rules

**Claude Code:**
- "Don't add error handling, fallbacks, or validation for scenarios that can't happen"
- "Don't create helpers, utilities, or abstractions for one-time operations"
- "Default to writing no comments"
- "Don't explain WHAT the code does"

**Commander:** ❌ 没有代码风格指令

#### 7. 缺少 Preamble Messages (用户反馈)

**Codex CLI:**
- 工具调用前 8-12 词的简短说明
- `update_plan` 工具显示逐步进度
- 用户始终知道 agent 在做什么

**Claude Code:**
- "All text output outside tool use is displayed to the user"
- Spinner during tool execution
- Progress messages for long operations

**Commander:**
- ✅ 有 nudge mechanism (3 次工具调用后提醒)
- ❌ 但没有 preamble 要求
- ❌ 没有 plan 工具

---

### 🟢 P2 — 优化差距 (锦上添花)

#### 8. Static/Dynamic Prompt Boundary

**Claude Code:** `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 分离可缓存静态内容和动态内容

**Commander:** ✅ 有 cache-aware prompt ordering,但没有明确的 boundary marker

#### 9. Fork Subagent Model

**Claude Code:** Fork 继承父上下文,后台运行,不污染主 context

**Commander:** ✅ 有 agent tool with isolation,但 budget 只有 25K,steps 只有 15

#### 10. Hooks System

**Claude Code:** PreToolUse, PostToolUse, Stop, SessionStart, PreCompact, PostCompact

**Commander:** ✅ 有 plugin hook system (beforeToolCall, afterToolCall 等),功能对等

#### 11. Scratchpad Directory

**Claude Code:** Session-specific temp files without permission prompts

**Commander:** ❌ 没有 scratchpad

#### 12. Approval Callback 硬编码

**Commander 的 agentRuntime.ts:**
```typescript
approved: true  // line 199-201, 硬编码总是批准
```
这实际上绕过了整个 approval system。

---

## 三、改进方案 — 冲刺 100%

### Phase 1: System Prompt 重写 (1-2 天)

**目标:** 将 system prompt 从 ~60 行扩展到 ~200 行,覆盖所有关键行为指令

**新增内容:**

```markdown
## Core Behavior
- You are highly capable and often allow users to complete ambitious tasks
- Keep going until the task is fully resolved
- If an approach fails, diagnose why before switching tactics
- Do not propose changes to code you haven't read

## File Editing Rules
- ALWAYS read files before editing them
- Use file_edit for modifying existing files (sends only the diff)
- Use file_write only for creating new files or complete rewrites
- For multi-file refactoring: read ALL files first, plan changes, edit each file, then verify
- After editing, verify the changes are correct by reading the modified files

## Tool Preference Hierarchy
- Use file_read instead of cat/head/tail
- Use file_edit instead of sed/awk
- Use file_write instead of cat with heredoc
- Use file_search instead of find/ls
- Use file_grep instead of grep/rg
- Reserve shell_exec for system commands that require shell execution
- When multiple tools can be used, prefer dedicated tools over shell

## Code Quality Rules
- Don't add features, refactor code, or make improvements beyond what was asked
- Don't add error handling for scenarios that can't happen
- Don't create helpers or abstractions for one-time operations
- Three similar lines of code is better than a premature abstraction
- Default to writing no comments. Only add one when the WHY is non-obvious

## Verification
- Before reporting a task complete, verify it actually works
- For file edits: read the file after editing to confirm changes
- For code generation: run the code if possible to verify it works
- If you can't verify, say so explicitly rather than claiming success

## Error Recovery
- If a tool call fails, read the error message carefully
- Try a different approach if the first one fails
- Don't retry the exact same call that just failed
- If stuck, step back and reconsider the problem

## Output Quality
- Your text output is what the user sees — make it comprehensive
- Include file paths and line numbers when referencing code
- For complex tasks: provide executive summary, findings, and recommendations
- Go straight to the point. Try the simplest approach first
```

**具体改动文件:** `packages/core/src/runtime/promptBuilder.ts`

### Phase 2: Multifile 任务专项修复 (1 天)

**问题:** Two-tier tool loading 只 promote 8 个工具,`file_edit` 可能被拦截

**修复方案:**

1. **确保核心文件工具始终 promote:**
```typescript
// In agentRuntime.ts, after buildTwoTierTools
const CORE_TOOLS = ['file_read', 'file_write', 'file_edit', 'file_search', 'file_list', 'shell_exec'];
for (const name of CORE_TOOLS) {
  if (!this.promotedTools.has(name)) {
    const tool = this.tools.get(name);
    if (tool) {
      twoTier.active.push(tool.definition);
      this.promotedTools.add(name);
    }
  }
}
```

2. **为多文件编辑添加专用指令:**
```typescript
// In promptBuilder.ts, when goal matches multi-file pattern
if (isMultiFileTask(ctx.goal)) {
  parts.push(`
## Multi-File Refactoring Workflow
1. Read ALL files that need to be modified
2. Plan the changes: what needs to change in each file
3. Edit each file one at a time using file_edit
4. After all edits, read each file again to verify changes
5. Report what was changed in each file
  `);
}
```

3. **修复 post-loop force-text 硬编码:**
```typescript
// Remove the hardcoded "security audit report" format
// Replace with task-aware prompting
const forcePrompt = isComplexTask(ctx.goal)
  ? `You have gathered information but haven't provided a complete response. Based on the tool results above, provide a comprehensive response to the original task: "${ctx.goal}"`
  : `Provide a complete response to: "${ctx.goal}"`;
```

### Phase 3: Context Compaction 增强 (2 天)

**目标:** 在 Layer 3 Collapse 中引入 LLM-based summarization

**方案:**
1. Layer 1/2 保持 heuristic (快,便宜)
2. Layer 3 Collapse 改为 LLM summarization:
   - 使用 eco-tier 模型 (便宜)
   - 9-section structured summary (借鉴 Claude Code)
   - 保留完整代码片段
   - 保留所有用户消息
3. Layer 4 Emergency 保持 heuristic (保底)
4. Post-compact: 恢复最近 5 个文件的内容

### Phase 4: Verification Pipeline 强化 (1 天)

**目标:** 确保每个任务的输出都经过验证

**方案:**
1. 添加 `verify_completion` 工具:
   - 读取所有修改过的文件
   - 检查是否符合任务要求
   - 运行测试 (如果适用)
2. 在 system prompt 中添加验证指令
3. 在 post-loop 中添加自动验证步骤

### Phase 5: Agent Tool Budget 提升 (0.5 天)

**当前:** 25K token budget, 15 steps limit
**目标:** 50K token budget, 30 steps limit

**原因:** 复杂子任务 (如多文件编辑) 需要更多步骤

### Phase 6: Preamble Messages (0.5 天)

**目标:** 在工具调用前添加简短说明

**方案:**
```typescript
// In system prompt
parts.push(`
## Progress Updates
- Before making tool calls, briefly explain what you're about to do (1-2 sentences)
- Keep the user informed of your progress
- Example: "Reading the source files to understand the current implementation..."
`);
```

---

## 四、预期效果

| 改进 | 预期效果 | PinchBench 影响 |
|------|----------|----------------|
| System Prompt 重写 | 模型行为更精确 | +1-2% (修复 edge cases) |
| Multifile 专项修复 | 修复唯一失败任务 | +2.3% (42/43 → 43/43) |
| Context Compaction 增强 | 长任务不丢上下文 | 间接提升 |
| Verification Pipeline | 输出质量提升 | +1% (防止部分正确) |
| Agent Budget 提升 | 复杂子任务成功 | +1% |
| Preamble Messages | 用户体验提升 | 无直接影响 |

**预期最终成绩: 100% (43/43)**

---

## 五、与竞品的最终对比

| 维度 | Commander (改进后) | Claude Code | Codex CLI |
|------|-------------------|-------------|-----------|
| PinchBench | **100%** 🎯 | ~95% | ~90% |
| 多模型支持 | ✅ 30+ 模型 | ❌ Claude only | ❌ GPT only |
| 多 Agent | ✅ 完整 | ✅ Fork subagent | ✅ Thread manager |
| Memory | ✅ 4-layer | ✅ CLAUDE.md | ✅ AGENTS.md |
| Security | ✅ 5-layer | ✅ Permission modes | ✅ Sandbox |
| Context Mgmt | ✅ 4-layer adaptive | ✅ Multi-layer | ✅ Memento |
| Cost Control | ✅ TokenGovernor | ❌ 无 | ❌ 无 |
| Learning | ✅ Thompson sampling | ❌ 无 | ❌ 无 |
| 多租户 | ✅ 完整 | ❌ 无 | ❌ 无 |

**Commander 的独特优势:**
1. 多模型路由 + 学习 — 哪个模型擅长什么任务
2. TokenGovernor — 精确的成本控制
3. 4-layer memory with Thompson sampling — 记忆越用越好
4. 多租户隔离 — 企业级特性
5. 自适应 context compaction — 根据任务类型调整

---

## 六、执行计划

| 阶段 | 任务 | 时间 | 负责 |
|------|------|------|------|
| Phase 1 | System Prompt 重写 | Day 1-2 | 核心 |
| Phase 2 | Multifile 专项修复 | Day 2 | 核心 |
| Phase 3 | Context Compaction 增强 | Day 3-4 | 核心 |
| Phase 4 | Verification Pipeline | Day 4 | 核心 |
| Phase 5 | Agent Budget 提升 | Day 5 AM | 核心 |
| Phase 6 | Preamble Messages | Day 5 PM | 核心 |
| 测试 | PinchBench 全量重跑 | Day 5 PM | 自动 |

**总计: 5 天冲刺**

---

## 七、风险和缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| System prompt 太长导致 token 浪费 | 成本增加 | 保留 budget-aware verbosity, tight/critical 时用短 prompt |
| LLM summarization 质量差 | 丢失重要信息 | Fallback 到 heuristic summarization |
| Two-tier tool promotion 策略错误 | 工具不可用 | 确保核心工具始终 promote |
| PinchBench 评分标准变化 | 分数波动 | 锁定评分版本 |

---

## 八、关键代码改动清单

### 1. `packages/core/src/runtime/promptBuilder.ts`
- [ ] 重写 `buildSystemPrompt()` — 添加完整行为指令
- [ ] 添加 `isMultiFileTask()` 检测
- [ ] 添加 multi-file workflow 指令
- [ ] 添加 tool preference hierarchy
- [ ] 添加 code quality rules
- [ ] 添加 verification 指令
- [ ] 添加 error recovery 指令

### 2. `packages/core/src/runtime/agentRuntime.ts`
- [ ] 修复 two-tier tool promotion — 确保核心工具始终 promote
- [ ] 修复 post-loop force-text 硬编码
- [ ] 提升 agent tool budget (25K → 50K)
- [ ] 提升 agent tool steps (15 → 30)
- [ ] 移除 approval callback 硬编码

### 3. `packages/core/src/runtime/contextCompactor.ts`
- [ ] Layer 3 Collapse 改为 LLM summarization
- [ ] 添加 post-compact 文件恢复
- [ ] 改进 structured summary 提取

### 4. `packages/core/src/tools/agentTool.ts`
- [ ] 提升默认 budget
- [ ] 提升默认 steps limit

### 5. 新文件: `packages/core/src/runtime/verificationTool.ts`
- [ ] 实现 `verify_completion` 工具

---

**结论:** Commander 的架构基础已经很好 (4-layer compaction, multi-model routing, Thompson sampling memory), 主要差距在 system prompt 的行为指令和文件编辑工作流引导。通过 5 天冲刺,我们有信心达到 PinchBench 100%, 同时在单兵能力上超越 Claude Code 和 Codex CLI。
