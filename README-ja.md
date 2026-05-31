<p align="center">
  <img src="https://img.shields.io/badge/GAIA-69.7%25-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/PinchBench-97.7%25-green?style=flat-square" />
  <img src="https://img.shields.io/badge/HumanEval+-91.5%25-orange?style=flat-square" />
  <img src="https://img.shields.io/badge/providers-21-purple?style=flat-square" />
  <img src="https://img.shields.io/badge/topologies-8-red?style=flat-square" />
  <img src="https://img.shields.io/badge/license-MIT-yellow?style=flat-square" />
</p>

<h1 align="center">Commander</h1>
<p align="center"><strong>AI が何をしているか見えるように。結果を信頼して。コストを削減。</strong></p>

<p align="center">
  <code>npx tsx cli.ts watch "investigate this bug"</code><br>
  <sub>インストール不要。ワンコマンド。マルチエージェントの推論ストリームをリアルタイムでターミナルに表示。</sub>
</p>

<p align="center">
  <img src="docs/assets/commander-watch-demo.gif" alt="Commander watch demo — リアルタイムエージェントストリーミング" width="90%">
</p>

---

## Commander の独自性

**透明性——すべてが見える。** 各エージェントの思考、ツール呼び出し、決定が SSE を介してリアルタイムでストリーミングされます。ブラックボックスなし。エージェントの作業をステップバイステップで確認できます。

**信頼性——検証済みの出力。** 品質ゲートが結果を返す前にすべてチェックします。ハルシネーション検出、精度検証、コードコンパイルチェック。信頼できる結果が得られます。

**コスト効率——スマートな支出。** 推論エンジンがトークンを消費する前にタスクを分析します。適切なトポロジを自動選択——単純なタスクには 1 エージェント、複雑なタスクには並列エージェント。実際のコスト：タスクあたり約 $0.10（品質検証込み）。

**22 の LLM プロバイダー。** OpenAI、Anthropic、Google、DeepSeek、Groq、Ollama、Bedrock——環境変数を  つ設定するだけで、Commander が残りを処理します。フォールバックチェーン付き。

**自己改善。** Meta-learner は Thompson Sampling + Reflexion を使用して、実行間でエージェント設定を調整します。使用するほど向上します。

---

## 30 秒デモ

```bash
# tsx があればインストール不要（または pnpm/npx を使用）
npx tsx cli.ts watch "find the bug in src/server.ts and fix it"
```

これはモックアップではありません——実際のエージェント実行からのライブ SSE ストリームの real recording です。すべてのツール呼び出し、すべての決定、すべての検証がリアルタイムでターミナルにストリーミングされます。エージェントの思考を**観察**できます。

---

## 30 秒でわかる仕組み

```bash
# 1. インストール
pnpm install

# 2. API キーを設定（21 プロバイダーから自動検出）
export OPENAI_API_KEY=sk-...

# 3. 何でも実行
npx tsx cli.ts run "analyze this repository"
npx tsx cli.ts plan "implement authentication"    # 実行前に計画を確認
npx tsx cli.ts watch "debug the failing test"     # エージェントの推論をリアルタイム表示
```

---

## Commander と他のフレームワークの比較

| | Commander | LangGraph | CrewAI | AutoGen |
|---|---|---|---|---|
| **ライブ SSE ストリーミング** | ✅ 組み込み | ❌ | ❌ | ❌ |
| **自動トポロジ選択** | ✅ 8 トポロジ | ❌ 手動グラフ構築 | ❌ 固定順序実行 | ❌ 手動オーケストレーション |
| **品質ゲート** | ✅ 多層検証 | ❌ | ❌ | ❌ |
| **ハルシネーション検出** | ✅ 組み込み | ❌ | ❌ | ❌ |
| **推論エンジン** | ✅ スマートタスク分析 | ❌ | ❌ | ❌ |
| **Meta-learner** | ✅ 自動チューニング | ❌ | ❌ | ❌ |
| **プロバイダー数** | ✅ 21 | ❌ 1-2 | ❌ 1-2 | ❌ 1-2 |
| **CLI エクスペリエンス** | ✅ 14 コマンド | ❌ API のみ | ❌ API のみ | ❌ API のみ |
| **Web GUI** | ✅ Agent War Room | ❌ | ❌ | ❌ |
| **TUI ダッシュボード** | ✅ ターミナル UI | ❌ | ❌ | ❌ |

