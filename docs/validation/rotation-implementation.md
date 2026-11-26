# R1 会话轮换 · 实现与验证记录

> 日期：**2026-11-19（Asia/Shanghai）**　角色：lead（实现 + 自测；独立复核待 tester）
> 契约：`docs/architecture/rotation-contract-patch.md`（唯一口径）、`implementation-plan.md` §5.6 / §8
> 基线：DSH `0.2.2-rc.3`；仓库 `/Users/lzx/Documents/GitHub/dsh-commander`
> 约束：隔离 profile e2e，未碰 live DSH。

## 0. 结论

R1 已按契约实现：**默认关闭**；启用后按 1–7 天周期在 `turn/end`（投递前兜底）换任，新会话通过 `inject` 拿到确定性交接简报，旧会话标 `retired` 保留、可绑回。

验证：**typecheck PASS；单测 407/407 PASS；build PASS；client harness 51/51 + 182/182 PASS；M2/M3 e2e 回归 25/25 PASS；R1 隔离 e2e 18/18 PASS**。
仍未覆盖的只有 2 项运行时观察（§5）：简报进入真实首个 turn 的请求体、live 上下文卡渲染 / 前任点击。

## 1. 变更清单

| 层 | 文件 |
|---|---|
| Host 新模块 | `src/host/rotation/{brief.ts,config.ts,service.ts}` |
| Host 集成 | `src/host/index.ts`（装配 + `turn/end` 订阅）、`src/host/session/{binding.ts,deliver.ts}`、`src/host/dsh-types.ts` |
| 存储/校验 | `src/host/schema.ts`（`rotation`、`retired/generation/retiredAt`）、`src/host/config.ts`（常量）、`src/host/api/validation.ts` |
| API | `src/host/api/{server.ts,errors.ts,state.ts}`、`src/host/api/routes/handlers.ts` |
| Client | `src/client/{state.ts,store.ts,types.ts,SettingsSection.tsx,locales.ts,index.tsx}` |
| 测试 | `tests/unit/rotation-brief.test.ts`、`tests/integration/rotation.test.ts`、`tests/client/rotation.test.ts`、`tests/e2e/r1-e2e.mjs`、`tests/fakes/fakes.ts`（FakeAgents / modelSelections） |
| harness | `tests/client/harness/{smoke.mjs,interact.mjs}`（四组→五组，新增 rotation 卡片断言） |

## 2. 验证矩阵（复跑命令）

