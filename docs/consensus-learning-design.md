# Commander 多Agent共识学习系统设计

> 基于 8 篇顶级论文，token效率优先

## 核心理念

**不抄 Hermes 的"单Agent自主学习"，做"多Agent共识 + 治理门控 + 可观测"的学习。**

| | Hermes 方式 | Commander 方式 | 优势 |
|---|---|---|---|
| 谁决定记什么 | 单Agent自主 | 多Agent共识投票 | 更可靠 |
| 质量保障 | 无 | 治理检查点 | 更可控 |
| 可解释性 | 黑盒 | OTel全链路 | 更透明 |
| Token效率 | 未优化 | 严格预算 | 更省钱 |

---

## 论文基础

| 论文 | 关键洞察 | Commander应用 |
|------|---------|--------------|
| Generative Agents (Park et al. 2023) | 三因子记忆检索 + 反思→记忆管道 | 已实现四因子，补反思管道 |
| MemGPT (Packer et al. 2023) | LLM通过tool call自主管理记忆 | 暴露memory_store/recall工具 |
| Reflexion (Shinn et al. 2023) | 滑动窗口注入最近3条反思 | 注入retry prompt，~300 tokens |
| Multi-Agent Debate (Liang et al. 2023) | 多Agent投票提升事实性 | 共识门控记忆写入 |
| Self-RAG (Asai et al. 2023) | 质量门控检索和生成 | 写入前质量检查 |
| Cognitive Architectures (Sumers et al. 2023) | 扩散激活 + 效用学习 | 对数衰减 + 效用追踪 |
| Thompson Sampling (Schaul et al. 2015) | 优先经验回放 | 记忆有用性Beta分布 |
| LLMLingua (Jiang et al. 2023) | 压缩prompt | 晋升时压缩 |

---

## 系统架构

```
┌─────────────────────────────────────────────────────┐
│                   Agent 执行循环                      │
│                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐       │
│  │ 工作记忆  │    │ 情景记忆  │    │ 长期记忆  │       │
│  │ (核心状态) │    │ (近期经历) │    │ (持久知识) │       │
│  └────┬─────┘    └────┬─────┘    └────┬─────┘       │
│       │               │               │             │
│       ▼               ▼               ▼             │
│  ┌─────────────────────────────────────────┐        │
│  │         记忆评分引擎                      │        │
│  │  四因子 + Thompson + 惊奇度              │        │
│  └─────────────────┬───────────────────────┘        │
│                    │                                │
│                    ▼                                │
│  ┌─────────────────────────────────────────┐        │
│  │         共识门控                          │        │
│  │  规则过滤 → 嵌入去重 → 质量门 → 共识投票  │        │
│  └─────────────────┬───────────────────────┘        │
│                    │                                │
│                    ▼                                │
│  ┌─────────────────────────────────────────┐        │
│  │         反思管道                          │        │
│  │  每N次经历 → LLM反思 → 存入长期记忆       │        │
│  │  最近3条反思 → 注入retry prompt           │        │
│  └─────────────────────────────────────────┘        │
│                                                     │
│  ┌─────────────────────────────────────────┐        │
│  │         可观测层                          │        │
│  │  每个记忆决策 → OTel span → Prometheus    │        │
│  └─────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────┘
```

---

## 实现方案

### 1. 反思→记忆管道 (Generative Agents)

**论文**: Park et al. 2023, arXiv:2304.03442
**原理**: 定期将情景记忆合成为高层洞察，存为可检索的长期记忆