---

## トポロジ

Commander は 8 つのトポロジから最適なものを自動選択します：

```
┌─────────────────────────────────────────────────────────┐
│                    Deliberation Engine                  │
│            タスク分析 → 最適トポロジ選択                  │
├─────────┬─────────┬─────────┬─────────┬─────────────────┤
│ Single  │ Parallel│ Pipeline│ Tree    │ DAG             │
│ Agent   │ Agents  │ Chain   │ Hierarchy│ Workflow        │
├─────────┼─────────┼─────────┼─────────┼─────────────────┤
│ Debate  │ Voting  │ Mixture │         │                 │
│ Council │ Ensemble│ of Exp. │         │                 │
└─────────┴─────────┴─────────┴─────────┴─────────────────┘
```

- **Single Agent** — 単純なクエリ、迅速な回答
- **Parallel Agents** — 複数の独立したサブタスク
- **Pipeline Chain** — 順次処理、段階的な精緻化
- **Tree Hierarchy** — 階層的な委任
- **DAG Workflow** — 依存関係のある複雑なワークフロー
- **Debate Council** — 多角的な議論でより良い結果を獲得
- **Voting Ensemble** — マルチエージェント投票による合意形成
- **Mixture of Experts** — 専門エージェントが各分野を担当

---

## アーキテクチャ

```
src/
├── core/              # コアエンジン
│   ├── agent.ts       # エージェントライフサイクル管理
│   ├── orchestrator.ts# トポロジオーケストレーター
│   ├── deliberation.ts# 推論エンジン
│   └── quality-gates.ts# 多層検証
├── providers/         # 21 LLM プロバイダーアダプター
├── streaming/         # SSE ストリーミングエンジン
├── meta-learner/      # 自動チューニング（Thompson Sampling + Reflexion）
├── cli/               # 14 CLI コマンド
├── web/               # Agent War Room ダッシュボード
└── benchmarks/        # GAIA、BFCL、PinchBench、HumanEval+
```

---

## 品質ゲート

すべての結果は返却前に検証されます：

```
タスク入力 → エージェント実行 → [品質ゲート] → 検証済み出力
                            │
                            ├─ ハルシネーション検出
                            ├─ 精度検証
                            ├─ コードコンパイルチェック
                            ├─ 出力フォーマット検証
                            └─ 信頼度スコア
```

---

## はじめに

### 前提条件

- Node.js ≥ 18
- pnpm（推奨）または npm
- 任意の LLM プロバイダーの API キー

### インストール

```bash
git clone https://github.com/your-org/commander.git
cd commander
pnpm install
```

### 設定

```bash
# サンプル環境ファイルをコピー
cp .env.example .env

# 少なくとも 1 つの API キーを設定
export OPENAI_API_KEY=sk-...
# または
export ANTHROPIC_API_KEY=sk-ant-...
```

### 実行

```bash
# CLI を使用
npx tsx cli.ts run "your task here"

# API を使用
npx tsx examples/api-usage.ts

# Docker を使用
docker compose up -d
```

---

## ベンチマーク

```bash
npx commander benchmark    # A/B テスト：最適版 vs ベースライン
```

---

| ベンチマーク | Commander | ベア LLM (MiMo) | OpenClaw | Δ |
|-----------|:---------:|:----------------:|:--------:|:-:|
| **GAIA**（165 の多段階推論タスク） | **69.7%** | 21.2% | — | **+48.5pp** |
| **BFCL** ツール選択（35 シナリオ非公式サブセット） | **77.1%** | — | — | — |
| **BFCL** パラメータ予測（35 シナリオ非公式サブセット） | **77.1%** | — | — | — |
| **PinchBench**（43 のエージェントタスク） | **100.0%** | — | 89.5% | **+10.5pp** |
| **HumanEval+**（164 の Python 問題） | **96.3%** | — | — | — |

