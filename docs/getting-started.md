# Commander 快速开始

5 分钟内在本地跑起来，并通过 CLI 或 Web Console 运行第一个多代理任务。

下文默认是 **Local CLI / 本地单机** 路径。Enterprise Gateway（`/v1` + Postgres）见英文 `README.md` SKU 表与 `ENTERPRISE_READINESS.md`，状态为 **alpha**。

---

## 前置要求

- **Node.js** >= 18（推荐 22，与 `.node-version` 一致）
- **pnpm** >= 9（必须，项目使用 pnpm workspaces）
- 任一 LLM 提供商的 API key：OpenAI、Anthropic、DeepSeek、Groq 等

> 为什么用 pnpm？Monorepo 通过 workspaces 管理 10+ 个包，`npm install` 会产生 `UNMET DEPENDENCY` 警告。

---

## 1. 克隆与安装

```bash
git clone https://github.com/PStarH/Commander.git
cd Commander
pnpm install
```

安装完成后，建议先构建一次所有包：

```bash
pnpm -r build
```

---

## 2. 配置 API Key

Commander 会自动识别你设置的是哪家提供商：

```bash
export OPENAI_API_KEY=sk-...
# 或
export ANTHROPIC_API_KEY=sk-ant-...
# 或
export DEEPSEEK_API_KEY=sk-...
```

支持的完整列表见 `packages/core/src/providers/`。

---

## 3. 运行第一个任务

### 方式 A：Web Console（推荐，一键启动）

```bash
pnpm gui
```

这会同时启动 API server（`:4000`）和 Web 界面（`:3000`），并尝试自动打开浏览器。

### 方式 B：终端 CLI

```bash
pnpm exec tsx packages/core/src/cliEntry.ts run "audit this repo for security vulnerabilities" --stream
```

`--stream` 会实时输出每个代理的思考、工具调用和质量门决策。

---

## 4. Docker 一键启动

如果你不想在本地装 Node：

```bash
export COMMANDER_API_KEY="your-secret-key"
export OPENAI_API_KEY="sk-..."
docker compose up -d
```

- API: http://localhost:4000
- Web: http://localhost:3000

---

## 5. 验证安装

```bash
pnpm --filter @commander/core test:quick
```

这会运行核心单元测试的安全子集（约 30 秒）。

---

## 6. 下一步

- 查看架构概览：`docs/architecture/`
- 查看 CLI 全部命令：`pnpm exec tsx packages/core/src/cliEntry.ts --help`
- 查看 OpenAPI 规范：启动 API 后访问 http://localhost:4000/openapi.json

---

## 常见问题

### `better-sqlite3` 安装失败

项目依赖 `better-sqlite3`，它需要本地编译。确保：

1. Node 版本与 `.node-version` 一致（Node 22）。
2. 已安装 Python 3 和 C++ 编译工具：
   - macOS: `xcode-select --install`
   - Windows: Visual Studio Build Tools
   - Linux: `build-essential`

如果仍失败，可设置 `COMMANDER_STORAGE=memory` 跳过 SQLite 持久化。

### `npm install` 出现 UNMET DEPENDENCY

请使用 `pnpm install`。README 和 CI 均以 pnpm 为准。
