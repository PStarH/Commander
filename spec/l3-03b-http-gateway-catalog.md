# L3-03b-http — Gateway HTTP catalog sync（后置）

**状态：OPEN（spec-only；2026-07-20）**  
**Owner：** deferred-L3（见 `.internal/docs/status/2026-07-20-deferred-l3-ownership.md`）  
**上游：** `spec/l3-03b-gateway-localonly.md` KNOWN LIMITATION；L3 closeout Phase C = C-doc

## 目标

Gateway HTTP 面暴露与 worker catalog 一致的 localOnly / 工具目录同步，使企业配置下「旁路 tool」在 HTTP 提交路径亦 fail-closed。

## 非目标（硬）

- 不修改 `/v1/actions` Action Gateway 挂载或 L4-B 补偿路径
- 不在 `feat/l4-b` residual/to-100 窗口内实现业务逻辑（仅本 spec）
- 不做支付/生命域适配器

## Done when（实现波次另开）

1. HTTP 提交 tool/connector 步骤时，catalog 权威与 worker 一致（deny-default）
2. 显式测试：无 catalog / 未知 tool → 4xx/fail-closed
3. 不回归 `GET /v1/runs`、`/evidence`、`/v1/actions`

## 热文件（实现时）

- `apps/api/src/v1GatewayEndpoints.ts`（谨慎；保留 actions/list/evidence）
- worker catalog 只读契约；避免改 `packages/kernel/src/postgres.ts` 补偿 SQL