BFCL は本リポジトリで複数の非公式サブセットを使用しています：35 シナリオ汎用サブセット（`benchmarks/bfcl/results_full.json`、77.1% ツール / 77.1% パラメータ）、30 タスク Commander 再実行（`docs/benchmark-results/bfcl/results.json`、80.0% / 80.0%）、および 12 コアサブセット（`benchmarks/bfcl/results.json`、91.7% / 91.7%）。これらはいずれも公式 BFCL リーダーボードの実行結果ではありません。

```bash
# 任意のベンチマークを再現
pnpm --filter @commander/core benchmark:verify  # 提出済み BFCL スコア主張を再計算
pnpm test:core                   # 完全なコアスイート：node:test + vitest
pnpm benchmark:multiagent        # マルチエージェントオーケストレーションベンチマーク
```

---

## コマンド

| コマンド | 機能説明 |
|---------|-------------|
| `commander run <task>` | 完全なマルチエージェント実行 |
| `commander plan <task>` | 実行前にトポロジ、エージェント数、予算を表示 |
| `commander watch <task>` | **キラー機能**——エージェント思考のライブ SSE ストリーム |
| `commander company <task>` | マルチエージェント会社モード：計画 → 構築 → レビュー → 改善 |
| `commander review` | P0-P3 の構造化コードレビュー |
| `commander gui` | Web ダッシュボード（Agent War Room） |
| `commander tui` | ターミナルダッシュボード |
| `commander workers <topics>` | 並列リサーチワーカー |
| `commander mode <mode>` | 計画 / 読み取り専用 / 自動編集 / フルオート / 提案 |
| `commander status` | システムステータス、プロバイダー正常性、MetaLearner 統計 |
| `commander history` | セッション管理 |
| `commander skill` | 学習可能スキル管理 |
| `commander config` | 設定の表示または変更 |
| `commander doctor` | 診断を実行 |

---

## API 使用

```typescript
import { CommanderClient } from '@commander/core';

const client = new CommanderClient({ provider: 'openai' });
await client.connect();
const result = await client.run('analyze this repository');
await client.disconnect();
```

---

## プロバイダー

環境変数を 1 つ設定するだけ。Commander が **21 プロバイダー**から自動検出します：

`OPENAI_API_KEY` · `ANTHROPIC_API_KEY` · `GOOGLE_API_KEY` · `DEEPSEEK_API_KEY` · `ZHIPU_API_KEY` · `MIMO_API_KEY` · `XIAOMI_API_KEY` · `GROQ_API_KEY` · `TOGETHER_API_KEY` · `PERPLEXITY_API_KEY` · `FIREWORKS_API_KEY` · `REPLICATE_API_TOKEN` · `MISTRAL_API_KEY` · `CO_API_KEY` · `OPENROUTER_API_KEY` · `OLLAMA_HOST` · `VLLM_BASE_URL` · `AWS_ACCESS_KEY_ID` (Bedrock) · `XAI_API_KEY` · `ANYSCALE_API_KEY` · `DEEPINFRA_API_KEY`

---

## デプロイ

```bash
# ローカル（Docker Compose）
docker compose up -d
# → API: localhost:4000  |  Web GUI: localhost:3000

# 本番環境（VM / VPS）
./scripts/deploy-vm.sh your-vm-ip --env-file .env.production
```

本番環境オーバーレイで追加：CPU/メモリ制限、JSON ファイルログ、自動再起動、ヘルスチェック、レート制限、マルチテナンシー。

---

## CI/CD

`.github/workflows/ci.yml` — 品質チェック（型チェック + 完全なコアテストスイート + ベンチマーク + ビルド）+ Docker + Web GUI。`.github/workflows/cd.yml` で main ブランチに自動デプロイ。

---

## ライセンス

MIT

---

<p align="center">
  <sub>AI が実際に何をしているか見たい開発者のために ❤️ を込めて構築。</sub>
</p>