**实现**:
```typescript
// packages/core/src/memory/reflectionPipeline.ts

interface ReflectionEntry {
  insight: string;        // 1-2句话的洞察
  sourceMemoryIds: string[];  // 来源记忆ID
  importance: number;     // 0-1
  timestamp: number;
}

class ReflectionPipeline {
  private reflectionBuffer: ReflectionEntry[] = [];
  private readonly MAX_BUFFER = 10;
  private readonly REFLECTION_INTERVAL = 5; // 每5次经历触发一次
  
  /**
   * 触发反思 - 将最近的情景记忆合成为洞察
   * Token成本: ~200 tokens (一次LLM调用)
   */
  async reflect(recentMemories: MemoryEntry[]): Promise<ReflectionEntry | null> {
    if (recentMemories.length < this.REFLECTION_INTERVAL) return null;
    
    // 只取最近的N条记忆
    const toReflect = recentMemories.slice(-this.REFLECTION_INTERVAL);
    
    // 用LLM合成洞察 (单次调用，~200 tokens)
    const insight = await this.synthesize(toReflect);
    
    if (!insight) return null;
    
    const entry: ReflectionEntry = {
      insight,
      sourceMemoryIds: toReflect.map(m => m.id),
      importance: this.calculateImportance(toReflect),
      timestamp: Date.now(),
    };
    
    // 存入缓冲区
    this.reflectionBuffer.push(entry);
    if (this.reflectionBuffer.length > this.MAX_BUFFER) {
      this.reflectionBuffer.shift();
    }
    
    return entry;
  }
  
  /**
   * 获取最近的N条反思，用于注入retry prompt
   * Token成本: ~100 tokens (3条反思 x ~30 tokens/条)
   */
  getRecentReflections(n: number = 3): string {
    return this.reflectionBuffer
      .slice(-n)
      .map(r => `[反思] ${r.insight}`)
      .join('\n');
  }
  
  private async synthesize(memories: MemoryEntry[]): Promise<string | null> {
    const prompt = `基于以下经历，总结一条可复用的经验洞察（1-2句话）：
${memories.map(m => `- ${m.content}`).join('\n')}

洞察:`;
    
    // 单次LLM调用，~200 tokens
    return await this.llm.complete(prompt, { maxTokens: 100 });
  }
}
```

**Token成本分析**:
- 反思合成: ~200 tokens / 5次经历 = **40 tokens/经历**
- 注入retry: ~100 tokens (3条反思)
- **总计: ~140 tokens/经历**

---

### 2. 共识门控记忆写入 (Multi-Agent Debate)

**论文**: Liang et al. 2023, arXiv:2305.14325
**原理**: 多Agent投票决定信息是否值得存储

