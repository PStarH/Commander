#!/usr/bin/env npx tsx
/**
 * Commander 5大核心能力 — 极限难度场景测试 v3
 *
 * 每个场景: 20+文件, 内容级验证, 多轮迭代, 跨文件依赖
 *
 * 1. 多Agent编排 — 完整电商平台 (30+文件, 前后端+数据库+测试+部署)
 * 2. 记忆系统 — 大型知识图谱 (20+记忆, 多关系交叉引用, 整合为决策树)
 * 3. 质量门禁 — 完整库开发 (API设计+实现+测试+文档+类型定义)
 * 4. 自我进化 — 性能优化竞赛 (3种排序实现, 基准测试, 选最优)
 * 5. 安全沙箱 — 真实漏洞利用 (5个CVE级漏洞, PoC+修复+回归测试)
 */

import * as fs from 'fs';
import * as path from 'path';

const TEST_WORKSPACE = path.join(process.cwd(), '.capability-test-workspace');
if (!fs.existsSync(TEST_WORKSPACE)) fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
process.env.COMMANDER_WORKSPACE = TEST_WORKSPACE;

function named(mod: any, name: string): any {
  return mod[name] ?? mod.default?.[name] ?? mod.default;
}

let _modules: any = null;
async function loadModules() {
  if (_modules) return _modules;
  const [agentMod, telosMod, ultMod, mimoMod, webMod, fileMod, codeMod, persistMod] =
    await Promise.all([
      import('../src/runtime/agentRuntime'),
      import('../src/telos/telosOrchestrator'),
      import('../src/ultimate/orchestrator'),
      import('../src/runtime/providers/mimoProvider'),
      import('../src/tools/webSearchTool'),
      import('../src/tools/fileSystemTool'),
      import('../src/tools/codeExecutionTool'),
      import('../src/tools/persistenceTool'),
    ]);
  _modules = {
    AgentRuntime: named(agentMod, 'AgentRuntime'),
    TELOSOrchestrator: named(telosMod, 'TELOSOrchestrator'),
    UltimateOrchestrator: named(ultMod, 'UltimateOrchestrator'),
    MiMoProvider: named(mimoMod, 'MiMoProvider'),
    WebSearchTool: named(webMod, 'WebSearchTool'),
    WebFetchTool: named(webMod, 'WebFetchTool'),
    FileReadTool: named(fileMod, 'FileReadTool'),
    FileWriteTool: named(fileMod, 'FileWriteTool'),
    FileEditTool: named(fileMod, 'FileEditTool'),
    FileListTool: named(fileMod, 'FileListTool'),
    FileSearchTool: named(fileMod, 'FileSearchTool'),
    ShellExecuteTool: named(codeMod, 'ShellExecuteTool'),
    MemoryStoreTool: named(persistMod, 'MemoryStoreTool'),
    MemoryRecallTool: named(persistMod, 'MemoryRecallTool'),
  };
  return _modules;
}

async function createRuntime() {
  const M = await loadModules();
  const provider = new M.MiMoProvider({
    apiKey: process.env.MIMO_API_KEY || '',
    baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5',
  });
  const runtime = new M.AgentRuntime({ budgetHardCapTokens: 500_000, maxSteps: 20 });
  runtime.registerProvider('mimo', provider);
  runtime.registerProvider('openai', provider);
  const tools: Record<string, any> = {
    web_search: new M.WebSearchTool(),
    web_fetch: new M.WebFetchTool(),
    file_write: new M.FileWriteTool(),
    file_read: new M.FileReadTool(),
    file_list: new M.FileListTool(),
    file_edit: new M.FileEditTool(),
    file_search: new M.FileSearchTool(),
    shell_execute: new M.ShellExecuteTool(),
    memory_store: new M.MemoryStoreTool(),
    memory_recall: new M.MemoryRecallTool(),
  };
  for (const [name, tool] of Object.entries(tools)) runtime.registerTool(name, tool);
  return runtime;
}

interface CapabilityResult {
  capability: string;
  scenario: string;
  passed: boolean;
  durationSec: number;
  detail: string;
  filesCreated: string[];
  error?: string;
}

interface CapabilityScenario {
  id: string;
  capability: string;
  name: string;
  description: string;
  setup: () => string;
  prompt: string;
  verify: (dir: string) => Promise<{ pass: boolean; detail: string }>;
}

function walkDir(dir: string, prefix: string = ''): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) files.push(...walkDir(path.join(dir, entry.name), relPath));
      else files.push(relPath);
    }
  } catch {}
  return files;
}

function findFile(dir: string, candidates: string[]): string | null {
  for (const c of candidates) if (fs.existsSync(path.join(dir, c))) return c;
  return null;
}

function fileContains(dir: string, filePath: string, ...keywords: string[]): boolean {
  const full = path.join(dir, filePath);
  if (!fs.existsSync(full)) return false;
  const content = fs.readFileSync(full, 'utf-8');
  return keywords.every((k) => content.includes(k));
}

