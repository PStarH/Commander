<p align="center">
  <img src="https://img.shields.io/badge/GAIA-TBD-lightgrey?style=flat-square" />
  <img src="https://img.shields.io/badge/PinchBench-97.7%25-green?style=flat-square" />
  <img src="https://img.shields.io/badge/HumanEval+-91.5%25-orange?style=flat-square" />
  <img src="https://img.shields.io/badge/providers-25-purple?style=flat-square" />
  <img src="https://img.shields.io/badge/topologies-5-red?style=flat-square" />
  <img src="https://img.shields.io/badge/license-MIT-yellow?style=flat-square" />
</p>

<h1 align="center">Commander</h1>
<p align="center"><strong>AI が何をしているか見えるように。結果を信頼して。コストを削減。</strong></p>

<p align="center">
  <code>npx tsx packages/core/src/cli.ts watch "investigate this bug"</code><br>
  <sub>インストール不要。ワンコマンド。マルチエージェントの推論ストリームをリアルタイムでターミナルに表示。</sub>
</p>

<p align="center">
  <img src="docs/assets/commander-watch-demo.gif" alt="Commander watch demo — リアルタイムエージェントストリーミング" width="90%">
</p>

---

> **SKU について（日本語版は更新待ち）：** Commander は現在 2 つの SKU で提供されます —— **Local CLI**（ローカルツール、デフォルト）と **Enterprise Gateway**（`/v1`、alpha）。この日本語 README にはまだ SKU 区分の完全な説明が含まれていません。権威ある情報源としては [README.md](README.md)（英語）を参照してください。WS8 はこれを追跡中です。

## Commander の独自性

**透明性——すべてが見える。** 各エージェントの思考、ツール呼び出し、決定が SSE を介してリアルタイムでストリーミングされます。ブラックボックスなし。エージェントの作業をステップバイステップで確認できます。

**信頼性——検証済みの出力。** 品質ゲートが結果を返す前にすべてチェックします。ハルシネーション検出、整合性、完全性、正確性、安全性の検証。信頼できる結果が得られます。

**コスト効率——スマートな支出。** 推論エンジンがトークンを消費する前にタスクを分析します。適切なトポロジを自動選択——単純なタスクには 1 エージェント、複雑なタスクには並列エージェント。実際のコスト：タスクあたり約 $0.10（品質検証込み）。

**25 の LLM プロバイダー。** OpenAI、Anthropic、Google、Azure、DeepSeek、GLM、MiMo、Xiaomi、Groq、Together、Perplexity、Fireworks、Replicate、Mistral、Cohere、OpenRouter、xAI、Anyscale、DeepInfra、Agnes、Ollama、vLLM、AWS Bedrock、StepFun、MiniMax——環境変数を 1 つ設定するだけで、Commander が残りを処理します。フォールバックチェーン付き。

**自己改善。** Meta-learner は Thompson Sampling + Reflexion を使用して、実行間でエージェント設定を調整します。使用するほど向上します。

---

## 30 秒デモ

```bash
# tsx があればインストール不要（または pnpm/npx を使用）
npx tsx packages/core/src/cli.ts watch "find the bug in src/server.ts and fix it"
```

これはモックアップではありません——実際のエージェント実行からのライブ SSE ストリームの実録画です。すべてのツール呼び出し、すべての決定、すべての検証がリアルタイムでターミナルにストリーミングされます。エージェントの思考を**観察**できます。

---

## 30 秒でわかる仕組み

```bash
# 1. インストール
pnpm install

# 2. API キーを設定（25 プロバイダーから自動検出）
export OPENAI_API_KEY=sk-...

# 3. 何でも実行
npx tsx packages/core/src/cli.ts run "analyze this repository"
npx tsx packages/core/src/cli.ts plan "implement authentication"    # 実行前に計画を確認
npx tsx packages/core/src/cli.ts watch "debug the failing test"     # エージェントの推論をリアルタイム表示
```

---

## Commander と他のフレームワークの比較