**实现**:
```typescript
// packages/core/src/memory/consensusGate.ts

interface ConsensusVote {
  agentId: string;
  shouldStore: boolean;
  confidence: number; // 0-1
  reason: string;
}

class ConsensusGate {
  private readonly MIN_VOTES = 2;
  private readonly CONSENSUS_THRESHOLD = 0.6;
  
  /**
   * 共识门控 - 多Agent投票决定是否存储
   * Token成本: 0 (纯规则判断) 或 ~200 tokens (LLM评估)
   */
  async shouldStore(
    memory: MemoryEntry,
    context: ExecutionContext
  ): Promise<{ store: boolean; confidence: number }> {
    
    // 第一层: 规则过滤 (0 tokens)
    if (!this.passesRuleFilter(memory)) {
      return { store: false, confidence: 0 };
    }
    
    // 第二层: 嵌入去重 (~100 tokens)
    if (await this.isDuplicate(memory)) {
      return { store: false, confidence: 0 };
    }
    
    // 第三层: 质量门 (0 tokens, 纯启发式)
    if (!this.passesQualityGate(memory)) {
      return { store: false, confidence: 0 };
    }
    
    // 第四层: 共识投票 (0 tokens, 用已有信号)
    const votes = this.collectVotes(memory, context);
    const consensus = this.evaluateConsensus(votes);
    
    return consensus;
  }
  
  /**
   * 规则过滤 - 零成本快速拒绝
   */
  private passesRuleFilter(memory: MemoryEntry): boolean {
    // 太短的不存
    if (memory.content.length < 20) return false;
    
    // 太长的压缩后再存
    if (memory.content.length > 500) {
      memory.content = this.compress(memory.content);
    }
    
    // 纯工具调用日志不存
    if (memory.content.match(/^<tool_call>.*<\/tool>$/)) return false;
    
    // 错误堆栈不存
    if (memory.content.includes('at Object.<anonymous>')) return false;
    
    return true;
  }
  
  /**
   * 嵌入去重 - 检查是否与已有记忆重复
   * Token成本: ~100 tokens (一次嵌入调用)
   */
  private async isDuplicate(memory: MemoryEntry): Promise<boolean> {
    const embedding = await this.getEmbedding(memory.content);
    const similar = await this.memoryStore.findSimilar(embedding, 0.85);
    return similar.length > 0;
  }
  
  /**
   * 质量门 - 启发式质量检查
   */
  private passesQualityGate(memory: MemoryEntry): boolean {
    // 必须有足够信息密度
    const words = memory.content.split(/\s+/).length;
    const uniqueWords = new Set(memory.content.toLowerCase().split(/\s+/)).size;
    const density = uniqueWords / words;
    
    if (density < 0.3) return false; // 太多重复词
    
    // 必须包含动作或事实
    const hasAction = /应该|需要|可以|必须|建议/.test(memory.content);
    const hasFact = /\d{4}|版本|地址|端口|密码/.test(memory.content);
    
    return hasAction || hasFact;
  }
  
  /**
   * 共识投票 - 用已有信号投票，不消耗额外token
   */
  private collectVotes(memory: MemoryEntry, context: ExecutionContext): ConsensusVote[] {
    const votes: ConsensusVote[] = [];
    
    // 信号1: 重要性分数
    votes.push({
      agentId: 'importance-scorer',
      shouldStore: memory.importance > 0.6,
      confidence: memory.importance,
      reason: `重要性: ${memory.importance.toFixed(2)}`,
    });
    
    // 信号2: 访问频率
    votes.push({
      agentId: 'access-tracker',
      shouldStore: memory.accessCount > 2,
      confidence: Math.min(memory.accessCount / 5, 1),
      reason: `访问次数: ${memory.accessCount}`,
    });
    
    // 信号3: 任务相关性
    const relevance = this.calculateRelevance(memory, context);
    votes.push({
      agentId: 'relevance-scorer',
      shouldStore: relevance > 0.5,
      confidence: relevance,
      reason: `相关性: ${relevance.toFixed(2)}`,
    });
    
    return votes;
  }
  
  /**
   * 评估共识 - 加权投票
   */
  private evaluateConsensus(votes: ConsensusVote[]): { store: boolean; confidence: number } {
    const totalWeight = votes.reduce((sum, v) => sum + v.confidence, 0);
    const storeWeight = votes
      .filter(v => v.shouldStore)
      .reduce((sum, v) => sum + v.confidence, 0);
    
    const consensusRatio = storeWeight / totalWeight;
    
    return {
      store: consensusRatio >= this.CONSENSUS_THRESHOLD,
      confidence: consensusRatio,
    };
  }
}
```

**Token成本分析**:
- 规则过滤: **0 tokens**
- 嵌入去重: **~100 tokens** (一次嵌入调用)
- 质量门: **0 tokens**
- 共识投票: **0 tokens** (用已有信号)
- **总计: ~100 tokens/写入**

---

### 3. Thompson Sampling 记忆有用性 (Prioritized Experience Replay)

**论文**: Schaul et al. 2015, arXiv:1511.05952
**原理**: 用Beta分布追踪每条记忆的有用性，自动淘汰无用记忆