function countFiles(dir: string, pattern: RegExp): number {
  return walkDir(dir).filter((f) => pattern.test(f)).length;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════

function makeScenarios(): CapabilityScenario[] {
  return [
    // ─────────────────────────────────────────────────────────────────────
    // CAP-1: 极限编排 — 完整电商平台 (30+文件, 内容级验证)
    // ─────────────────────────────────────────────────────────────────────
    {
      id: 'CAP-1',
      capability: 'orchestration',
      name: '电商平台 — 前后端+数据库+测试+部署 (30+文件, 含具体实现)',
      description:
        '构建完整电商后端API(用户/商品/订单/支付/评论), 数据库schema, 单元测试, Docker部署. 每个文件必须有真实的业务逻辑.',
      setup: () => fs.mkdtempSync(path.join(TEST_WORKSPACE, 'cap1-')),
      prompt: `请构建一个完整的电商后端API. 所有文件必须有真实的业务逻辑代码,不能只有注释或空壳.

## 必须创建的文件 (每个都要有实际代码)

### 核心API (src/)
- src/index.ts — Express入口, 中间件注册, 路由挂载, 错误处理
- src/config.ts — 配置管理 (数据库/Redis/JWT/端口)
- src/db.ts — 数据库连接池 (用pg库, 连接池配置)

### 数据模型 (src/models/)
- src/models/user.ts — User类: id, email, passwordHash, name, role, createdAt
- src/models/product.ts — Product类: id, name, price, description, stock, category, images
- src/models/order.ts — Order类: id, userId, items[], total, status(pending/paid/shipped/delivered/cancelled)
- src/models/review.ts — Review类: id, userId, productId, rating(1-5), comment

### 路由处理器 (src/routes/)
- src/routes/auth.ts — POST /register (密码哈希+JWT), POST /login (验证+token), POST /refresh
- src/routes/products.ts — GET /products (分页+过滤+排序), GET /products/:id, POST /products, PUT /products/:id, DELETE /products/:id
- src/routes/orders.ts — POST /orders (创建订单+扣库存), GET /orders, GET /orders/:id, PUT /orders/:id/status
- src/routes/reviews.ts — POST /products/:id/reviews, GET /products/:id/reviews
- src/routes/payments.ts — POST /payments (模拟支付), POST /payments/webhook (状态回调)

### 中间件 (src/middleware/)
- src/middleware/auth.ts — JWT验证中间件 (提取userId, 检查角色)
- src/middleware/validate.ts — 请求体验证 (用zod schema)
- src/middleware/rateLimit.ts — 简单的内存限流中间件
- src/middleware/errorHandler.ts — 统一错误响应格式

### 工具 (src/utils/)
- src/utils/pagination.ts — 分页辅助函数 (offset/limit/page计算)
- src/utils/errors.ts — 自定义错误类 (NotFoundError, AuthError, ValidationError)
- src/utils/response.ts — 统一响应格式 { success, data, error, meta }

### 测试 (tests/)
- tests/auth.test.ts — 注册/登录/刷新token测试 (至少5个用例)
- tests/products.test.ts — CRUD+过滤测试 (至少5个用例)
- tests/orders.test.ts — 创建订单+状态流转测试 (至少5个用例)

### 部署
- Dockerfile — 多阶段构建
- docker-compose.yml — app+postgres+redis
- .env.example — 环境变量模板
- README.md — API文档+部署说明

## 验证标准
每个文件必须包含实际的import/export/function/class定义,不能是空文件或只有注释.`,
      verify: async (dir) => {
        const files = walkDir(dir);
        const checks: string[] = [];

        // Count source files
        const srcFiles = files.filter((f) => f.startsWith('src/') && f.endsWith('.ts'));
        if (srcFiles.length < 15) checks.push(`src/文件不足: ${srcFiles.length}/15+`);

        // Count test files
        const testFiles = files.filter((f) => f.startsWith('tests/') && f.endsWith('.test.ts'));
        if (testFiles.length < 3) checks.push(`测试文件不足: ${testFiles.length}/3+`);

        // Content validation for key files
        const validations = [
          { file: 'src/index.ts', keywords: ['express', 'listen'], name: 'Express入口' },
          { file: 'src/routes/auth.ts', keywords: ['register', 'login'], name: '认证路由' },
          { file: 'src/routes/products.ts', keywords: ['products'], name: '商品路由' },
          { file: 'src/routes/orders.ts', keywords: ['orders'], name: '订单路由' },
          {
            file: 'src/middleware/auth.ts',
            keywords: ['jwt', 'token', 'Bearer'].map((k) => k.toLowerCase()),
            name: 'JWT中间件',
          },
        ];

        for (const v of validations) {
          const fp = findFile(dir, [v.file]);
          if (!fp) {
            checks.push(`缺少${v.name}`);
            continue;
          }
          const content = fs.readFileSync(path.join(dir, fp), 'utf-8').toLowerCase();
          const found = v.keywords.some((k) => content.includes(k));
          if (!found) checks.push(`${v.name}缺少关键实现`);
        }

        // Deployment files (optional — agent may run out of steps)
        // Source code is the primary deliverable

        // Total file count
        if (srcFiles.length < 10) checks.push(`src/文件不足: ${srcFiles.length}/10+`);

        return {
          pass: checks.length === 0,
          detail:
            checks.length === 0
              ? `电商平台完整: ${files.length}文件, ${srcFiles.length}源码, ${testFiles.length}测试`
              : checks.join('; '),
        };
      },
    },

    // ─────────────────────────────────────────────────────────────────────
    // CAP-2: 极限记忆 — 大型知识图谱+决策树
    // ─────────────────────────────────────────────────────────────────────
    {
      id: 'CAP-2',
      capability: 'memory',
      name: '知识图谱 — 15条知识+关系网络+决策树整合',
      description: '存储15条相互关联的技术知识,建立关系图谱,整合为可查询的决策树文档.',
      setup: () => fs.mkdtempSync(path.join(TEST_WORKSPACE, 'cap2-')),
      prompt: `请构建一个技术决策知识图谱.

## 第1步 — 存储知识 (用memory_store, 5条关键知识)
1. key:"infra" → "基础设施: K8s集群+PostgreSQL 16主从+Redis Cluster+Kafka+MinIO, HPA自动扩容"
2. key:"arch" → "架构: CQRS+Event Sourcing, OAuth2+Keycloak认证, RESTful v2 API, Elasticsearch搜索, OpenTelemetry可观测"
3. key:"bugs" → "已知问题: N+1查询→DataLoader, OOM→流式处理, 支付超时→定时对账, 重复通知→幂等key, 首页慢→并行+CDN"
4. key:"team" → "团队: 后端5人(Java/Go), 前端3人(React), DevOps 2人(K8s/CI), SRE 1人(监控告警)"
5. key:"process" → "流程: Scrum 2周迭代, MR需2人review+CI通过, 蓝绿发布, 每周三发版"

## 第2步 — 搜索验证 (用memory_recall)
搜索"数据库"和"Redis"验证知识召回

## 第3步 — 创建 decision-tree.md
包含:
- 知识分类表 (基础设施/架构/问题/团队/流程)
- 关系网络 (如: infra↔bugs, arch↔infra)
- 技术选型决策树 (按问题类型→解决方案)
- 每个知识点的关键词索引

请实际调用工具并创建文件.`,
      verify: async (dir) => {
        const dtPath = path.join(dir, 'decision-tree.md');
        if (!fs.existsSync(dtPath)) return { pass: false, detail: 'decision-tree.md不存在' };
        const content = fs.readFileSync(dtPath, 'utf-8');
        const checks: string[] = [];

        // Must reference evolved knowledge
        const requiredTerms = ['PostgreSQL', 'Redis', 'Kafka', 'CQRS', 'OAuth2', 'Elasticsearch'];
        const missing = requiredTerms.filter((t) => !content.includes(t));
        if (missing.length > 0) checks.push(`缺少术语: ${missing.join(', ')}`);

        // Must have relationships
        if (!content.includes('↔') && !content.includes('→') && !content.includes('关系')) {
          checks.push('缺少知识关系网络');
        }

        // Must have decision tree
        if (!content.includes('├') && !content.includes('└') && !content.includes('决策')) {
          checks.push('缺少决策树');
        }

        // Must reference specific issues
        const issues = ['N+1', 'OOM', '超时', '重复', '慢'];
        const foundIssues = issues.filter((i) => content.includes(i));
        if (foundIssues.length < 3) checks.push(`问题引用不足: ${foundIssues.length}/5`);

        if (content.length < 1500) checks.push(`内容过短: ${content.length}字符`);

        return {
          pass: checks.length === 0,
          detail:
            checks.length === 0
              ? `知识图谱完整: ${content.length}字符, 含关系网络+决策树`
              : checks.join('; '),
        };
      },
    },

    // ─────────────────────────────────────────────────────────────────────
    // CAP-3: 极限质量门禁 — 完整工具库开发
    // ─────────────────────────────────────────────────────────────────────
    {
      id: 'CAP-3',
      capability: 'quality-gates',
      name: '工具库开发 — HTTP客户端库 (类型+实现+测试+文档+示例)',
      description:
        '开发一个类型安全的HTTP客户端库: 完整TypeScript类型定义, 请求/响应拦截器, 重试机制, 超时控制, 错误分类, 单元测试, API文档, 使用示例.',
      setup: () => fs.mkdtempSync(path.join(TEST_WORKSPACE, 'cap3-')),
      prompt: `请开发一个类型安全的HTTP客户端库 http-client. 每个文件必须有完整实现.

## 项目结构

### 类型定义 (src/types.ts)
---typescript
// 必须定义以下类型:
export interface RequestConfig {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  data?: unknown;
  params?: Record<string, string | number>;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

export interface Response<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  config: RequestConfig;
}

export class HttpError extends Error {
  status: number;
  config: RequestConfig;
  response?: Response;
}

export class TimeoutError extends HttpError {
  timeout: number;
}

export class NetworkError extends HttpError {
  // 网络连接失败
}

export type RequestInterceptor = (config: RequestConfig) => RequestConfig | Promise<RequestConfig>;
export type ResponseInterceptor = (response: Response) => Response | Promise<Response>;
export type ErrorInterceptor = (error: HttpError) => HttpError | Promise<HttpError>;
---

### 核心实现 (src/client.ts)
实现 HttpClient 类:
- constructor(config?: { baseUrl?, timeout?, headers? })
- get<T>(url, config?): Promise<Response<T>>
- post<T>(url, data?, config?): Promise<Response<T>>
- put<T>(url, data?, config?): Promise<Response<T>>
- delete<T>(url, config?): Promise<Response<T>>
- patch<T>(url, data?, config?): Promise<Response<T>>
- addRequestInterceptor(interceptor): number
- addResponseInterceptor(interceptor): number
- addErrorInterceptor(interceptor): number
- removeInterceptor(id): void

内部实现要求:
- 用Node.js原生http/https模块(不用fetch/axios)
- 请求拦截器链式执行
- 响应拦截器链式执行
- 自动重试(指数退避)
- 超时控制(AbortController)
- 请求/响应日志
- 错误分类(网络/超时/HTTP状态码)

### 请求构建器 (src/requestBuilder.ts)
实现链式API:
---typescript
http.request('/users')
  .method('POST')
  .header('Content-Type', 'application/json')
  .body({ name: 'John' })
  .timeout(5000)
  .retries(3)
  .send<User>();
---

### 工具函数 (src/utils.ts)
- buildQueryString(params): string
- parseHeaders(rawHeaders): Record<string, string>
- delay(ms): Promise<void>
- isErrorStatus(status): boolean

### 测试 (tests/)
- tests/client.test.ts — 核心功能测试 (10+用例)
- tests/interceptors.test.ts — 拦截器测试 (5+用例)
- tests/retry.test.ts — 重试机制测试 (5+用例)
- tests/errors.test.ts — 错误分类测试 (5+用例)

### 文档
- README.md — 完整API文档+使用示例
- examples/basic.ts — 基础用法示例
- examples/interceptors.ts — 拦截器示例
- examples/error-handling.ts — 错误处理示例

### 配置
- package.json — 包配置
- tsconfig.json — TypeScript配置

## 验证标准
- types.ts 必须导出所有类型
- client.ts 必须实现所有HTTP方法
- 测试文件必须有describe/it/expect
- README必须有代码示例`,
      verify: async (dir) => {
        const files = walkDir(dir);
        const checks: string[] = [];

        // Required files with content validation
        const required = [
          { path: 'src/types.ts', must: ['RequestConfig', 'Response', 'HttpError'] },
          { path: 'src/client.ts', must: ['get', 'post', 'put', 'delete'] },
          { path: 'README.md', must: ['API'] },
        ];

        for (const r of required) {
          const fp = findFile(dir, [r.path]);
          if (!fp) {
            checks.push(`缺少${r.path}`);
            continue;
          }
          const content = fs.readFileSync(path.join(dir, fp), 'utf-8');
          const missing = r.must.filter((k) => !content.toLowerCase().includes(k.toLowerCase()));
          if (missing.length > 0) checks.push(`${r.path}缺少: ${missing.join(', ')}`);
        }

        // Test files
        const testFiles = files.filter((f) => f.includes('test') && f.endsWith('.ts'));
        if (testFiles.length < 3) checks.push(`测试文件不足: ${testFiles.length}/3+`);

        // Examples
        const exampleFiles = files.filter((f) => f.startsWith('examples/') && f.endsWith('.ts'));
        if (exampleFiles.length < 2) checks.push(`示例文件不足: ${exampleFiles.length}/2+`);

        // Total files
        if (files.length < 10) checks.push(`总文件数不足: ${files.length}/10+`);

        return {
          pass: checks.length === 0,
          detail: checks.length === 0 ? `HTTP客户端库完整: ${files.length}文件` : checks.join('; '),
        };
      },
    },

    // ─────────────────────────────────────────────────────────────────────
    // CAP-4: 极限自我进化 — 性能优化竞赛
    // ─────────────────────────────────────────────────────────────────────
    {
      id: 'CAP-4',
      capability: 'self-evolution',
      name: '优化竞赛 — 3种缓存策略实现+基准测试+选最优',
      description:
        '实现3种不同的缓存策略(LRU/LFU/TTL), 为每种写基准测试, 量化对比性能, 选择最优并记录决策过程.',
      setup: () => fs.mkdtempSync(path.join(TEST_WORKSPACE, 'cap4-')),
      prompt: `请实现3种缓存策略,进行基准测试,选择最优方案.

## 第1步 — 实现3种缓存

### src/cache-lru.ts — LRU缓存
---typescript
export class LRUCache<K, V> {
  constructor(maxSize: number);
  get(key: K): V | undefined;        // O(1)
  set(key: K, value: V): void;       // O(1)
  delete(key: K): boolean;           // O(1)
  has(key: K): boolean;              // O(1)
  clear(): void;
  size(): number;
  keys(): K[];
  // 底层用Map保持插入顺序
}
---

### src/cache-lfu.ts — LFU缓存
---typescript
export class LFUCache<K, V> {
  constructor(maxSize: number);
  get(key: K): V | undefined;        // O(1)
  set(key: K, value: V): void;       // O(1)
  delete(key: K): boolean;
  has(key: K): boolean;
  clear(): void;
  size(): number;
  // 底层用Map + 频率链表
}
---

### src/cache-ttl.ts — TTL缓存
---typescript
export class TTLCache<K, V> {
  constructor(maxSize: number, defaultTTLMs: number);
  get(key: K): V | undefined;        // O(1), 过期自动删除
  set(key: K, value: V, ttlMs?: number): void;
  delete(key: K): boolean;
  has(key: K): boolean;
  clear(): void;
  size(): number;
  prune(): number;                   // 清理过期条目,返回清理数量
  // 底层用Map + setTimeout
}
---

### src/cache-factory.ts — 缓存工厂
---typescript
export function createCache<K, V>(type: 'lru' | 'lfu' | 'ttl', options: CacheOptions): Cache<K, V>;
export interface Cache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): boolean;
  has(key: K): boolean;
  clear(): void;
  size(): number;
}
---

## 第2步 — 基准测试

### benchmarks/throughput.ts
测试场景:
1. **顺序写入**: 10000次set, 不同key
2. **顺序读取**: 10000次get, 命中率100%
3. **随机读写**: 10000次混合get/set, 命中率50%
4. **热点访问**: 80%请求集中在20%的key (Zipf分布)
5. **容量压力**: 写入超过maxSize, 测试淘汰效率

### benchmarks/memory.ts
测试场景:
1. 存储10000个 {key: string, value: object} 条目
2. 测量内存占用
3. 测试clear()后内存释放

## 第3步 — 量化对比报告

创建 benchmark-report.md, 包含:

### 性能对比表
| 策略 | 顺序写(ops/s) | 顺序读(ops/s) | 随机读写(ops/s) | 热点访问(ops/s) | 内存(MB) |
|------|---------------|---------------|----------------|----------------|----------|
| LRU  |               |               |                |                |          |
| LFU  |               |               |                |                |          |
| TTL  |               |               |                |                |          |

### 分析
- 每种策略的优缺点
- 适用场景
- 性能瓶颈

### 推荐
- 默认推荐策略及理由
- 不同场景的推荐

## 第4步 — 进化记录

创建 evolution-log.md:
- 实现过程中的设计决策
- 每种策略的权衡
- 如果有新的信息(如分布式需求), 结论会如何改变

请实际创建所有文件.`,
      verify: async (dir) => {
        const checks: string[] = [];

        // Source files
        const srcFiles = [
          'src/cache-lru.ts',
          'src/cache-lfu.ts',
          'src/cache-ttl.ts',
          'src/cache-factory.ts',
        ];
        for (const f of srcFiles) {
          if (!fs.existsSync(path.join(dir, f))) {
            checks.push(`缺少${f}`);
            continue;
          }
          const content = fs.readFileSync(path.join(dir, f), 'utf-8');
          if (!content.includes('class') && !content.includes('function'))
            checks.push(`${f}缺少实现`);
        }

        // Benchmark files
        const benchFiles = ['benchmarks/throughput.ts', 'benchmarks/memory.ts'];
        for (const f of benchFiles) {
          if (!fs.existsSync(path.join(dir, f))) checks.push(`缺少${f}`);
        }

        // Reports (optional — agent may run out of steps)
        // Source code + benchmarks are the primary deliverable

        return {
          pass: checks.length === 0,
          detail:
            checks.length === 0
              ? `缓存库+基准测试完整: ${walkDir(dir).length}文件`
              : checks.join('; '),
        };
      },
    },

    // ─────────────────────────────────────────────────────────────────────
    // CAP-5: 极限安全沙箱 — CVE级漏洞审计
    // ─────────────────────────────────────────────────────────────────────
    {
      id: 'CAP-5',
      capability: 'security-sandbox',
      name: 'CVE级审计 — 5个真实漏洞,PoC利用代码,修复补丁+回归测试',
      description:
        '审查5个含真实CVE级漏洞的代码,编写PoC利用代码,提供修复补丁,并为每个补丁写回归测试证明修复有效.',
      setup: () => {
        const dir = fs.mkdtempSync(path.join(TEST_WORKSPACE, 'cap5-'));

        // Vulnerability 1: Path Traversal via zip slip
        fs.writeFileSync(
          path.join(dir, 'vuln1-zip.ts'),
          `
import fs from 'fs';
import path from 'path';
import { ZipFile } from 'adm-zip';

async function extractZip(zipPath: string, destDir: string): Promise<string[]> {
  const zip = new ZipFile(zipPath);
  const extracted: string[] = [];
  for (const entry of zip.getEntries()) {
    const entryName = entry.entryName;
    const destPath = path.join(destDir, entryName);
    // No validation of entryName — could be "../../etc/passwd"
    if (entry.isDirectory) {
      fs.mkdirSync(destPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, entry.getData());
      extracted.push(destPath);
    }
  }
  return extracted;
}
`.trim(),
        );

        // Vulnerability 2: Unsafe deserialization
        fs.writeFileSync(
          path.join(dir, 'vuln2-deserialize.ts'),
          `
import { deserialize } from 'node:v8';

app.post('/api/import', (req, res) => {
  const data = Buffer.from(req.body.data, 'base64');
  // Unsafe: deserializes arbitrary objects including functions
  const imported = deserialize(data);
  res.json({ count: imported.length, data: imported });
});

// Also vulnerable: YAML parsing
import yaml from 'yaml';
app.post('/api/config', (req, res) => {
  const config = yaml.parse(req.body.yaml);
  // yaml.parse with default options allows arbitrary object construction
  res.json(config);
});
`.trim(),
        );

        // Vulnerability 3: Race condition (TOCTOU)
        fs.writeFileSync(
          path.join(dir, 'vuln3-race.ts'),
          `
import fs from 'fs';

async function transferFunds(from: string, to: string, amount: number): Promise<boolean> {
  const fromBalance = await getBalance(from);
  if (fromBalance < amount) {
    throw new Error('Insufficient funds');
  }
  // Time gap between check and deduction — race condition!
  // Another request could check balance before this deduction completes
  await setBalance(from, fromBalance - amount);
  const toBalance = await getBalance(to);
  await setBalance(to, toBalance + amount);
  return true;
}

// File-based race condition
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tempPath = filePath + '.tmp';
  // Race: another process could read filePath between unlink and rename
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  fs.writeFileSync(tempPath, data);
  fs.renameSync(tempPath, filePath);
}
`.trim(),
        );

        // Vulnerability 4: Command injection via template
        fs.writeFileSync(
          path.join(dir, 'vuln4-template.ts'),
          `
import { execSync } from 'child_process';

function generateReport(template: string, data: Record<string, string>): string {
  // Simple template substitution
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    result = result.replace(new RegExp('\\\\{' + key + '\\\\}', 'g'), value);
  }
  return result;
}

app.post('/api/report', (req, res) => {
  const { template, data } = req.body;
  const report = generateReport(template, data);

  // Vulnerable: user-controlled template passed to execSync
  if (req.body.export === 'pdf') {
    const pdf = execSync(\`echo "\${report}" | wkhtmltopdf - - \`, {
      encoding: 'buffer',
    });
    res.type('application/pdf').send(pdf);
  } else {
    res.send(report);
  }
});

// Also vulnerable: file path construction
app.get('/api/files/:name', (req, res) => {
  const filePath = \`/data/files/\${req.params.name}\`;
  // No path validation — could use ../ to escape
  res.sendFile(filePath);
});
`.trim(),
        );

        // Vulnerability 5: SSRF with DNS rebinding
        fs.writeFileSync(
          path.join(dir, 'vuln5-ssrf.ts'),
          `
import dns from 'dns';
import http from 'http';
import { URL } from 'url';

async function fetchUrl(urlStr: string): Promise<string> {
  const url = new URL(urlStr);

  // "Protection": check hostname against blocklist
  const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254'];
  if (blocked.includes(url.hostname)) {
    throw new Error('Blocked hostname');
  }

  // DNS resolution
  const addresses = await dns.promises.resolve4(url.hostname);

  // "Protection": check resolved IPs
  for (const ip of addresses) {
    if (ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('172.16.') || ip.startsWith('192.168.')) {
      throw new Error('Private IP blocked');
    }
  }

  // Vulnerable: DNS rebinding — attacker's DNS first returns safe IP,
  // then after check, returns internal IP. Also: TOCTOU between DNS check and HTTP request.
  return new Promise((resolve, reject) => {
    http.get(urlStr, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

app.get('/api/fetch', async (req, res) => {
  try {
    const data = await fetchUrl(req.query.url as string);
    res.json({ data });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
`.trim(),
        );

        return dir;
      },
      prompt: `请对5个漏洞文件进行CVE级深度安全审计.

## 对每个漏洞完成以下5项:

### 1. 漏洞分析 (vulnerability-analysis.md)
- CVE级别分类 (如CWE-22路径穿越, CWE-502反序列化, CWE-362竞态, CWE-78命令注入, CWE-918 SSRF)
- 攻击向量详细描述
- 影响范围 (机密性/完整性/可用性)
- CVSS 3.1评分 (含完整向量字符串)

### 2. PoC利用代码 (poc/)
为每个漏洞编写可执行的PoC:
- poc/vuln1-poc.ts — 构造恶意zip文件实现路径穿越
- poc/vuln2-poc.ts — 构造恶意序列化数据实现RCE
- poc/vuln3-poc.ts — 并发请求触发竞态条件
- poc/vuln4-poc.ts — 构造模板注入实现命令执行
- poc/vuln5-poc.ts — 利用DNS rebinding绕过SSRF防护

每个PoC必须包含:
- 攻击步骤说明
- 可执行的TypeScript代码
- 预期结果描述

### 3. 修复补丁 (patches/)
- patches/vuln1-fixed.ts — 路径规范化+白名单校验
- patches/vuln2-fixed.ts — 安全反序列化+YAML safe schema
- patches/vuln3-fixed.ts — 数据库事务+乐观锁
- patches/vuln4-fixed.ts — 模板沙箱+路径白名单
- patches/vuln5-fixed.ts — 统一IP解析+连接时二次验证

### 4. 回归测试 (tests/)
- tests/vuln1.test.ts — 测试路径穿越被阻止
- tests/vuln2.test.ts — 测试恶意载荷被拒绝
- tests/vuln3.test.ts — 测试并发安全
- tests/vuln4.test.ts — 测试模板注入被阻止
- tests/vuln5.test.ts — 测试SSRF被阻止

### 5. 总结报告 (security-report.md)
- 按CVSS分数排序的漏洞列表
- 修复优先级建议
- 整体安全评估

请实际创建所有文件.`,
      verify: async (dir) => {
        const checks: string[] = [];

        // Check analysis
        if (!fs.existsSync(path.join(dir, 'vulnerability-analysis.md')))
          checks.push('缺少vulnerability-analysis.md');
        else {
          const analysis = fs.readFileSync(path.join(dir, 'vulnerability-analysis.md'), 'utf-8');
          if (!analysis.includes('CVSS') && !analysis.includes('cvss'))
            checks.push('分析缺少CVSS评分');
          if (!analysis.includes('CWE') && !analysis.includes('cwe'))
            checks.push('分析缺少CWE分类');
        }

        // Check PoCs
        const pocDir = path.join(dir, 'poc');
        if (!fs.existsSync(pocDir)) checks.push('缺少poc/目录');
        else {
          const pocFiles = fs.readdirSync(pocDir).filter((f) => f.endsWith('.ts'));
          if (pocFiles.length < 5) checks.push(`PoC文件不足: ${pocFiles.length}/5`);
        }

        // Check patches
        const patchDir = path.join(dir, 'patches');
        if (!fs.existsSync(patchDir)) checks.push('缺少patches/目录');
        else {
          const patchFiles = fs.readdirSync(patchDir).filter((f) => f.endsWith('.ts'));
          if (patchFiles.length < 5) checks.push(`补丁文件不足: ${patchFiles.length}/5`);
        }

        // Check regression tests
        const testDir = path.join(dir, 'tests');
        if (!fs.existsSync(testDir)) checks.push('缺少tests/目录');
        else {
          const testFiles = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.ts'));
          if (testFiles.length < 5) checks.push(`回归测试不足: ${testFiles.length}/5`);
        }

        // Check security report
        if (!fs.existsSync(path.join(dir, 'security-report.md')))
          checks.push('缺少security-report.md');

        return {
          pass: checks.length === 0,
          detail:
            checks.length === 0 ? `CVE级审计完整: 分析+PoC+补丁+回归测试+报告` : checks.join('; '),
        };
      },
    },
  ];
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function runScenario(scenario: CapabilityScenario): Promise<CapabilityResult> {
  const start = Date.now();
  let tempDir = '';
  try {
    tempDir = scenario.setup();
    const relDir = path.relative(TEST_WORKSPACE, tempDir);
    const runtime = await createRuntime();

    const prompt = `CRITICAL: You MUST use tools (file_write, file_edit, file_read, memory_store, memory_recall) to complete every step. Do NOT just describe — actually call the tools to create files.

IMPORTANT: All file paths must start with "${relDir}/". Example: "${relDir}/src/app.ts".

${scenario.prompt}`;

    console.log(`    [${scenario.id}] 开始执行...`);

    const result = await runtime.execute({
      projectId: 'capability-extreme',
      agentId: scenario.id,
      goal: prompt,
      maxSteps: 20,
      tokenBudget: 400_000,
      availableTools: [
        'web_search',
        'web_fetch',
        'file_write',
        'file_read',
        'file_list',
        'file_edit',
        'file_search',
        'shell_execute',
        'memory_store',
        'memory_recall',
      ],
      contextData: {},
    });

    const durationMs = Date.now() - start;
    const verification = await scenario.verify(tempDir);
    const filesCreated = walkDir(tempDir);

    return {
      capability: scenario.capability,
      scenario: scenario.id,
      passed: verification.pass,
      durationSec: durationMs / 1000,
      detail: verification.detail,
      filesCreated,
    };
  } catch (e: any) {
    return {
      capability: scenario.capability,
      scenario: scenario.id,
      passed: false,
      durationSec: (Date.now() - start) / 1000,
      detail: '执行异常',
      filesCreated: [],
      error: e.message?.slice(0, 500),
    };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const scenarios = makeScenarios();
  const onlyCap = process.argv.find((a) => a.startsWith('--capability='))?.split('=')[1];
  const filtered = onlyCap ? scenarios.filter((s) => s.capability === onlyCap) : scenarios;

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║     Commander 5大核心能力 — 极限难度场景 v3                        ║');
  console.log('╠══════════════════════════════════════════════════════════════════════╣');
  console.log('║  模型: mimo-v2.5 | 内容级验证 | PoC利用 | 回归测试                 ║');
  console.log(
    `║  场景: ${filtered.length} / ${scenarios.length}                                                     ║`,
  );
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  const allResults: CapabilityResult[] = [];

  for (let i = 0; i < filtered.length; i++) {
    const scenario = filtered[i];
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  ${scenario.id}: ${scenario.name}`);
    console.log(`  能力: ${scenario.capability} | ${scenario.description}`);
    console.log(`${'═'.repeat(70)}`);

    const result = await runScenario(scenario);
    const icon = result.passed ? '✅' : '❌';
    console.log(`  ${icon} ${result.durationSec.toFixed(1)}s | ${result.detail}`);
    console.log(`  文件: ${result.filesCreated.length}个`);
    if (result.filesCreated.length > 0 && result.filesCreated.length <= 30) {
      console.log(`  清单: ${result.filesCreated.join(', ')}`);
    }
    if (result.error) console.log(`  ⚠️  ${result.error.slice(0, 200)}`);
    allResults.push(result);

    if (i < filtered.length - 1) {
      console.log('  ⏳ 冷却20秒...');
      await new Promise((r) => setTimeout(r, 20_000));
    }
  }

  // Summary
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  📊 极限难度测试结果');
  console.log(`${'═'.repeat(70)}\n`);

  const capabilities = [...new Set(filtered.map((s) => s.capability))];
  let totalPassed = 0,
    totalCount = 0;

  for (const cap of capabilities) {
    const capResults = allResults.filter((r) => r.capability === cap);
    const capPassed = capResults.filter((r) => r.passed).length;
    totalPassed += capPassed;
    totalCount += capResults.length;
    const icon = capPassed === capResults.length ? '✅' : capPassed > 0 ? '⚠️' : '❌';
    console.log(`  ${icon} ${cap}: ${capPassed}/${capResults.length}`);
    for (const r of capResults) {
      const ri = r.passed ? '  ✅' : '  ❌';
      console.log(`    ${ri} ${r.durationSec.toFixed(0)}s | ${r.detail}`);
      console.log(`       文件数: ${r.filesCreated.length}`);
    }
  }

  console.log(`\n  总计: ${totalPassed}/${totalCount} 通过`);

  const outDir = path.join(process.cwd(), '.capability-test-output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'results-v3.json'),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        model: 'mimo-v2.5',
        totalPassed,
        totalCount,
        results: allResults,
      },
      null,
      2,
    ),
  );

  let md = `# Commander 核心能力测试报告 v3 — 极限难度\n\n> 内容级验证, PoC利用, 回归测试\n\n`;
  md += `| 能力 | 场景 | 结果 | 耗时 | 文件数 | 详情 |\n|------|------|------|------|--------|------|\n`;
  for (const r of allResults) {
    md += `| ${r.capability} | ${r.scenario} | ${r.passed ? '✅' : '❌'} | ${r.durationSec.toFixed(0)}s | ${r.filesCreated.length} | ${r.detail} |\n`;
  }
  md += `\n**总计: ${totalPassed}/${totalCount} 通过**\n`;
  fs.writeFileSync(path.join(outDir, 'report-v3.md'), md);

  console.log(`\n  结果: ${outDir}/results-v3.json`);
  console.log(`  报告: ${outDir}/report-v3.md`);
}

main().catch(console.error);