| 层 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm --filter dsh-commander typecheck` | **PASS**（host + client） |
| 单测 | `pnpm --filter dsh-commander test` | **407/407 PASS**（含期间工作树新增的任务查询等测试；本次新增 `rotation-config` 5 条） |
| 构建 | `pnpm --filter dsh-commander build` | **PASS**（`lib/host/**`、`lib/client.js` 370,287B、`lib/window.js`） |
| bundle 校验 | `node tools/dev/verify-bundle.mjs packages/dsh-commander/lib/client.js dsh-commander` | **exit 0**（id/exports/react external 全过） |
| client harness | `DSH_COMMANDER_HARNESS_MODULES=… node packages/dsh-commander/tests/client/harness/run-harness.mjs` | **smoke 51/51 + interact 182/182 PASS** |
| M2/M3 回归 e2e | `node packages/dsh-commander/tests/e2e/m23-e2e.mjs` | **25/25 PASS**（默认关闭 → 无行为差异） |
| R1 隔离 e2e | `node packages/dsh-commander/tests/e2e/r1-e2e.mjs` | **18/18 PASS**（证据 `tests/artifacts/r1/e2e/`） |

R1 e2e 关键证据（`tests/artifacts/r1/e2e/rotation.json` / `state-after.json` / `state-boot2.json`）：

- `POST /commander/rotation {force:true}` → `rotated:true`，会话从 `session-1284…` 切到 `session-4b3a…`，`brief.chars=158`；
- 快照：`binding.sessionId` = 新会话、`rotation.generation=2`、`formerCommanders=[旧会话]`；
- `GET /commander/session-transcript?sessionId=旧会话` → 200；
- 关闭后 `POST /commander/rotation` → **409 `rotation_disabled`**；
- 重启后：绑定、代际=2、`retired` 记录全部保持。

## 3. 验收对照（契约 §10）

| ID | 覆盖方式 | 状态 |
|---|---|---|
| A1 简报纯函数 | `tests/unit/rotation-brief.test.ts`（8 条：窗口/排序/上限/用户原话/截断/确定性/空段/代理对） | PASS |
| A2 门控 | `tests/integration/rotation.test.ts`（关闭/未到点/无活动/busy/退避路径） | PASS |
| A3 提交顺序 | 集成：create→inject→config→retired；e2e：真实 Host 全链路 | PASS |
| A4 回滚矩阵 | 集成：create 失败、agent 缺失（不写 config）、旧绑定不变、无 markBroken | PASS（config 写失败分支未单独构造：`commitRotation` 为单次 config update，失败即抛，语义同 create 分支） |
| A5 `turn/end` 触发 | 集成：非指挥官会话不触发、指挥官会话 80ms 内完成换任 | PASS |
| A6 投递前兜底 | 集成：`POST /commander/message` 先换任、消息落新会话且保留 echo | PASS |
| A7 手动绑定不简报 | 集成：`enabled=true` 时 `POST /commander/binding` 的 `injected.length=0`，代际递增 | PASS |
| A8 关闭态 | 集成 + e2e：409 `rotation_disabled`、`state.rotation.due=false` | PASS |
| A9 重启持久化 | e2e boot2：绑定/代际/退役记录保持 | PASS |
| A10 设置页 | harness：五组 +「会话轮换」卡片；单测：client state 归一化 | PASS（「查看前任」物理点击 UNVERIFIED） |
| A11 面板提示 | client store：`rotation.updated` 代际增加 → notice「已换任到第 N 任」；单测覆盖 state 合并 | PASS（渲染在 harness 走查 UNVERIFIED） |
| A12 R1 e2e | `r1-e2e.mjs` 18/18 | PASS |

## 4. 契约/文档回填

- `rotation-contract-patch.md`：状态改为「已实现」；§7.1 响应补齐 `rotated/reason/generation`；§13 实现落点；U1 改判（e2e 已证 create→agent→inject）。
- `implementation-plan.md` §5.6：实现后仍以契约文件为准（本记录不改口径）。
- `ARCHITECTURE.md`：`ConfigRecord.commander.rotation`、`SessionLinkRecord.retired/generation/retiredAt` 已提前合入。

## 5. 仍未覆盖 / UNVERIFIED

| ID | 内容 | 建议 |
|---|---|---|
| U2 | `inject` 的简报是否出现在**真实首个用户 turn 的请求体**里 | 在 m23 stub 探针里加一例：换任后发一条消息，断言 `agent/request` messages 含 `[commander-handoff]` |
| U3 | `source.kind='commander-handoff'` 在 DSH 聊天的上下文卡渲染 | 用户 live 手动点「立即换任」后看一眼聊天流 |
| — | 设置页「查看前任」实际跳转 | live 点击验证（依赖 `uiWorkspace.openSession`） |
| — | 自动到点换任的真实时钟 | 集成用「把 `generationStartedAt` 设为过去」覆盖；真实 1 天等待不现实，保持现状 |

## 5A. Hotfix 2026-11-20（用户 live 反馈）

**现象**：live 交接简报只有头部与「用户最近原话（1 条）」，没有「本周期任务」段，且页脚提示「打开第 1 任会话查看」。

**根因**：窗口取「本任起点 → now」。启用轮换时旧配置没有 `generationStartedAt`，Host 在保存配置时把它写成**启用时刻**（23:59）；紧接着点「立即换任」，窗口只有 1 分钟，当天的任务（`updatedAt` 早于启用时刻）全部被过滤，于是简报空窗。

**修复**（契约 v1.2）：

1. 新增 `briefWindowStart = min(generationStartedAt, now - periodDays*86400000)`：**至少覆盖一个周期**，首次启用/刚换任就触发也不会空窗；本任超过一个周期时仍从本任起点算，不丢跨日任务。
2. 页脚删除「更早的细节可打开第 N 任会话查看」——历史任务走看板/会话既有能力，简报不做导航；只保留 `board_query` 提示。
3. 模型未配置时头部显示「模型：未设置」，不再出现「未设置/未设置」。

**复跑**：单测 **407/407**、`build` PASS、R1 e2e **18/18**、client harness **51/51 + 182/182**。**待 live 确认**：新简报能带上当天任务（用户下次换任时观察）。

## 5B. Hotfix 2026-11-24（自然日 00:00 对齐）

**用户反馈**：设置页「下次换任」显示 `2026-11-24 10:45`，期望按 00:00 基准。

**原因**：v1.2 及之前 `dueAt = generationStartedAt + periodDays×86400000`，本任 11-23 10:45 开始 → 下次 11-24 10:45（滚动周期，不是自然日）。

**修复**（契约 v1.3）：

1. `dueAt = 本任开始日 + periodDays 的本地 00:00`（`startOfLocalDay` + `addLocalDays`，按日历推进，跨月/跨年正确）。
   - 11-23 10:45 开始、1 天 → **11-24 00:00**；3 天 → 11-26 00:00。
2. 仍然是懒轮换：到点后在下一次 `turn/end` 或投递前触发，不跑午夜定时器；关机跨天不丢。
3. 设置页：已到点但还没活动时显示「已到点 · 下次活动时换任」，不再显示一个已经过去的时间（i18n zh/en 已补）。
4. 简报窗口不变（`min(本任起点, now−周期)`），自然日对齐后窗口≈前 N 个自然日。

**复跑**：单测 **407/407**（新增 `tests/unit/rotation-config.test.ts` 5 条）、`build` PASS、R1 e2e **18/18**、client harness **51/51 + 182/182**。

## 6. 部署说明（安装由用户执行）

- **Host 变更 + 新增 `lib/host/rotation/*` 文件**：必须 `remove_bundle` + `install_bundle`（或 `dsh plugin remove/add`）后**重启 DSH**；只重启不生效（快照式安装）。
- **Client 变更**：重装/重启后硬刷新页面；新增设置分组与 i18n 键。
- 关闭态（默认）行为与升级前完全一致；`rotation` 字段仅在用户保存配置或首次换任时落库。

## 5C. 2026-11-26 增量：换任标题 + 工具审计联动

> 角色：lead（实现 + 自测）　环境：仓库工作区；live 未重启前不生效。
> 这是 **R1 之后的加法式改动**，不改轮换判定/门控/提交顺序/回滚矩阵。

### 5C.1 换任标题

- 每次换代（自动到点 / 手动「立即换任」）在新会话简报注入成功后调用 `sessionController.rename({sessionId, title})`，标题固定为 `第 N 任 · YYYY-MM-DD`（N=新代际，本地时区当天）；`rename` 失败只 `warn`，不参与提交条件。
- 2026-11-26 第二轮修订：`rotation.enabled=true` 时，手动「绑定到新会话」也设标题（含首任 `第 1 任 · 日期`）；轮换关闭时保持不设。两条路径共用 `generation-defaults.ts`。
- 证据：`tests/unit/rotation-title.test.ts`（3 条）、集成用例断言 `rename` 入参与失败降级；隔离 e2e 会话日志出现 `session/title` 事件（`source.kind=user`，标题 `第 2 任 · 2026-11-26`）。

### 5C.2 工具审计（dsh-trace-inspect）

- `commander.rotation.toolAudit`（默认 `true`，可 PUT 关闭；旧配置无需迁移）。设置页「会话轮换」分组新增开关，轮换关闭时置灰；`enabled=true` 时手动「绑定到新会话」也受该开关控制。
- 换代时在 `waitForAgent` 之后、简报注入前，用 `node:http` 直连本机 `POST /trace-inspect/api/tool-audit?sessionId=<new>` + `{enabled:true}`（3s 超时）。`404` = 插件未装/未启用 → 静默跳过；`409`/非 2xx/网络错误 → 只 `warn`。**不使用全局 fetch**（Host 可能设置 `NODE_USE_ENV_PROXY`）。
- 证据（2026-11-26 复跑）：
  - `pnpm --filter dsh-commander typecheck` PASS；
  - `pnpm --filter dsh-commander test` **442/442 PASS**（新增 `tests/unit/tool-audit.test.ts`、集成用例：默认探测 / 关闭不探测 / 404 不阻断 / PUT 校验与回显）；
  - `pnpm --filter dsh-commander build` PASS；client harness **52/52 + 195/195 PASS**（新增设置页工具审计开关断言）；
  - `tests/e2e/r1-e2e.mjs` **18/18 PASS**（隔离 profile 未装 trace-inspect，审计请求 404 被静默跳过，轮换全链路不受影响）；
  - 一次性跨插件 e2e（`/tmp/r1audit-e2e.mjs`，隔离 profile + `dsh plugin add github:xx529/dsh-trace-inspect#v0.12.13`）：force 换任后
    `$DSH_HOME/dsh-trace-inspect/tool-description/<newSessionId>.json` = `{"enabled":true,...}`，**17/17 PASS**。
- 未覆盖：live 上真实 MCP 工具的 `description` 参数渲染（需重启后人工看轨迹行）；审计开关在用户首轮前手动改动的交互。

### 5C.3 手动「绑定到新会话」与换代对齐（2026-11-26 第二轮）

> 触发：用户反馈「立刻换任」会改标题/预置工具审计，但「绑定到新会话」两项都失效。
> 口径：B2——仅 `rotation.enabled=true` 时对齐（含首次绑定）；轮换关闭保持旧行为；不生成交接简报（D1 不变）；不改 Client 文案。

- 根因：标题/审计只写在 rotation-only 的 `run()`；`bindNew()` 是独立创建路径，未接 `rename`/`setToolAudit`，且不读 `resolveRotation()`；`rotationForBinding()` 写回丢 `toolAudit`。
- 修复：
  - 新增 `src/host/rotation/generation-defaults.ts`（`applyToolAuditDefault` / `applyRotationTitleDefault`，失败只 warn）；
  - `rotation/service.ts` 改用 helper，保持 `audit → inject → rename`；
  - `binding.ts` 在 `writeBinding()` 前应用两个默认，`BindingServiceDeps` 增加 `setToolAudit/logger`；`rotationForBinding()` 补 `toolAudit`；
  - `index.ts` 的审计闭包同时注入 binding 与 rotation；
  - 标题超时：换代 10s、手动绑定 3s；手动绑定并行执行审计与标题。
- 证据（2026-11-26 第二轮复跑）：
  - `pnpm --filter dsh-commander typecheck` PASS；
  - `pnpm --filter dsh-commander test` **471/471 PASS**；
  - 其中 `tests/integration/rotation.test.ts` **21/21 PASS**（新增：手动绑定标题+审计 / 轮换关闭不应用 / 首次绑定 `第 1 任` / `toolAudit=false` 不发请求且写回不丢 / 审计失败不阻断 / rename 失败不阻断 / 选择已有会话不应用）；
  - `pnpm --filter dsh-commander build` PASS；
  - `tests/e2e/r1-e2e.mjs` **18/18 PASS**（隔离 profile；初始绑定在轮换关闭时保持不设标题/审计，force 换任全链路与 `toolAudit` 持久化正常）。
- 未覆盖：真实 live 的 dsh-trace-inspect 跨插件审计（沿用 5C.2 的一次性 e2e 结论）；手动绑定后新会话首个 turn 的 UI 轨迹行需重装后人工确认；未跑 m1r e2e（本轮未改 attach 派发链路）。