**实现**:
```typescript
// packages/core/src/memory/thompsonMemory.ts

interface MemoryUsefulness {
  alpha: number;  // 成功使用次数
  beta: number;   // 失败使用次数
  lastUpdated: number;
}

class ThompsonMemoryScorer {
  private usefulnessMap = new Map<string, MemoryUsefulness>();
  
  /**
   * 更新记忆有用性
   * Token成本: 0 (纯计算)
   */
  updateUsefulness(memoryId: string, wasUseful: boolean): void {
    let entry = this.usefulnessMap.get(memoryId);
    if (!entry) {
      entry = { alpha: 1, beta: 1, lastUpdated: Date.now() }; // 先验: Beta(1,1)
    }
    
    if (wasUseful) {
      entry.alpha += 1;
    } else {
      entry.beta += 1;
    }
    
    entry.lastUpdated = Date.now();
    this.usefulnessMap.set(memoryId, entry);
  }
  
  /**
   * 采样记忆有用性分数
   * Token成本: 0 (纯计算)
   */
  sampleUsefulness(memoryId: string): number {
    const entry = this.usefulnessMap.get(memoryId);
    if (!entry) return 0.5; // 默认中等有用性
    
    // 从Beta分布采样
    return this.betaSample(entry.alpha, entry.beta);
  }
  
  /**
   * 计算惊奇度 - 实际结果与预期的偏差
   * Token成本: 0 (纯计算)
   */
  calculateSurprise(memoryId: string, actualOutcome: boolean): number {
    const entry = this.usefulnessMap.get(memoryId);
    if (!entry) return 0.5;
    
    const expected = entry.alpha / (entry.alpha + entry.beta);
    const actual = actualOutcome ? 1 : 0;
    
    return Math.abs(actual - expected);
  }
  
  /**
   * 淘汰无用记忆
   * Token成本: 0 (纯计算)
   */
  getEvictionCandidates(threshold: number = 0.2): string[] {
    const candidates: string[] = [];
    
    for (const [id, entry] of this.usefulnessMap) {
      // Beta分布的均值
      const mean = entry.alpha / (entry.alpha + entry.beta);
      
      // 均值低于阈值且有足够数据
      if (mean < threshold && (entry.alpha + entry.beta) > 10) {
        candidates.push(id);
      }
    }
    
    return candidates;
  }
  
  /**
   * Beta分布采样 (Box-Muller变换)
   */
  private betaSample(alpha: number, beta: number): number {
    const x = this.gammaSample(alpha);
    const y = this.gammaSample(beta);
    return x / (x + y);
  }
  
  private gammaSample(shape: number): number {
    // Marsaglia and Tsang's method
    if (shape < 1) {
      return this.gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape);
    }
    
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    
    while (true) {
      let x, v;
      do {
        x = this.normalRandom();
        v = 1 + c * x;
      } while (v <= 0);
      
      v = v * v * v;
      const u = Math.random();
      
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
  
  private normalRandom(): number {
    const u = 1 - Math.random();
    const v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }
}
```

**Token成本分析**: **0 tokens** (纯计算)

---

### 4. 晋升时压缩 (LLMLingua)

**论文**: Jiang et al. 2023, arXiv:2310.03402
**原理**: 情景记忆晋升到长期记忆时，压缩为1句话

**实现**:
```typescript
// packages/core/src/memory/compressionPromotion.ts

class CompressionPromotion {
  /**
   * 压缩并晋升记忆
   * Token成本: ~100 tokens (一次LLM调用)
   */
  async promote(entry: MemoryEntry): Promise<MemoryEntry> {
    // 如果已经很短，直接晋升
    if (entry.content.length < 100) {
      return { ...entry, layer: 'longterm' };
    }
    
    // 用LLM压缩为1句话
    const compressed = await this.compress(entry.content);
    
    return {
      ...entry,
      content: compressed,
      layer: 'longterm',
      metadata: {
        ...entry.metadata,
        compressed: true,
        originalLength: entry.content.length,
      },
    };
  }
  
  private async compress(content: string): Promise<string> {
    const prompt = `将以下内容压缩为1句话，保留关键信息：
${content}

压缩后:`;
    
    return await this.llm.complete(prompt, { maxTokens: 50 });
  }
}
```

**Token成本分析**: **~100 tokens/晋升**

---

### 5. Reflexion 滑动窗口注入

**论文**: Shinn et al. 2023, arXiv:2303.11366
**原理**: 将最近3条反思注入retry prompt，提升重试成功率

**实现**:
```typescript
// packages/core/src/memory/reflexionInjector.ts

class ReflexionInjector {
  private readonly MAX_REFLECTIONS = 3;
  
  /**
   * 注入反思到retry prompt
   * Token成本: ~100 tokens (3条反思)
   */
  injectReflections(
    originalPrompt: string,
    reflections: ReflectionEntry[]
  ): string {
    if (reflections.length === 0) return originalPrompt;
    
    const recent = reflections.slice(-this.MAX_REFLECTIONS);
    const reflectionText = recent
      .map((r, i) => `[经验${i + 1}] ${r.insight}`)
      .join('\n');
    
    return `${originalPrompt}

## 历史经验
${reflectionText}

基于以上经验，避免重复错误。`;
  }
}
```

**Token成本分析**: **~100 tokens/retry**