|                               | Commander             | LangGraph         | CrewAI          | AutoGen                     |
| ----------------------------- | --------------------- | ----------------- | --------------- | --------------------------- |
| **ライブ SSE ストリーミング** | ✅ 組み込み           | ❌                | ❌              | ❌                          |
| **自動トポロジ選択**          | ✅ 5 トポロジ         | ❌ 手動グラフ構築 | ❌ 固定順序実行 | ❌ 手動オーケストレーション |
| **品質ゲート**                | ✅ 多層検証           | ❌                | ❌              | ❌                          |
| **ハルシネーション検出**      | ✅ 組み込み           | ❌                | ❌              | ❌                          |
| **推論エンジン**              | ✅ スマートタスク分析 | ❌                | ❌              | ❌                          |
| **Meta-learner**              | ✅ 自動チューニング   | ❌                | ❌              | ❌                          |
| **プロバイダー数**            | ✅ 25                 | ❌ 1-2            | ❌ 1-2          | ❌ 1-2                      |
| **CLI エクスペリエンス**      | ✅ 36 コマンド        | ❌ API のみ       | ❌ API のみ     | ❌ API のみ                 |
| **Web GUI**                   | ✅ Agent War Room     | ❌                | ❌              | ❌                          |
| **TUI ダッシュボード**        | ✅ ターミナル UI      | ❌                | ❌              | ❌                          |

---

## トポロジ

Commander は 5 つの標準トポロジから最適なものを自動選択します：

- **SINGLE** — 単一エージェント、単純なクエリ、迅速な回答
- **CHAIN** — 順次パイプライン、段階的な精緻化
- **DISPATCH** — 複数の独立したサブタスクを並列分派
- **ORCHESTRATOR** — オーケストレーターが複数のサブエージェントを調整（再帰的分解含む）
- **REVIEW** — 生成後にレビューエージェントで検証

（下位互換のため 9 個のレガシー別名も保持。）

---

## アーキテクチャ

```
packages/core/src/
├── ultimate/          # オーケストレーションエンジン（deliberation / topologyRouter / atomizer / synthesizer / qualityGates）
├── runtime/           # 実行エンジン（agentRuntime / modelRouter / providers / messageBus / saga 統合）
├── security/          # セキュリティサブシステム（ゼロトラスト / 監査チェーン / レッドチーム / コンプライアンス）
├── tools/             # 組み込みツール（createAllTools、既定で 18 個を登録）
├── memory/            # 3 層メモリ（working / episodic / long-term）
├── mcp/               # Model Context Protocol + A2A
├── saga/              # 永続的補償トランザクション
├── selfEvolution/     # Meta-learning（Thompson Sampling + Reflexion）
├── sandbox/           # サンドボックス（TEE / seccomp / ネットワークプロキシ）
└── ... その他のコアモジュール
```

---

## 品質ゲート

すべての結果は返却前に検証されます：

```
タスク入力 → エージェント実行 → [品質ゲート] → 検証済み出力
                            │
                            ├─ ハルシネーション検出（hallucination）
                            ├─ 整合性（consistency）
                            ├─ 完全性（completeness）
                            ├─ 正確性（accuracy）
                            └─ 安全性（safety）
```

---

## はじめに

### 前提条件

- Node.js ≥ 18
- pnpm（推奨）または npm
- 任意の LLM プロバイダーの API キー

### インストール

```bash
git clone https://github.com/PStarH/Commander.git
cd Commander
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
npx tsx packages/core/src/cli.ts run "your task here"

# API を使用
npx tsx examples/api-usage.ts

# Docker を使用
docker compose up -d
```

---

## ベンチマーク

```bash
pnpm benchmark:gaia        # GAIA ベンチマークを実行（詳細なスクリプトは package.json の scripts を参照）
```

---

| ベンチマーク                                           |   Commander   | ベア LLM (MiMo) | OpenClaw |      Δ      |
| ------------------------------------------------------ | :-----------: | :-------------: | :------: | :---------: |
| **GAIA**（165 の多段階推論タスク）                     | ⏳ 再実行待ち |      21.2%      |    —     |      —      |
| **BFCL** ツール選択（35 シナリオ非公式サブセット）     |   **77.1%**   |        —        |    —     |      —      |
| **BFCL** パラメータ予測（35 シナリオ非公式サブセット） |   **77.1%**   |        —        |    —     |      —      |
| **PinchBench**（43 のエージェントタスク）              |  **100.0%**   |        —        |  89.5%   | **+10.5pp** |
| **HumanEval+**（164 の Python 問題）                   |   **96.3%**   |        —        |    —     |      —      |

BFCL は本リポジトリで複数の非公式サブセットを使用しています：35 シナリオ汎用サブセット（`benchmarks/bfcl/results_full.json`、77.1% ツール / 77.1% パラメータ）、30 タスク Commander 再実行（`docs/benchmark-results/bfcl/results.json`、80.0% / 80.0%）、および 12 コアサブセット（`benchmarks/bfcl/results.json`、91.7% / 91.7%）。これらはいずれも公式 BFCL リーダーボードの実行結果ではありません。