---

### 6. 扩散激活记忆检索 (ACT-R)

**论文**: Sumers et al. 2023, arXiv:2309.08532
**原理**: 用对数衰减替代线性衰减，更符合人类记忆

**实现**:
```typescript
// packages/core/src/memory/spreadingActivation.ts

class SpreadingActivation {
  /**
   * ACT-R式激活计算
   * Token成本: 0 (纯计算)
   */
  calculateActivation(memory: MemoryEntry, currentTime: number): number {
    // 基础激活水平
    const B = Math.log(memory.importance);
    
    // 扩散激活: 对数衰减
    const timeSinceAccess = (currentTime - memory.lastAccessedAt) / 3600000; // 小时
    const stability = memory.accessCount + 1; // 稳定性随访问次数增加
    const decay = Math.exp(-timeSinceAccess / stability);
    
    // 访问频率的对数累积
    const frequencyBonus = Math.log(1 + memory.accessCount);
    
    return B + decay + frequencyBonus;
  }
  
  /**
   * 基于激活的记忆检索
   * Token成本: 0 (纯计算)
   */
  retrieveByActivation(
    memories: MemoryEntry[],
    query: string,
    topK: number,
    tokenBudget: number
  ): MemoryEntry[] {
    const currentTime = Date.now();
    
    // 计算每条记忆的激活分数
    const scored = memories.map(m => ({
      memory: m,
      activation: this.calculateActivation(m, currentTime),
    }));
    
    // 按激活分数排序
    scored.sort((a, b) => b.activation - a.activation);
    
    // 取top-K，但不超过token预算
    const result: MemoryEntry[] = [];
    let totalTokens = 0;
    
    for (const { memory } of scored) {
      const tokens = this.estimateTokens(memory.content);
      if (totalTokens + tokens > tokenBudget) break;
      if (result.length >= topK) break;
      
      result.push(memory);
      totalTokens += tokens;
    }
    
    return result;
  }
  
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4); // 粗略估计
  }
}
```

**Token成本分析**: **0 tokens** (纯计算)

---

## 总体Token成本分析

| 操作 | Token成本 | 频率 | 总计/100次经历 |
|------|----------|------|---------------|
| 反思合成 | 200 | 每5次 | 4,000 |
| 反思注入 | 100 | 每次retry | 300 |
| 嵌入去重 | 100 | 每次写入 | 10,000 |
| 晋升压缩 | 100 | 每10次 | 1,000 |
| 共识投票 | 0 | 每次写入 | 0 |
| Thompson评分 | 0 | 每次检索 | 0 |
| 扩散激活 | 0 | 每次检索 | 0 |
| **总计** | | | **15,300** |

**平均每次经历: ~153 tokens**

对比Hermes的闭环学习（估计~500-1000 tokens/经历），Commander的方案**token效率提升3-6倍**。

---

## 实现优先级

### Phase 1: 零成本优化 (1周)
1. ✅ 扩散激活替代线性衰减 (0 tokens)
2. ✅ Thompson记忆有用性追踪 (0 tokens)
3. ✅ 规则过滤 + 质量门 (0 tokens)

### Phase 2: 低成本增强 (2周)
4. ✅ 反思滑动窗口注入 (~100 tokens/retry)
5. ✅ 嵌入去重 (~100 tokens/写入)
6. ✅ 晋升压缩 (~100 tokens/晋升)

### Phase 3: 共识学习 (3周)
7. ✅ 反思→记忆管道 (~200 tokens/5次)
8. ✅ 共识门控写入 (0 tokens)
9. ✅ 可观测层 (OTel spans)

---

## 与Hermes的差异化

| 维度 | Hermes | Commander |
|------|--------|-----------|
| 记忆决策 | 单Agent自主 | 多信号共识 |
| 质量保障 | 无 | 4层门控 |
| 可解释性 | 黑盒 | OTel全链路 |
| Token效率 | ~500-1000/经历 | ~153/经历 |
| 自我进化 | GEPA遗传 | Thompson采样 |
| 记忆衰减 | 线性 | 对数(ACT-R) |

**Commander不是"Hermes的劣化版"，而是"更高效、更可控、更透明的学习"。**