```bash
# 任意のベンチマークを再現
pnpm --filter @commander/core benchmark:verify  # 提出済み BFCL スコア主張を再計算
pnpm test:core                   # 完全なコアスイート：node:test + vitest
pnpm benchmark:chaos:full        # カオスエンジニアリングベンチマーク（255 シナリオ）
```

---

## コマンド

| コマンド                           | 機能説明                                                    |
| ---------------------------------- | ----------------------------------------------------------- |
| `commander run <task>`             | 完全なマルチエージェント実行（`--dry-run` で計画表示、`--stream` でリアルタイム SSE、`--tui` で端末ダッシュボード） |
| `commander fix`                    | lint・フォーマット・型エラーを自動修正                      |
| `commander init`                   | ゼロ設定環境スキャン + プロバイダー接続テスト               |
| `commander company <task>`         | マルチエージェント企業モード：計画 → 構築 → レビュー → 改善 |
| `commander swarm <task>`           | 再帰的分解 + 並列実行                                       |
| `commander drive <task>`           | 自律的な段階的実行                                          |
| `commander goal <task>`            | 多輪収束ループ                                              |
| `commander review`                 | P0-P3 の構造化コードレビュー                                |
| `commander status`                 | システムステータス、プロバイダー正常性、MetaLearner 統計    |
| `commander config`                 | 設定の表示または変更                                        |
| `commander doctor`                 | 診断を実行                                                  |
| `commander history`                | セッション管理                                              |
| `commander gui`                    | Web ダッシュボード（Agent War Room）                        |
| `commander skill`                  | 学習可能スキル管理                                          |
| `commander plugin`                 | プラグインのインストール/一覧/アンインストール               |
| `commander mode`                   | 承認モードの表示または設定                                   |
| `commander feedback`               | フィードバックの送信                                        |
| `commander budget`                 | トークンバジェット状況の表示                                 |
| `commander checkpoint`             | チェックポイント文書の表示                                   |
| `commander saga`                   | Saga トランザクション管理                                    |
| `commander cost`                   | トークン使用量とコストレポート                               |

---

## API 使用

CLI または `@commander/core` の `Commander` エントリで使用します：

```bash
npx tsx packages/core/src/cli.ts run "analyze this repository"
```

または HTTP API（`apps/api`、既定 `:4000`）および Web コンソール（`pnpm gui`）経由で統合できます。

---

## プロバイダー

環境変数を 1 つ設定するだけ。Commander が **25 プロバイダー**から自動検出します：

`OPENAI_API_KEY` · `AZURE_OPENAI_API_KEY` · `ANTHROPIC_API_KEY` · `GOOGLE_API_KEY` · `DEEPSEEK_API_KEY` · `ZHIPU_API_KEY` (GLM) · `MIMO_API_KEY` · `XIAOMI_API_KEY` · `GROQ_API_KEY` · `TOGETHER_API_KEY` · `PERPLEXITY_API_KEY` · `FIREWORKS_API_KEY` · `REPLICATE_API_TOKEN` · `MISTRAL_API_KEY` · `CO_API_KEY` · `OPENROUTER_API_KEY` · `OLLAMA_HOST` · `VLLM_BASE_URL` · `AWS_ACCESS_KEY_ID` (Bedrock) · `XAI_API_KEY` · `ANYSCALE_API_KEY` · `DEEPINFRA_API_KEY` · `AGNES_API_KEY` · `STEPFUN_API_KEY` · `MINIMAX_API_KEY`

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


## ドキュメント

- [ARCHITECTURE.md](ARCHITECTURE.md) — システム設計・モジュール図・データフロー
- [docs/getting-started.md](docs/getting-started.md) — クイックスタート
- [docs/deploy.md](docs/deploy.md) — デプロイ
- [docs/v2-migration-guide.md](docs/v2-migration-guide.md) — Architecture V2 移行
- [docs/slo.md](docs/slo.md) — SLO 定義
- [SECURITY.md](SECURITY.md) — セキュリティモデル・脅威モデル・コンプライアンス
- [BENCHMARK.md](BENCHMARK.md) — ベンチマーク行列と手法
- [CHANGELOG.md](CHANGELOG.md) — リリース履歴
- [docs/README.md](docs/README.md) — 公開ドキュメント索引

内部監査・AI 作業計画・デューデリジェンスメモは**本リポジトリに含まれません**。開発者ローカルの `.internal/`（gitignore）のみです。

## ライセンス

MIT

---

<p align="center">
  <sub>AI が実際に何をしているか見たい開発者のために ❤️ を込めて構築。</sub>
</p>
