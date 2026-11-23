# DSH Commander · 开发交接文档（HANDOVER）

> 版本：v1.0　交接时点：**2026-11-18 01:35（Asia/Shanghai）**　编写：architect（只写本文件）
> 读者：后续开发者（人或 agent）。目标：**不回看历史会话**即可接手开发、复跑验证、安全操作 live。
> 约定：**Fact**=已核对命令/文件；**UNVERIFIED**=按现有证据无法确认，需实测；路径除特别说明均为仓库 `/Users/lzx/Documents/GitHub/dsh-commander` 内相对路径。

---

## 1. 一句话现状

**M0/M1/M1R/M2/M3 已实现并通过最终验收（tester 定稿：M1R PASS、M2 PASS、M3 PASS；live UI 物理点击等为环境性 UNVERIFIED，均有单测/集成/65 断言覆盖）；V5 FAIL 但按用户决策豁免——`autoDispatch=false`，每次派发需人工确认；剩余 V6–V8 正式验证、M4 P2、工程收尾（M4 P1 原生壳已实现）。插件已安装在 desktop profile，live 可用（当前 origin 见 `$DSH_WEB_URL`，重启后会变）。**

- 代码：`packages/dsh-commander`（Host + Client 双半），构建产物 `lib/host/**`、`lib/client.js`。
- 测试：`pnpm --filter dsh-commander test` → **229/229 pass**（2026-11-18 11:3x 复跑，node v22.22.2；含本轮 i18n/绑定选择器/性能修复回归）。**2026-11-22 状态机 v1.0 实施后：373/373 pass**（新增 state-machine/dependencies/task-update/task-dependencies 测试；见 §11）。
- 验收：`docs/validation/audit-m0.md` → **M0 整体 PASS（核心）**（M0-1 live 球/面板/点击 PASS；设置页四组/主题/console 为 UNVERIFIED 补验项）；`docs/validation/audit-m1.md` / `m1-accept.md` → **M1 PASS**（M1-1..4 live PASS，M1-5 豁免；确认卡「采用建议」物理点击 UNVERIFIED，以等效 `[dispatch-confirm]` 消息证据替代）。
- **本轮 hotfix（用户 live 反馈 3 项，2026-11-18 11:3x）**：① 看板/抽屉/审批卡/系统消息 **i18n key 直出** → `locales` 补齐 **81 key** + 防回归测试，client 最终 sha `07d9af06a984e583…`（246,540B）；② 设置页「**选择已有会话**」从 M0 占位到完整实现（`GET /commander/sessions?workspaceId=…&limit=20`，返回 title/createdAt/lastActiveAt，冷会话 `bindSelect` 支持、错误码映射）——**用户 live 实机确认「绑定和切换可以了」= live UI PASS**；③ **会话列表性能回归** 41–64s → 0.18–1.2s（registry ids + 标题快照按 limit 分块并行；旧冷首调 52.9s → 0.23–0.33s）。
- **R1 会话轮换（2026-11-19，已实现 + 自测）**：默认关闭；启用后按 **1–7 天**周期在指挥官 `turn/end`（投递前兜底）换任；新会话通过 `agent.inject()` 收到**确定性交接简报**（本周期任务 + 未完成 + 用户最近原话，≤4096 字），旧会话标 `retired` 保留、可绑回；手动「绑定到新会话」**不生成简报**（2026-11-20 hotfix：简报窗口改为「至少覆盖一个周期」，修掉首次换任空窗；页脚不再提示打开旧任会话）。契约 `docs/architecture/rotation-contract-patch.md`，证据 `docs/validation/rotation-implementation.md`（单测 332/332、harness 51/51+173/173、m23 e2e 25/25、r1 e2e 18/18）。**Host 改动 + 新增 `lib/host/rotation/*` → 必须重装 + 重启 DSH；client 改需硬刷新。**
- **侧栏入口（2026-11-19，用户要求）**：DSH 左侧栏新增「**任务看板**」行 → `sidebar.panellist` `id:'commander-board'`、`order:40`（插件 0 / 自动化任务 10 / 上下文洞察 20 / 能力面板 30 之后，「更多」之前）；图标为内联 SVG（零依赖），label 走新 key `board.nav`。实现 `src/client/board-nav.ts` + `BoardNavIcon.tsx`，回归 `tests/client/nav.test.ts` + harness `smoke.mjs`（49/49）。本次只重建已有文件；live 安装是 `link:`（`~/.dsh/profiles/desktop/node_modules/dsh-commander` 符号链接到仓库包），`lib/client.js` sha `95819e32c42a72f…`（349,125B）已即时可读 → **用户硬刷新即可，无需重装/重启**。
- 新增：**M1R（自定义 attach）= PASS**（e2e 33/33、live 确认卡渲染 + attach 等效消息派发 PASS；物理点击 UNVERIFIED）；**M2（看板）= PASS**（e2e 25/25、devops 65 ASSERT、live Host 只读 PASS；live 看板 UI 点击/拖拽/回收站 UNVERIFIED）；**M3（闭环）= PASS**（e2e 25/25、单测 201/201、harness 43/43+92/92、live Host 只读 PASS；live 审批卡/accept-rework/角标 UI UNVERIFIED）；契约复核 `docs/architecture/m2m3-review.md` → **PASS，HIGH=0（HIGH-1 已修复）**；3 个 MEDIUM 按 Lead 裁决记为 known limitations（见 §5 第 11 条）。验收文档 sha 见 §5 第 12 条。
- 门禁：V0 = **FAIL**（V5 v2 不达 85%/70%/95%/40%）；用户 2026-11-17 决策：**忽略 V5、降级全确认、继续 M0→M1**；`docs/validation/V0-GATE.md` 保留裁定与重开门条件。
- 仓库：分支 `master`，HEAD `d8d1543`（2026-11-17 14:40），**工作树有 38 项未提交改动（含本文件 docs/HANDOVER.md，未跟踪）**（见 §6 收尾）。

---

## 2. 交付物索引

### 2.1 代码（`packages/dsh-commander/`）

| 路径 | 内容 |
|---|---|
| `package.json` | 双半 manifest：`dsh.bundle.patch` + `dsh.client`（platform web、immediately、inject 三项：ui-layout / ui-settings / **dsh-client-locale**） |
| `cordis.patch.yml` | 插入 Host 行 `id: commander, name: dsh-commander` |
| `src/host/index.ts` | 组合根：`inject=['storageDomain','webServer']`（其余 `ctx.get` 软解析）；domain open → store → binding → messages/SSE → deliver → 订阅 → API |
| `src/host/domain.ts` / `schema.ts` / `store/*` | commander 域 7 表（per-record）：`config/workspaces/commands/tasks/dispatches/board_edits/sessions`；key 归一化、单写者、version 自增 |
| `src/host/api/*` | `/commander/*` 前缀路由、SSE hub、快照、校验、错误 envelope、requestId 幂等 LRU |
| `src/host/session/*` | 绑定/重绑/懒 resume、消息环（≤500/快照 200）、`session/event` 订阅（assistant 文本→SSE；turn/start|end→busy）、投递（`prompt` 保留 receiver + AbortSignal） |
| `src/host/dispatch/*`、`jev/*` | M1：候选构造/Jev 客户端/全确认决策/spawn/能力 auto |
| `src/host/tools/*` | 六工具（仅指挥官会话作用域）：`commander_task_create/get/update/dispatch/list/report`；状态写入统一经 `src/host/tasks/state-machine.ts` |
| `src/client/index.tsx` | Client apply：`inject=['slots','locale']`；**先注册槽位**，再启 transport/locale；apply try/catch + `[dsh-commander] client apply …` 诊断日志 |
| `src/client/{Overlay,SettingsSection,store,state,styles,locales,types}.tsx/ts` | `shell.overlay` 球+面板（56px/420×660、pointer-events:auto）、`settings.section` 设置骨架、SSE store、设计令牌样式 |
| `lib/host/**`、`lib/client.js` | 构建产物（client 为官方 ModuleLoader 包裹：`window.__ModuleLoader__.load({id:"dsh-commander",factory})`） |
| `tests/{unit,integration,client,fakes,e2e}` | 142 条测试（含真实 Host e2e `tests/e2e/m0-e2e.mjs`、`m1-e2e.mjs`） |

### 2.2 构建/开发工具（`tools/`）

| 路径 | 用途 |
|---|---|
| `tools/dev/wrap-client.mjs` | 把 tsdown CJS 产物包成 DSH Client 官方 wrapper（`pnpm build:client` 自动调用） |
| `tools/dev/verify-bundle.mjs <client.js> <pkg>` | 校验 wrapper id/export/react external |
| `tools/dev/client-repro.sh` | **隔离 web + 无头 Chrome/CDP** 复现 client 加载与 console（M0-1/无 UI 问题首选） |
| `tools/dev/check-m1-tools.sh` / `check-m1-increment.sh` / `check-m0-api.sh` | 隔离 Host API 形状/工具注册/增量回归检查 |
| `tools/dev/install-live-m0.sh` | live 安装**预检**（产物/lib 文件集一致性/profile 快照/基线）；不写 live |
| `tools/dev/verify-live-m0.mjs` | live 健康检查（health/state/config/boot graph/bundle）；用法见 §3.4 |
| `tools/dev/cdp-probe.mjs` | 通用无头 Chrome CDP console/截图探针（`client-repro.sh` 使用） |
| `tools/dev/spike-build.sh` / `smoke-m0.sh` | 构建 spike / M0 快速冒烟 |
| `tools/validation/scripts/{setup-probe-env,run-v1..v4,live-state}.sh` | V1–V4 隔离探针环境与复跑（`DSH_HOME` 隔离，不碰 live） |
| `tools/eval/**`、`tools/jev-eval.mjs` | V5 评测（build/audit/validate cases、live/mock 评估） |

### 2.3 验证与审计（`docs/validation/`，关键 12 份）

| 文件 | 内容 |
|---|---|
| `V0-GATE.md` | V0 门禁最终记录（FAIL、裁定、限制、**重开门条件**、复跑入口） |
| `v1-capability-panel.md` … `v5-jev-dispatch.md` | V1–V5 验证记录（V1–V4 PASS；V5 FAIL） |
| `audit-m0.md` / `m0-accept.md` / `m0-live-install.md` | M0 独立复核 / 验收清单 / live 安装与升级回滚、hardlink 注意 |
| `audit-m1.md` / `m1-accept.md` / `m1-boot.md` | M1 独立复核（H1–H5 修复闭环）/ 验收实测 / 真实 Host boot 与 live 更新步骤 |
| `m1-artifacts/client-load-repro.md` + `m1-artifacts/client-repro/` | client 无球根因（locale 未注入）无头复现与修复验证（console 原文/截图） |
| `docs/architecture/client-load-audit.md` | 该问题的静态审计 + 注入最小集 + 修复记录 |
| `audit-V5-v2*.md`、`audit-V5-rootcause.md`、`audit-V1-V4.md` | V5 v2 审计/根因盲评/V1–V4 复跑审计 |

### 2.4 架构与契约（`docs/architecture/`）

| 文件 | 作用 |
|---|---|
| `implementation-plan.md` | **主蓝图**（M0/M1/M2/M3 模块、契约、验收、构建/测试/安装；§8 HTTP+SSE、§9 全确认派发、§11 验收映射、§15 裁定记录） |
| `m0-contract-patch.md` | M0 实现期补丁（消息通道/设置接口 schema/M0 验收执行口径；§7 实现对齐补记） |
| `m1-contract-patch.md` | M1 补丁（全确认语义/确认卡消息协议/pendingDispatch/任务详情/能力结果口径） |
| `m2m3-contract-patch.md` / `m2m3-review.md` | M1R/M2/M3 实现契约（sha 28a1c1d7…，已合入 plan）/ 契约复核（PASS，HIGH=1） |
| `m0-review.md` / `client-load-audit.md` / `v5-review.md` / `v5-reopen-plan.md` / `validation-protocol.md` | M0 两轮契约复核 / client 加载审计 / V5 方法学复核 / V5 重开方案 / V0 验证协议 |

### 2.5 产品/研究/原型/评测

- `docs/PRODUCT-DESIGN.md`（v1.8）、`docs/ARCHITECTURE.md`（v2.4，含 `board_edits` 平台修正）、`docs/NEXT-PHASE.md`（冻结决策 §2、M2/M3 范围、停止条件）。
- `prototype/`：`app/index.html` 可交互原型 + `screens/` + `shots/`（视觉参照；无 Figma）。
- `research/notes/dsh-capabilities.md`（DSH 扩展点实证）、`docs/research/{validation-env,capability-panel-api}.md`（隔离环境/能力面板契约）。
- `docs/eval/`：`frozen/`（V5 冻结案例 + manifest，**只读**）、`report-v2.md`（V5 权威结论）、`diagnostics-v3.md`（FAIL 诊断实验）。
- `docs/tasks/htdot-order-export-switch/`：M1 live 测试任务的过程产物（测试数据，可清理）。

---

## 3. 快速上手（复制即用；命令均已核对存在）

### 3.1 依赖 / 构建 / 类型检查 / 测试

```bash
cd /Users/lzx/Documents/GitHub/dsh-commander
pnpm install
pnpm --filter dsh-commander build       # = build:host(tsc→lib/host) + build:client(tsdown→CJS + wrap→lib/client.js)
pnpm --filter dsh-commander typecheck
pnpm --filter dsh-commander test        # 2026-11-19 复跑 277/277 pass
pnpm --filter dsh-commander build:native # 可选：macOS 原生壳（Rust + Xcode CLT；产物 native/dist/<platform>-<arch>/）
bash tools/dev/install-native-shell.sh  # 只读预检：产物/签名/profile 现状 + 打印安装命令
node tools/dev/verify-bundle.mjs packages/dsh-commander/lib/client.js dsh-commander   # wrapper 校验
```

> 环境：本机 PATH `node v22.22.2` + `pnpm 11.x`（以上命令在此环境通过）；DSH 自身运行在其安装目录的 Node 上。构建产物：`lib/host/**/*.js`、`lib/client.js`（约 131KB）。

### 3.2 隔离开发/复跑（**不碰 live**，全部用一次性 `DSH_HOME`）

```bash
# client 半加载/console/截图（无头 Chrome/CDP；M0-1 无 UI 问题首选）
bash tools/dev/client-repro.sh                 # PROBE_ROOT=/tmp/client-repro 可覆盖；OUTDIR 可覆盖
# M1 API/工具/增量回归（隔离 web profile + 本地包）
bash tools/dev/check-m1-tools.sh
bash tools/dev/check-m1-increment.sh
# V1–V4 探针环境与复跑
bash tools/validation/scripts/setup-probe-env.sh
bash tools/validation/scripts/run-v1.sh        # 同理 run-v2.sh/run-v3.sh/run-v4.sh
# 真实 Host e2e（隔离 profile）
node packages/dsh-commander/tests/e2e/m0-e2e.mjs
node packages/dsh-commander/tests/e2e/m1-e2e.mjs
node packages/dsh-commander/tests/e2e/m2-e2e.mjs   # M2 看板（如存在；实现任务产出）
node packages/dsh-commander/tests/e2e/m3-e2e.mjs   # M3 闭环（如存在；实现任务产出）
# V1–V4 证据审计/断言（只读 docs 证据）
node tests/validation/run-all.mjs              # 加 --run 独立复跑；--base rerun 断言复跑输出
```

### 3.3 live 安装 / 升级 / 回滚（**live 操作属用户/Lead**；重启会中断当前会话/agent）

```bash
# 预检（只读；不写 live）：产物 + lib 文件集一致性 + profile 快照
bash tools/dev/install-live-m0.sh

# 首次安装（用户终端；绝对路径）
dsh plugin --profile desktop add /Users/lzx/Documents/GitHub/dsh-commander/packages/dsh-commander
dsh --profile desktop --dump-config | grep -n -A3 "dsh-commander"   # 应出现 commander host 行

# 升级规则（重要，见 §5 坑 1）：
#  - 仅"已存在文件"的改动（重建同名文件）会经 hardlink 更新 → 用户硬刷新页面即可（client）
#  - 新增 lib 文件 / Host 代码变更 / dsh.client.inject 变更 → 必须重装 + 重启 DSH：
#      plugin_manager: remove_bundle + install_bundle file:/Users/lzx/Documents/GitHub/dsh-commander/packages/dsh-commander
#      等价 CLI：dsh plugin --profile desktop remove dsh-commander && dsh plugin --profile desktop add <绝对包路径>
#  - 只重启 DSH（不重装）只加载"安装时已存在的 JS"；新文件不会进入副本（M1 事故根因 ERR_MODULE_NOT_FOUND）

# 回滚
dsh plugin --profile desktop remove dsh-commander    # 或 plugin_manager remove_bundle；随后重启 DSH
# commander 存储域数据保留在 ~/.dsh/storages（域 commander），重装可读回
```

### 3.4 live 健康检查

```bash
# 轻量（loopback 可直接访问；当前 origin 以 $DSH_WEB_URL 为准）
curl -s "$DSH_WEB_URL/commander/health"     # {"ok":true,"version":"0.1.0","panel":"present","binding":"bound"}
curl -s "$DSH_WEB_URL/commander/state" | head -c 400
curl -s "$DSH_WEB_URL/commander/config"     # 只读视图（不含 Jev Key）

# 完整检查（含页面 boot graph / client bundle wrapper；需要带 token 的页面地址）
node tools/dev/verify-live-m0.mjs --url 'http://127.0.0.1:<PORT>/?token=…'
node tools/dev/verify-live-m0.mjs --origin http://127.0.0.1:<PORT> --token '…'
DSH_WEB_URL=http://127.0.0.1:<PORT> DSH_WEB_TOKEN=… node tools/dev/verify-live-m0.mjs
# ⚠ 已知：该脚本的 EXPECTED_INJECT 仍是 H3a 的两项（ui-layout/ui-settings），client 修 TOP1 后 boot graph 为三项
#    （+@deepseek-ai/dsh-client-locale）→ 该项断言会报 FAIL、脚本 exit 1（其余断言仍有效）。需 devops 更新常量。
```

---

## 4. 架构与契约（后续改动必须遵守；细节以 `docs/architecture/implementation-plan.md` 为准）

### 4.1 双半 bundle

- **Host 半**：`tsc` → `lib/host/**`（ESM，零第三方运行时依赖；只 import `node:*` 与相对模块）。
- **Client 半**：`tsdown` → CJS → `tools/dev/wrap-client.mjs` 包裹为 `window.__ModuleLoader__.load({id:"dsh-commander",factory:require=>…})`；只 `require("react")`/`react/jsx-runtime`（浏览器模块表提供）；`exports.apply/inject`。
- `package.json dsh.client`：`platform:"web"`、`immediately:true`、`inject:[ui-layout, ui-settings, dsh-client-locale]`（**改动 boot 期字段需重启 DSH**）。
- 真实 Client apply 里**访问任何服务都必须在 `inject` 声明**（Cordis 严格代理：未注入直接 throw）；当前 `inject=['slots','locale']`，并先注册槽位、后启 transport/locale（详见 §5 坑 2）。

### 4.2 commander 存储域（per-record，`layout:'per-record'`，version 1）

| 表 | key | 内容 |
|---|---|---|
| `config` | `singleton` | 绑定、Jev 配置、board、ui |
| `workspaces` | workspaceId | 白名单/摘要/能力策略 |
| `commands` | commandId | 用户原话、会话、seq |
| `tasks` | taskId | **权威任务记录**（状态 + 有界 timeline ≤100） |
| `dispatches` | decisionId | 候选/Jev 输出/最终选择（终态） |
| `board_edits` | editId | 人工看板改动 + 注入状态（**表名是 `board_edits`**，Lead 平台契约裁定） |
| `sessions` | `<workspaceId>__<sessionId>` | 会话↔任务↔角色、lastInjected |

规则：单写者（Host）；单记录 `update` + 应用层 `version`；key 归一化 `[a-zA-Z0-9_-]+`（非法字符替换 + `--sha1` 后缀）；**不新增表/事件类型**；域数据在 `~/.dsh/storages`（route `commander`）。

### 4.3 `/commander/*` 路由 + SSE

| 路由 | 说明 |
|---|---|
| `GET /commander/health` | `{ok,version,panel:'present'|'absent',binding:'bound'|'broken'|'unbound'}` |
| `GET /commander/state` | 快照；`Accept: text/event-stream` 升级 SSE（首帧 snapshot） |
| `GET /commander/config` | 只读可展示配置（无 Jev Key 明文；加法只读路由） |
| `PUT /commander/config` / `PUT /commander/workspaces` | 设置保存（严格拒绝未知字段；不含明文 key） |
| `POST /commander/binding` | `{mode:'new'|'select', workspaceId?|cwd?, sessionId?, agentPreset?}` |
| `POST /commander/message` | **面板消息唯一通道**：`{text≤8192, requestId}` → 绑定校验 → `sessionController.prompt({mode:'queue'})` |
| `GET /commander/tasks/:id` | M1 任务详情（dispatch/capabilities/timeline/acceptance/sessions） |
| `POST /commander/jev/test` | M1 Jev 连通性探针（不回传 key） |
| M1R | `GET /commander/sessions?workspaceId=&limit=` | 自定义确认 attach 的只读会话列表（顶层非归档/非子 agent） |
| M2 | `PATCH /commander/board/tasks/:id` | 人工改看板：`{field,value,editId,requestId}`；`done/archived` 拒绝；写 tasks+board_edits；30s 合并注入 `[board-edit]` |
| M2 | `POST /commander/tasks/:id/archive` / `restore` | 归档（review/done/cancelled→archived）/ 恢复（archived→draft） |
| M2 | `GET /commander/archive?limit=&cursor=` | 回收站列表（archived/cancelled） |
| M3 | `POST /commander/tasks/:id/accept` | 唯一验收入口（review→done，仅人） |
| M3 | `POST /commander/tasks/:id/rework` | 返工：先投递续做 brief，成功才 review→running；失败 502 不改状态 |

SSE 事件：`snapshot`、`heartbeat`(15s)、`commander.message`、`commander.status`、`dispatch.updated`、`task.updated`、`tasks.changed`、`binding.updated`、`capability.applied`、`bye`（插件卸载）。快照：`binding/commanderStatus/commanderBusy/panel/counts/tasks/messages(≤200)/workspaces/pendingDispatch/metrics/rev`；M2 增 `tasks[].stale/sessionCount/acceptanceCount/evidenceInsufficientCount` + 顶层 `archiveSummary`；M3 增 `workSessions`（≤200，审批卡用）。
错误码：`invalid_request/not_found/conflict/panel_unavailable/storage_error/internal/binding_required/binding_broken/prompt_failed/workspace_conflict/preset_unknown/create_failed/decision_expired/decision_required`。

### 4.4 面板消息唯一通道（禁止改回 client 直连）

- 发送只能 `POST /commander/message`；回复/状态由 Host 订阅指挥官会话 `session/event` 后经 SSE 推回（`commander.message`：user echo `messageId=requestId`、assistant `asst_<turn>_<seq>`；`commander.status` busy/lastTurnId）。
- **禁止** client 直连 `ctx.remote.session.prompt`/自行轮询取消息（H3 裁定；bundle 内 `session.prompt/getRemote` 必须为 0）。client 唯一允许的轮询是 **SSE 不可用时的只读快照降级**（3s，`GET /commander/state`，不发消息）。
- 404/405 → client 显示「Host/插件版本不匹配，请升级 dsh-commander 后重启 DSH」，不做任何回退直连。

### 4.5 指挥官工具（M1，仅指挥官会话作用域）

`commander_task_create` / `commander_task_get` / `commander_task_update` / `commander_task_dispatch` / `commander_task_list` / `commander_task_report`；`accept`/`archive`/`restore`/`cancel` 是**人专用 HTTP 路由**，不是模型工具。`commander_task_update` 只接受 action enum（edit/set_dependencies/block/cancel/recover）且必带 `expectedRevision`，不再接受裸 `status`。工具：
- 插件 `apply` 里 `ctx.tools.register(definition, { when })` **全局注册一次**（归属=插件，工具面板才认；**不要**注册到 agent 作用域，见坑 18）；`when` 按 step 的 agent 会话 id 放行，只对当前指挥官可见/可调用（身份判定回退 `agent.id`/`session.id`，见坑 4）；
- `commander_task_dispatch` 的 `output.schema` 必须用 `oneOf` 完整覆盖 `rejected/needs_confirmation/dispatched` 三 variant（DSH 运行时严格校验，见坑 3）；`output.render` 决定模型可见内容；
- 模型可见性判据用「真实模型调用 + state.tasks」验证，**不要用 `tools.schemas()`**（不反映动态注册）。
- M3 `commander_task_report` 的 seq 区间/derivedFromSeq 越界必须拒绝；`delivered/partial` 需 ≥1 条 acceptance（**HIGH-1 已修复**：`tools/index.ts` review 空 acceptance → invalid_request 且不写 task；单测 201/201 通过）。

### 4.6 全确认派发（用户决策；不得擅自开 auto）

- `DEFAULTS.autoDispatch=false`（运行期常量；**不改 `ConfigRecord` 冻结 schema**）；`ConfigRecord.jev.threshold/confidenceFloor` 只作提示/推荐，不用于放行。
- 首次 `commander_task_dispatch` **恒** `needs_confirmation`：`decisionId`（确定性 `dec_`+sha256(taskId+'\0'+requestId) 前24hex）、`candidates≤8`、`recommendation`、`scores{pWorkspace,pSession,pMax=min,concentration=min}`、`reason ∈ {user_confirm_required,jev_unavailable,low_confidence,decision_required}`、`expiresAt=+30min`。
- 二次 `commander_task_dispatch({taskId, decisionId, confirmTarget, requestId})`（或"唯一 pending 下原 candidate+requestId"）→ 校验未过期/未用/归属 → create/attach → prompt brief → `dispatched`、任务 `queued`；`turn/start` 后 `running`。
- 决策仅内存 TTL 30m（重启/过期 → `decision_expired`，要求指挥官重新派发）；同一 decision 只提交一次（重复调用幂等回放首次结果）；`requestId` 5min 幂等（工具层 LRU）。
- 确认卡 UI 三动作（采用/自定义/取消）只发**普通用户消息**（`[dispatch-confirm] … decisionId/taskId/target`）到指挥官会话，**不新增确认路由**（详见 `m1-contract-patch.md` §2）。

### 4.7 能力选择（面板软依赖）

- 只在 **新建会话 + `workspace.capabilityPolicy.mode='auto'`** 时调：解析 `ctx.get('capabilityPanel')`（兼容 thunk）→ 校验 `jev.rank/apply` 是 function → 取 `getConfig().decisionThreshold`（默认 0.5）→ rank → plan（`applicable && score≥threshold`，提交 `{id,kind,name,enabled:true}`）→ apply → prompt。
- 结果写 `TaskRecord.capabilities`：`enabled` 只写**提交给 apply 的 plan 项 name**（不写计数、不增字段），`disabled=[]`；冷会话 `pending:true` 记 `applied + reason=pending_replay_on_agent_created`；面板缺失/rank/apply 失败 → `status='fallback' + reason`，**继续派发**（不 blocked）。
- 面板不读/不写其配置文件；派发 Jev（工作区/会话）与能力面板 Jev 配置完全分离。

### 4.8 `turn/end` 最后回复注入（M3，已实现）

- M1/M2 只订阅 `turn/start` 做机械状态更新；**M3 已启用 turn/end 注入**（`src/host/trigger/injection.ts`：work 会话+允许 reason+无未配对 approval/asked+userQuestions.active 空；取最后 assistant；事件源 `readSessionEvents()`（`ctx.sessionQuery.readSession` → live `Session.snapshotEvents` → 旧 `events` 兜底）；格式 `[session-reply] …\n---\ntaskId/sessionId/turnId/seq/truncated`；整条 ≤8KB（头 6KB + 尾 + 元数据行；超了过不了投递上限 8192）；去重 `<sessionId>:<turnId>:<lastSeq>` 写 `lastInjected`；忙/在途按 session 合并；失败补一次；不写任务记录、不轮询）。
- 口径与细节以 `m2m3-contract-patch.md` §3.1 + `implementation-plan.md` §7 为准；**known limitation**：`sessionProjections` 缺失时 pending 判定 fail-open（Lead 裁决保留 + 计 metric，不静默丢最后回复）。

---

## 5. 已知限制与坑（务必读）

1. **安装副本是"快照式"，hardlink 只覆盖安装时已存在的文件**：`dsh plugin add file:` / `install_bundle` 安装时复制/硬链；之后 `tsc` 原子写会**断开 hardlink**。新增文件（如 M1 的 `lib/host/dispatch/*.js`）不会进入 live 副本 → 运行时报 `ERR_MODULE_NOT_FOUND`/无球。**新增文件 / Host 改动 / `dsh.client.inject` 改动必须重装 + 重启**；仅硬刷新只能更新"已存在且 hardlink 未断"的 client 文件。核对命令见 `docs/validation/m0-live-install.md` §7.6。
2. **Client `inject` 必须包含实际访问的服务**：曾因 `inject=['slots']` 却直接读 `ctx.locale`，Cordis 抛 `cannot get property "locale" without inject` → apply 在槽位注册前中断 → **无悬浮球**（`docs/architecture/client-load-audit.md`、`docs/validation/m1-artifacts/client-load-repro.md`）。当前修复：`inject=['slots','locale']`、先注册槽位再启 transport/locale、try/catch + `console.info('[dsh-commander] client apply begin/…')` 诊断。**jsdom/fake harness 不会复现该错误**（假 ctx 不执行 Cordis 严格代理），client 改动请用 `tools/dev/client-repro.sh`（无头 Chrome）验证。
3. **工具 output 契约**：`defineTool` 的 `output.schema` 必须与真实返回**完全一致**（DSH 运行时校验；M1 曾因 `commander_task_dispatch` 三 variant 字段不全被 DSH 运行时拒绝）；`output.render` 缺失会在真实 `defineTool` 抛 `Cannot read properties of undefined (reading 'render')`；`render` 决定模型可见内容（`commander_task_list` 曾因渲染遗漏 workspaces 导致模型不可见）。**必须补"经真实 tools 注册后校验返回值"的测试**（不能只单测 service 直调）。
4. **身份判定**：commander 会话判定/工具注册作用域需用 `agent.id` 回退（`session.id` 不总是可用）；M1 已修，改动工具/作用域时勿回归。
5. **`tools.schemas()` 不反映动态 `register()`**：不能作为"工具是否注册/可见"的判据（devops 曾据此误报）；用真实模型调用或 state 判。
6. **全确认模式的清尾/竞态**：确认成功后 `pendingDispatch` 必须清空（H3 已修）；`turn/start→running` 有竞态（H4 已修）；`dispatched.target` 只能含 `{workspaceId,mode,sessionId?}`（H5 已修，勿再把内部候选字段塞进去）。
7. **UNVERIFIED（live）**：M1「采用建议/自定义/取消」**物理点击**（AX 对 web 内容未触发；已有等效 `[dispatch-confirm]` 消息证据）；设置页四组/主题/发送按钮/console 截图；`verify-live-m0.mjs` 页面 boot graph 需带 token URL，且其 `EXPECTED_INJECT` 仍是两项（见 §3.4，会误报 exit 1）。
8. **V5 不能当 PASS**：V5 v2 指标（gate 工作区 14.3% / attach 5.6% / 模式 50% / 全对 7.1%，无 95%×40% 组合）FAIL 仍保留；按用户决策仅"豁免 auto 门禁"。**不要擅自开 autoDispatch**；重开门条件见 `docs/validation/V0-GATE.md` §6（按被测消息时间重冻结新 sha、不得复用 `872cb12d…`、标签复核、B 模式重跑 C2–C6；阈值不放宽）。
9. **Client 报错只进 DevTools console，不写 Host 日志/文件**：无球/白屏类问题必须看页面 console（关键字 `without inject`、`slot entry crashed`、`client-modules:`）与 `window.__DSH_BOOT__.entries`；`/commander/health` 200 不能证明 client apply 成功。
10. **live 操作属用户**：安装/重启/卸载会中断当前会话/agent；不要在 agent 内擅自重启 DSH 或写 `~/.dsh`。
11. **M2/M3 复核结论（`docs/architecture/m2m3-review.md`，2026-11-18）**：**HIGH-1 已关闭**（`commander_task_report` review 空 acceptance → invalid_request，单测 201/201；`blocked/no_progress` 允许空；architect 复跑 201/201 确认）。**3 个 MEDIUM 按 Lead 裁决全部记为 known limitations，不阻塞交付**：
    - **board PATCH 先写 task 后写 board_edits（非原子）**：接受；失败最多"任务已改但缺一次注入同步"，不产生孤儿 edit/错误注入；后续可事务化。
    - **注入 pending 判定在 `sessionProjections` 缺失时 fail-open**：**保留**（不静默丢最后回复）；已实施 metric `projectionUnavailable`（fail-open 仍注入、仅计数，快照 `metrics` 可见）。
    - **rework prompt 成功但版本冲突返回 conflict（brief 已发）**：**M5 已修**——续派不再直接 prompt 工作会话；`finishDispatch` 对 `turn/start` 顶掉 task.version 的竞态按最新 version 重试（≤3 次），避免第一次失败、brief 已发、重试又发一遍。
    LOW（不阻塞）：`dispatch/service.ts:615` 注释与实现不符、board-edit 投递成功但标记前崩溃可能重复一次、注入去重比较用 `>=`（更严）。
12. **M1R/M2/M3 最终验收状态（2026-11-18 tester 定稿）**：**M1R PASS / M2 PASS / M3 PASS**。live Host 只读均 PASS（health/state/archive/sessions 新字段、metrics 含 `projectionUnavailable`、pending=null）；**live UI 物理交互为环境性 UNVERIFIED**（agent-desktop AXPress 对 web 内容无效果、System Events 坐标点击不触发、DevTools DOM 点击被外部 JS 干扰），替代取证为隔离 harness（43/43+92/92）+ e2e + 单测/集成。
    - **UNVERIFIED 清单（均已有单测/集成覆盖与复跑命令）**：live UI 物理点击（确认卡采用/自定义/取消、看板点击/拖拽/回收站、设置页四组/主题/发送按钮/console 截图、审批卡/accept-rework/角标）；stale 20min（e2e 无法推进时钟）；生产 30s 合并窗口（e2e 用加速窗口）；pending 跳过注入 e2e（隔离难造 PendingApproval，集成覆盖）；archived attach fixture（单测覆盖）。
    - **复跑命令**：`node packages/dsh-commander/tests/e2e/m1r-e2e.mjs`、`node packages/dsh-commander/tests/e2e/m23-e2e.mjs`（均已核对存在）、`DSH_COMMANDER_HARNESS_MODULES=/tmp/dshc-harness-modules/node_modules node packages/dsh-commander/tests/client/harness/run-harness.mjs`、`pnpm --filter dsh-commander test`（232/232）。
    - **关键文档 sha256（前 16）**：`m1r-accept.md a739cd9fddb25a76`、`m2-accept.md 168fcc777686b7bc`、`m3-accept.md 0d39c0012e7884a5`、`audit-m2.md 3b6fd4e125c69742`、`audit-m3.md d1527e39db426aab`、`m2m3-review.md fc90997d5807dc5b`、`m2-m3-build.md b6128653e94716c9`（§12.3 已含 Lead 决策）。
13. **本轮 hotfix 记录（2026-11-18 11:3x，用户 live 反馈）**：① **i18n key 直出**：看板/抽屉/审批卡/系统消息缺 key → `locales` 补齐 **81 key** + 防回归测试（`pnpm test` **229/229**），client 最终 sha `07d9af06a984e583…`（246,540B）；② **设置页「选择已有会话」**：原为 M0 占位（走不通）→ 已实现（`GET /commander/sessions?workspaceId=…&limit=20`，title/createdAt/lastActiveAt；冷会话 `bindSelect` 支持；错误码映射）；**用户 live 实机确认「绑定和切换可以了」= live UI PASS**（设置页绑定项从 UNVERIFIED 转为 PASS）；③ **会话列表性能回归**：41–64s → **0.18–1.2s**（registry ids + 标题快照按 limit 分块并行），旧冷首调 52.9s → **0.23–0.33s**。相关文档 sha：`t65-t66-audit.md f84fe648a0acbd85`（tester 对齐后最终值）、`m2-m3-build.md b6128653e94716c9`（devops 最终 sha；§12.3 已含 Lead 决策「pressure 优化本轮不做」，取代旧 01390720/c12dcd8e…）、`m2m3-review.md fc90997d…`（不变）。
14. **hotfix 记录（2026-11-18 12:x，用户 live 反馈：派发任务已完成，指挥官却收到「[session-reply] 本轮无文本回复」）**：两个根因 —— ① `readSessionEvents`/`report tool`/启动回填都读 `session.events`，而 DSH `sessions` 服务返回的是 live `Session`（只有 `snapshotEvents()`，没有 `events`）→ 事件恒空、注入永远拿不到最后回复（截图里 `seq=` 落回 turn/end 自身 seq 就是特征）；② 8KB 截断没把 `---` 元数据行算进去，整条 >8192 会被 `PROMPT_TEXT_MAX` 投递校验拒绝（长回复即使读到文本也永远注不进，e2e 首跑 `injectFailures=1` 复现）。修复：`src/host/session/session-records.ts#readSessionEvents`（`ctx.sessionQuery.readSession` → live `snapshotEvents` → 旧 `events` 兜底），`buildInjectionText` 按"整条 ≤8192"预算截断（头 6KB + 尾 + 标记 + 元数据行）。验证：`pnpm test` **232/232**、e2e **25/25**（注入含 `HEAD-…-TAIL` + `[truncated N chars]` + `truncated=true`，`injections=1/injectFailures=0`）。部署：`pnpm --filter dsh-commander build` 后**重启 DSH**；lib 与 profile 安装副本是硬链接，本次无新增 lib 文件，不用重装。
15. **hotfix 记录（2026-11-18 12:2x，用户 live 反馈：看板/详情要重启才更新，关联会话已停止仍显示 running）**：根因 —— ① `task.updated` 只在少数路径发、且发的是 `{taskId,status}` 轻量包（违反 implementation-plan §8.4 的 `{task,rev}`），指挥官工具/`turn/start|end` 的改动根本不广播；SSE 活着时 Client 已停轮询 → 看板只能等重启/重新打开；② 注入写 `lastInjected` 用整条 upsert，把同一次 turn/end 写的 `status:'idle'` 用旧快照冲回 `running`（读-改-写竞态，`lastInjected.at` 晚于 `lastActivityAt` 即特征）；③ 详情抽屉只在打开/人工操作时拉 `GET tasks/:id`，抽屉里的会话状态不会自己变。修复：`sessions.patch` 原子写（status/lastInjected 互不覆盖）；`buildTaskView` 统一整行 + tracker/tools/board/dispatch 全部推整行 `task.updated`；抽屉行 `updatedAt` 变新时重拉详情；详情里 `running` 但会话已不在内存 → 按 `idle` 显示（历史残留记录也不再骗人）。验证：`pnpm test` **234/234**、e2e **25/25**；新增集成回归（turn/end 推整行 + 链接 idle + lastInjected 同时保住；残留 running 派生 idle）。部署同样只需 `pnpm --filter dsh-commander build` + 重启 DSH（无新增 lib 文件）。
16. **Client bundle 只能用 Web 壳静态模块表的 seed**：浏览器侧 `require` 先查 seed（实测表：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`），其余 specifier 必须是有 factory 的图行。用 seed 时：tsdown `deps.neverBundle` 要列入（保持 `require("…")`，不能打进 bundle），SSR harness 的 fake factory 要加 stub；**不要**把 seed 写进 `dsh.client.external`（那是非 baseline 动态包请求）。指挥官对话的 Markdown 就是复用 seed 的 `MarkdownText`（与普通会话同一组件、同一套 `.markdown` 样式；`src/client/markdown.ts` + `src/client/primitives.d.ts` 只声明用到的面）。
17. **hotfix 记录（2026-11-18 12:4x，用户 live 反馈：派发给工作会话的文本泄露内部 id）**：`buildDispatchBrief` 原来输出 `[commander-dispatch]` 头 + `---` 下的 `taskId=… decisionId=… sessionId=…`，工作会话根本不需要这些关联关系（`tasks/dispatches/sessions` 三张表里都有）。现在 brief 只含 `任务/目标/验收提示/约束`；rework 续做 brief 同步去掉 `[commander-rework]` 与 `taskId`。测试/探针改为按内容特征识别工作会话（`你是工作会话`、`上一轮验收未通过`），不再依赖 marker。验证：全量测试 **234/234**、m23 e2e **25/25**（证据里工作会话收到 `任务：…目标：…约束：…`，无 marker/id）。部署：build + 重启 DSH。
18. **hotfix 记录（2026-11-18 12:5x，用户 live 反馈：commander 的 5 个工具在工具面板显示「来源未识别/预设」）**：根因是注册方式不规范——原实现把工具注册在**指挥官 agent 的 scope**（`agent.ctx.get('tools').register`），工具面板的归属捕获只看全局 `tools.schemas()` 的变化，agent-scope 注册天然不在其中，只能落到「Agent 预设注入 · 来源未识别」；`agent/created` + 短重试那套时序代码也只为绕这个方案存在。改为标准姿势：插件 `apply` 里 `ctx.tools.register(definition, { when: ({agent}) => 会话 id === 当前指挥官 })` **全局注册一次**，`when` 逐 step 放行（其它 agent 的 prompt 看不到、不可调用，`execute` 里的 `forbidden_scope` 继续兜底）；删掉 `installForAgent`/`agent/created` 重试/`restrict` 死代码。验证：单测/集成 235/235、m23 e2e 25/25（真实宿主下命令工具仍被模型成功调用）；工具面板预期显示「插件 · dsh-commander」。部署：build + 重启 DSH（无新增 lib 文件）。
19. **hotfix 记录（2026-11-18 14:2x，用户 live 反馈：待验收任务点「验收通过」被 409「review 任务需要至少 1 条 acceptance」）**：根因不在 accept 路由——指挥官用 `commander_task_update({status:'review'})` 把**没有验收项**的任务置成了 review（`commander_task_update` 是唯一漏掉 `review ⇒ acceptance≥1` 不变量的写入口；`commander_task_report`/看板 PATCH 都已有守卫），人点验收就被路由校验卡住。修复：① `commander_task_update` 目标 review 且 `acceptance=[]` → `invalid_status` 并提示改用 `commander_task_report`；② 人点 accept 不再因空验收 409（人已确认就允许收尾，timeline 标注「无验收项：历史数据」，避免历史脏数据永远卡死）；③ 指挥官 prompt 增加「交给用户验收用 commander_task_report、不要用 commander_task_update 置 review」。验证：全量测试 **236/236**；新增 commander_task_update 空验收拒绝单测 + 历史脏数据 accept 集成测试。部署：build + 重启 DSH。
20. **hotfix 记录（2026-11-18 14:4x，用户 live 反馈：`[session-reply]` 以用户输入气泡注入，期望像 DSH 的 context/agent-message 那样）**：原注入统一走 `sessionController.prompt(mode:'queue')`，DSH 侧 source 恒为 `{kind:'user'}` → 聊天渲染成用户消息、模型 prompt 里也没有上下文框架。改为 **DSH 上下文注入**：live 指挥官 Agent 上 `agent.followup(...)` 一条 `role:'user'` 但 `source.kind='commander-session-reply'`（`form:'relay'`, `senderSessionId=工作会话`）的消息，内容用 `<system-reminder>…</system-reminder>` 包裹；看板改动同理（`source.kind='commander-board-edit'`, `form:'notice'`）。DSH 聊天显示上下文卡（「收到执行请求 / 这条通知触发了本轮回复」，可展开原文），模型看到 `<system-reminder>` 提醒；用户会话尚未 live（宿主刚重启）时回退 `prompt` 保证仍触发一轮。验证：全量测试 **237/237**、m23 e2e **25/25**；真实宿主事件里可见 `agent/inbox/spliced` → `user/message` 的 `source:{kind:'commander-session-reply', form:'relay', senderSessionId:…}` + `<system-reminder>` 正文，且后续指挥官 turn 正常执行工具。部署：build + 重启 DSH。
21. **hotfix 记录（2026-11-18 14:3x，用户 live 反馈：指挥官面板的任务 chip 与列表状态不一致）**：面板头部 chip（进行中 2 / 待验收 1）读快照 `counts`，任务行读 `tasks[]`；`task.updated` 只更新任务行，`tasks.changed`（计数）此前**只有快照会带**，所以状态变化后 chip 停在旧值（看板按 tasks 分组所以正常）。修复：① 抽 `countTaskStatuses()`，所有任务写入广播时同时推 `tasks.changed {counts}`（tracker/tools/dispatch/看板 PATCH/archive/restore/accept/rework 全覆盖）；② accept/rework 路由补 `onTaskChanged` 广播。验证：全量测试 **237/237**、m23 e2e 25/25；新增「turn/end 同时推 tasks.changed + 计数正确」集成断言。部署：build + 重启 DSH。
22. **hotfix 记录（2026-11-18 14:5x，用户 live 反馈：看板卡片没有「打开会话」按钮）**：卡片按钮的渲染条件是 `task.primarySessionId && openSession`；快照里有 primarySessionId，但 `openSession` 在 client `apply` 时被一次性捕获——`uiWorkspace` 是**软依赖**（不在 `inject` 里），它的 provider 插件可能晚于本插件激活，apply 时 `ctx.get('uiWorkspace')` 还是 undefined，于是整个功能永久缺失（抽屉里的「打开会话」同样受影响）。修复：`src/client/lazy-services.ts` 新增惰性入口——`createOpenSession(ctx)` 点击时才解析服务（缺失只告警一次）；`createLazySessionStatus(ctx)` 首次读取/订阅时解析 `uiSession.sessionStatus`，并用 `ctx.inject(['uiSession'])` 在服务晚到时挂上观察源、唤醒审批卡。验证：全量测试 **240/240**、client harness **133/133**（新增「卡片有打开会话按钮且点击打开关联会话」断言）；host/client `tsc` 通过。部署：build + 硬刷新页面（client 改动）。
23. **hotfix 记录（2026-11-18 15:3x，用户 live 反馈：设置页「选择已有会话」列出了已归档会话）**：归档状态**不在** `SessionRecord`/`SessionHeader` 里（`normalizeSessionRecord` 恒为 false），真实来源是 `workspaceRegistry` 的**服务级全局 getter** `archivedSessionIds`（实测 `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds` 有 331 条），而 `workspace.sessionIds` 归档后**仍保留**该 id。`collectWorkspaceSessions` 只信 `session.archived` → 归档会话漏进 `GET /commander/sessions`（以及派发 attach 候选）。修复：`dispatch/candidates.ts` 统一用 `archivedSessionIdsOf(ctx, registry)`（服务级 getter + 兼容条目级 fake）标记/过滤；registry ids 路径**先剔归档再取 limit**（否则大量归档会占满名额）；`collectSessions` 同步排除。验证：全量测试 **240/240**、m23 e2e 25/25；集成夹具改成真实语义（SessionRecord 不带 archived，只给 registry 全局集合，且归档 id 排首位覆盖 limit）。部署：build + 重启 DSH。
24. **hotfix 记录（2026-11-18 16:0x，用户 live 规则：只监控进行中/待验收任务的会话）**：注入器原来只看「work 会话 + 允许 reason + 无 pending」，任务验收完成（done）、归档（archived）、取消（cancelled）甚至还没派发（draft/proposed/queued/blocked）时，工作会话再结束回合仍会 `[session-reply]` 打扰指挥官。改为**白名单**：只有 `task.status ∈ {running, review}` 才注入，其余状态（含任务记录缺失）返回 `skipped / task_inactive`。验证：全量测试 **241/241**；单测覆盖 7 个非监控状态 + 2 个监控状态（running/review）。部署：build + 重启 DSH。
25. **hotfix 记录（2026-11-18 16:3x，用户 live 反馈：自定义 attach 到已有会话后，工作会话已在跑，看板仍是「排队」）**：根因是 **re-attach 的回合事件落在旧 link 上**——`sessions` link 以 `(workspaceId, sessionId)` 为键只存一个 `taskId`，同一会话被新任务 attach 时会覆盖旧值；而 `prompt` 在 link 写入**之前**发出（H4 的既有顺序），新派发的 `turn/start` 可能先到、此时 link 仍指向**旧任务**。旧代码 `findWorkLink` 只按 sessionId 找 link、不看任务状态，于是回合事件被记到**已归档的旧任务**上（实据：`task_mwlrl1684fdba1` 归档后 `updatedAt` 被 16:25:06 的 turn/start 改写），孤儿补偿表没记录 → 新任务永远停在 `queued`。修复：① `findWorkLink` 跳过任务缺失或已终态（done/cancelled/archived）的历史 link，按「无 link」走孤儿补偿；② tracker 额外记录「会话最近一次 turn/start」，`reconcile` 时孤儿表或该标记任一命中都补 `queued→running`（覆盖旧任务仍活跃的多任务 attach 竞态）；③ 启动时 `backfill()`：对仍是 queued 的任务读会话事件，只有「turn/start 落在 link.createdAt ±5s 内、且之后再无 turn/end」才补 running（回合在 attach 之前就开始的、或已结束的都不算），修复重启前已错过的状态且不误判忙碌会话。验证：全量测试 **244/244**（新增 re-attach 竞态、忙碌会话不误报、启动回填 3 条集成断言）。部署：build + 重启 DSH。
26. **hotfix 记录（2026-11-18 16:5x，用户 live 反馈：看板任务详情「关联会话」只显示裸 sessionId）**：`GET /commander/tasks/:id` 的 `sessions[]` 只有 `sessionId/workspaceId/role/mode/status`（契约 m1 §3.3 也没给展示字段），抽屉直接渲染 id。修复：Host 侧批量 `readSessionsByIds`（标题快照，live/冷会话都覆盖）补 `sessionTitle`，从配置副本补 `workspaceName`；client `TaskSessionLinkView` 增两字段，抽屉渲染 `工作区 · 会话标题`（未命名会话降级为短 id，缺工作区名只显示标题，绝不只剩裸 id），`title` 属性保留完整 sessionId 便于排查。验证：全量测试 **245/245**（新增详情字段集成断言）、client harness **134/134**（新增「HtDot · 订单导出改造」抽屉行断言）、host/client `tsc`。部署：build + 重启 DSH + 刷新页面。
27. **功能（2026-11-18 17:1x，用户需求：浮窗可拖到页面任意位置、位置持久化、设置里可开关且默认开启）**：原浮窗只能选右下/左下两个角落预设。改动 —— ① `ui.entryEnabled`（boolean，缺省 true）控制浮窗显示，关闭时 overlay 整体不渲染；② `ui.entryPos`（视口归一化中心点 `{x,y}` 0..1，`null` = 回到 `entryPosition` 默认角落）持久化自由位置；③ Client Overlay 用 Pointer Events 实现拖动：位移 >4px 才算拖动，松手 `store.saveEntryPos` 先乐观更新再 `PUT /commander/config`，拖动后的那次 click 被吞掉（不会误开面板）；面板按浮窗位置就近展开（左右/上下自动避让 + 视口 clamp），窗口 resize 时用归一化坐标重新夹紧；④ 设置页外观组把「悬浮球位置」下拉换成「显示浮窗」开关 + 拖拽提示 + 「重置位置」（写 `entryPos:null`）；⑤ `store.start()` 启动即 `loadConfig()`，首屏就按配置决定是否显示/停在哪；⑥ 旧配置没有新字段 → `config store get()` 合并 `DEFAULT_UI`（读取即默认开启）。验证：全量测试 **248/248**（`validateConfigPatch` 的 entryEnabled/entryPos、旧配置默认值、PUT→GET 往返与越界 400）、client harness **146/146**（拖动归一化保存、拖动不开关面板、拖动后 click 被吞、`entryEnabled=false` 隐藏、设置开关保存 `entryEnabled:false`）、m23 e2e **25/25**。部署：build + 重启 DSH + 刷新页面。契约同步：m0-contract-patch §2.5 的 `ui.*` 字段表、ARCHITECTURE §4 ConfigRecord。
28. **hotfix 记录（2026-11-18 17:3x，用户 live 反馈：浮窗拖到侧边栏标题条附近后点不动、拖不动）**：DSH 桌面端把侧边栏 logo 行/会话标题行标成 `[data-window-drag]{-webkit-app-region:drag}`（app.asar 内可检索到该规则，且其中交互元素靠 `-webkit-app-region:no-drag` 才可点），Electron 的窗口拖拽区会吞掉指针事件；本插件浮窗是覆盖层（不在拖拽区 DOM 内、默认 app-region 为 none），拖进那片区域后既不能点也不能拖。修复：`.dshc-ball, .dshc-panel` 显式声明 `-webkit-app-region: no-drag`（覆盖层在拖拽区之上，no-drag 打洞生效）。验证：client harness **147/147**（新增注入样式含 no-drag 规则的断言）。纯 CSS/Client 改动：**刷新页面即可，不需要重启 Host**。侧边栏/标题条仍然可以照常拖窗口（只在浮窗/面板矩形内放行点击）。
29. **hotfix 记录（2026-11-18 18:2x，用户 live 反馈：派发确认卡点了「采用建议」后一直挂着「已发送确认，等待指挥官处理…」）**：两个问题叠加 —— ① 客户端要等 Host 的 `dispatch.updated` 清 `pendingDispatch` 才收卡，指挥官处理一轮期间整张卡一直在，体验像"没生效"；② 面板状态会因 SSE 半开连接（浏览器不报错也不重连）永久停在旧值，实测 Host `/commander/state` 已是 `pendingDispatch=null`、任务已 done，面板仍显示确认卡。修复：① 用户点击后消息投递成功即**立即收起确认卡**，只保留一行 `dispatch.waiting` 状态（pending 清掉后切到任务状态；新 decision 到达时卡片重新渲染）；② store 增加 **SSE 心跳看门狗**：Host 每 15s heartbeat，连续 45s 无任何帧 → `stopStream()` + 切轮询（轮询 snapshot 重新对齐 pending/messages）。验证：client harness **148/148**（新增「点击后卡片立即消失 + 状态行显示 waiting」「pending=null 后卡片保持收起」）；全量测试 248/248。部署：**刷新页面即可**（纯 Client）。
30. **说明 + hotfix（2026-11-18 18:3x，用户 live 反馈：自动选工作区/session 派发后新会话没有自动选择能力，看板显示「能力 0/0」）**：限制来自**工作区能力策略**——`spawn.ts` 只在 `mode='new' && workspace.capabilityPolicy.mode==='auto'` 时调 `runAutoCapability`（rank→阈值过滤→apply），`inherit`（默认）直接写 `status:'inherited'`、`enabled:[]`；attach 不跑 auto；panel 缺失/rank 失败/低于阈值会 fallback 到空 plan。实测：Research / agent-workspace 都是 `inherit`，任务 `task_mwlypbnr4ad71e` 的 `capabilities={policy:'inherit',status:'inherited',enabled:[]}`，auto 从未被触发；唯一 `auto` 的 Htdot-OrderCenter 未允许派发。看板「能力 0/0」是 status=inherited 且计数全 0 时的噪音。修复：新增 `capabilityTotal()`，看板卡片与任务列表在 **N+M=0** 时不渲染能力徽标（有数量才显示 `能力 N/M`）。验证：全量测试 248/248、client harness **150/150**（新增 0/0 不显示、applied 3/5 显示）。部署：刷新页面即可（纯 Client）；要让新会话自动选能力，需在设置里把对应工作区策略改为「自动」后重新派发。
31. **hotfix 记录（2026-11-18 19:0x，用户 live 反馈：设置页能力策略下拉里「自动选择（M1）」的 M1 标记）**：`settings.workspace.auto` 的文案是 M0 阶段写的占位（当时能力自动选择被排到 M1），M1 已交付但后缀没删，看起来像“未完成/实验功能”。改为「自动选择」/「Auto select」；顺带全量扫描 locales，没有其它可见的里程碑标记（`（M1）`/`(M2)` 之类）。验证：locales 测试 5/5、client harness PASS、全量 248/248。部署：刷新页面即可（纯文案）。
32. **功能（2026-11-19 09:2x，用户 live 反馈：指挥官在浮窗里提问时，面板没有可操作的问答框，只有主窗口合成器里有）**：`ask_user_question` 的官方卡只挂在 `conversation.composer` 座位，`shell.overlay` 面板读的是 `uiSession.sessionStatus`，但之前只筛 `kind='approval'`。新增：① `src/client/questions.ts`（`isQuestionLike`/`selectPendingQuestions`（指挥官会话优先 + 任务工作会话）/`questionViews`/`buildAnswerPayload`/`toggleOption` 纯函数）；② `src/client/QuestionCard.tsx` 精简问答卡（单选/多选/自定义/跳过/多题分页/提交/收起/去会话作答）；③ Overlay 把 `kind='question'|'plan-review'` 纳入 `actionableCount`/FAB 徽标/抽屉，**新提问自动打开面板+抽屉**；回答直接调用官方 `PendingQuestion.answer({answers})`（与主窗口同一实例、同一 waterfall/RPC 通道），成功后本地收起防重复提交，`already settled` 静默；收起只本地隐藏不调用 `dismiss()`。验证：单测 `tests/client/questions.test.ts` 5 条、client harness **166/166**（问答卡渲染/选项选中/提交答案/请求结束消失）、全量 **263/263**。部署：刷新页面即可（纯 Client）。

33. **功能（2026-11-19，用户需求：脱离 DSH 界面的浮窗）**：M4 P1 原生壳。① 契约 `docs/architecture/native-shell-contract.md`；② Tauri 2 壳 `packages/dsh-commander/native/tauri/`（透明无边框置顶窗口、球 56×56 ↔ 面板 420×660 同窗两态、Option+Space 全局热键、跨 Space/全屏辅助、位置持久化、父 PID 看门狗、stdio NDJSON 帧）；③ Host `src/host/native/{supervisor,protocol,window-page,approval-bridge}.ts` + `GET /commander/window?token=`（内联窗口 bundle）+ `health.nativeShell` + `GET/POST /commander/native/approval*` + `ctx.effect` 生命周期；④ 窗口页面 `src/client/{window.tsx,WindowApp.tsx,shell-bridge.ts,window-styles.ts}`（复用 store/SSE，独立 IIFE bundle `lib/window.js`，React 打包进 bundle）；面板含「对话 / 看板」两视图、任务验收/返工/归档/详情、条件接管的审批卡。审批规则：壳 `running+visible+focused` 时 `prepend` 接管 `approval/request`，否则 `next()` 回落 DSH；壳退出/心跳失败/10 分钟超时 → `cancelled`（fail closed）。验证：typecheck；全量单测 **282/282**（新增 protocol/supervisor/window-page/approval 19 条）；`cargo build --release` + 显式 ad-hoc 重签（macOS 26 实测 linker-signed 会被判 `Code Signature Invalid` → SIGKILL）；`node tools/dev/native-shell-smoke.mjs` PASS；`node tools/dev/native-window-probe.mjs` PASS（真实 bundle 执行并请求 state/config/approvals）；live 首启问题已修（远程页 IPC 需 capability `remote.urls` + 自定义命令 ACL `allow-set-mode` 等，`tools/dev/native-ipc-probe.mjs` 回归 `invoke=ok`、56×56→420×660）；窗口页 Markdown 用独立 `window-markdown.tsx` 渲染（DSH 的 MarkdownText 拿不到）；看板复用 `BoardPage`（五列泳道，宽窗 980×700），球位置展开/收起恢复（`ball_pos`）；问答卡经 `question-bridge` 条件接管 `user-questions/request`；窗口页复用应用内组件：`DispatchConfirmCard` / `ApprovalFloatCard` / `QuestionCard` / `BoardPage` / `CommanderSettingsSection` / 系统消息卡 / 底部抽屉；差异仅 Markdown 渲染（模块表不可用）与悬浮球视觉；看板“打开会话”在壳内新开只读会话窗口（`GET /commander/session-transcript`）；窗口 Markdown 支持表格/列表/代码块/跨行链接（视觉证据 `docs/validation/m4-artifacts/session-window.png`）；视觉证据 `docs/validation/m4-artifacts/board-five-lanes.png`；`node packages/dsh-commander/tests/e2e/m4-e2e.mjs` **10/10 PASS**（隔离 Host 拉起壳、杀壳自动重启、Host 停止后壳退出）。另：`/commander/state` 新增 `nativeShell`，壳 running 时 DSH 页内球隐藏（双球互斥）；origin 优先 `webServer.getOrigin()`；设置页新增 `ui.nativeShell` 开关（默认开，重启 DSH 生效）；壳窗口关闭请求会退出壳由 supervisor 重启。视觉证据：`docs/validation/m4-artifacts/native-shell-ball.png`（独立蓝色球浮在 DSH 页面上、页内球已隐藏）；可用 `node tools/dev/native-shell-shot.mjs` 复现。**未验证**：热键真实按下/多屏跨 Space/壳内审批真机（需用户安装后走查）、Windows、问答卡。部署：`pnpm --filter dsh-commander build && pnpm --filter dsh-commander build:native` → **重装 + 重启**。测试进程默认禁用壳（`NODE_TEST_CONTEXT`），隔离 e2e 用 `DSH_COMMANDER_NATIVE_SHELL=1/0` 显式控制。

34. **功能（2026-11-19 17:x，用户 live 反馈：`commander_task_report` 的 `summary` 在看板面板里看不到）**：根因是 Host 全程没落库——工具只把 `summary` 读出来做 `≤800` 长度校验（`src/host/tools/index.ts`），随后丢弃；`TaskRecord` 没有该字段，`GET /commander/tasks/:id` 也不透出，抽屉只能渲染固定文案「指挥官整理验收内容」+ 验收清单。修复：① 契约先行——`ARCHITECTURE §4.2`、`implementation-plan §10.3`、`m2m3-contract-patch §3.2` 增补「写 `TaskRecord.reportSummary={text,at}`（空串不写）并经详情接口透出」；② Host：`schema.ts` 增 `ReportSummary` + `isReportSummary`（`isString(0..800)` + `at`）与 `TaskRecord.reportSummary?` 可选校验（老记录天然通过），`commander_task_report` 在 update 的同一事务视图里写入 `{text:summary,at}`，`handlers.ts` 详情响应透出；③ Client：`TaskDetailView.reportSummary`、`normalizeTaskDetail` 白名单放行（否则载荷会被静默丢弃）、`buildTaskFeed` 把摘要挂到最后一条 `report` 行（只有 summary 无验收时自建 report 行，空串忽略）、`BoardPage` 在验收清单上方渲染 `.dshc-d-ev-summary`（`pre-wrap` 保留换行）并让 report 行文案在仅有 summary 时也本地化。验证：`tsc` host+client 通过；全量 **302/302**（新增 report-tool 落库/空串保留旧摘要、board feed 挂载与 summary-only、normalizeTaskDetail 透出、isTaskRecord 形状与 800 上限、详情接口透出）；client harness **49/49 + 167/167**（新增抽屉 `.dshc-d-ev-summary` 摘要断言）；`node packages/dsh-commander/tests/e2e/m23-e2e.mjs` **25/25 PASS**。部署：**build + 重装 + 重启 DSH**（Host 行为 + 新增字段，快照式安装只重启不生效）；只展示老数据时无需迁移。

35. **UI 优化（2026-11-19 18:x，用户反馈：`reportSummary` 展示后像「一大段字」，看不出这是结论，且强调色与证据勾的绿色语义重复）**：把「整理报告」行从「固定文案 + 无容器长文」改成**「结论」卡**（Client-only）。① `BoardPage.tsx` 新增 `ConclusionCard`：「结论」胶囊 + 「来自工作会话最后回复」+ `white-space: pre-wrap` 正文，默认 4 行 `-webkit-line-clamp` 折叠，底部渐隐，超长出现「展开结论 / 收起结论」（`aria-expanded` + 本地 state，重开抽屉恢复折叠）；实测溢出不依赖字数，`shouldCollapseSummary`（140 字兜底）保证 jsdom/无布局环境也给出按钮。② 强调色**不复用**证据绿/琥珀：新增 `.dshc-board { --dshc-conclusion-accent: var(--dsw-static-deepseek-450, #5686fe) }`，色条/胶囊/渐变都用它（深蓝），改一行即可换色。③ 文案：去掉「指挥官整理验收内容」（该 i18n key 仅保留给无 summary 的老数据），新增 `board.drawer.conclusion/conclusionHint/conclusionMore/conclusionLess` 中英各 4 条。④ 设计对比与最终稿：`docs/validation/design/report-summary-options.html` + 同名 `.png`（现状 / A 结论卡 / B 轻量内联，用 DSH 真实暗色 token 渲染）。验证：`tsc` host+client 通过；全量 **306/306**（新增 `shouldCollapseSummary` 边界 6 断言）；client harness **49/49 + 172/172**（结论卡文本/胶囊 key/折叠按钮/展开 aria/中文字典 5 条）；`node packages/dsh-commander/tests/e2e/m23-e2e.mjs` **25/25 PASS**。部署：**纯 Client，硬刷新页面即可**（原生壳需重开窗口加载新 bundle）。

36. **hotfix（2026-11-19 18:5x，用户反馈：结论卡下面还重复了一整段原始摘要）**：上一轮把「固定文案行」换成「结论卡」时，只改了 `feedEventText` 那一行，round-1 留下的 `<p className="dshc-d-ev-summary">{event.summary}</p>` 裸段落没删；同轮又把 `.dshc-d-ev-summary` 的样式删了，于是它退化成无样式正文、在结论卡下方整段重复。修复：删掉该渲染点（summary 现在只经 `ConclusionCard` 渲染一次）；harness 新增回归断言（`.dshc-d-ev-summary` 不存在 + 抽屉内摘要短语恰好出现 1 次）。验证：`tsc` 通过、全量 **306/306**、client harness **49/49 + 173/173**、`build` 通过（live 与仓库 `lib/client.js` 仍同 inode）。部署：**硬刷新页面**即可。

37. **UI 微调（2026-11-19 19:x，用户反馈：「展开结论」在左侧不协调，放到右边）**：`ConclusionCard` 的折叠按钮包进 `.dshc-d-conclusion-foot`（`display:flex; justify-content:flex-end`），按钮自身去掉 `margin-top` 改为右对齐；设计稿 `docs/validation/design/report-summary-options.html/.png` 同步。验证：`tsc` 通过、全量 **306/306**、client harness **49/49 + 173/173**、`build` 通过。部署：**硬刷新页面**。

38. **UI 微调（2026-11-19 19:x，用户反馈：「结论」两个字要白色）**：胶囊由「浅蓝底 + 蓝字」改为**实心深蓝底 + 白字**（`background: var(--dshc-conclusion-accent, #5686fe); color: #fff`），暗色/亮色两套主题下对比度都够（浅色主题若保留半透明蓝底白字会几乎不可见）；设计稿同步。验证：`tsc` 通过、全量 **306/306**、client harness **49/49 + 173/173**、`build` 通过。部署：**硬刷新页面**。

39. **文案纠正（2026-11-19 19:x，用户质疑：结论卡写「来自工作会话最后回复」到底是原文还是指挥官自己总结）**：事实是**指挥官模型自己写的**——`commander_task_report` 的 `summary` 由指挥官在调用时传入，工具只做 `≤800` 长度校验并把字符串原文落 `TaskRecord.reportSummary`，**从不核对它是否真出自最后回复、也不做截取**；参数描述里那句「Summary from the last reply」只是给模型的写作要求。原 hint 属过度承诺。修复：① hint 改为「指挥官归纳 / Curated by the commander」；② 工具参数描述改为「Commander digest of the work session last reply (≤800 chars; Host stores it verbatim and does not verify the source text)」；③ 契约（`ARCHITECTURE §4.2`、`m2m3-contract-patch §3.2`、`implementation-plan §10.3`）统一注明「Host 不核对来源」。验证：`tsc` 通过、全量 **306/306**、client harness **49/49 + 173/173**、`build` 通过。部署：文案在 Client，硬刷新即可；工具描述属 Host，需重启 DSH 才对模型生效。

40. **UI 微调（2026-11-19 19:x，用户要求：去掉「指挥官归纳」这行说明）**：结论卡头部现在只有「结论」胶囊，不再带任何副标题——既去掉噪音，也避免对 summary 来源做无法核对的承诺。连带清理：`board.drawer.conclusionHint` 中英两份 key、`.dshc-d-conclusion-hint` 样式、设计稿里的 hint。验证：`tsc` 通过、全量 **306/306**、client harness **49/49 + 173/173**、`build` 通过（`lib/client.js` 与 live 同 inode）。部署：**硬刷新页面**。

---

## 6. 未完成清单与建议路线

| 阶段 | 范围（源自 `NEXT-PHASE.md` §4） | 状态/建议 |
|---|---|---|
| **M2 看板** | 六列/卡片/详情抽屉/人工改动 `board_edits` + 30s 合并注入/归档回收站/停滞徽标；无状态拖拽 | **已完成 + 2026-11-22 重构通过**（入口=主面板整页 `main` keyed `commander-board`；e2e 25/25 + devops 65 ASSERT + live Host 只读 PASS；live UI 物理点击 UNVERIFIED，见 §5 第 12 条） |
| **M3 闭环** | `turn/end` 注入、`commander_task_report`、审批悬浮卡、accept/continue、播报 | **已完成 + PASS**（e2e 25/25、单测 201/201、harness 43/43+92/92、live Host 只读 PASS；live 审批卡/accept-rework/角标 UI UNVERIFIED，见 §5 第 12 条；3 个 known limitations 见 §5 第 11 条） |
| **V6–V8** | V6 审批双处渲染；V7 Host→Client 推送；V8 插件重载 | **未做正式验证轮**（既有事实：M3 已实现审批双处渲染、SSE 实时可用、插件重载流程已验证；仍需按 NEXT-PHASE §3 出一轮正式 V6/V7/V8 记录） |
| **M4** | 原生壳、系统级悬浮、全局热键、Windows、语音、周报 | **P1 已实现（macOS）**：Tauri 2 壳 + Host supervisor + 窗口页；单测/构建/smoke 通过，live 视觉未验证（§5 第 33 条）。P2（跨 Space/全屏、审批接管、Windows）未做 |
| 工程收尾 | ① known limitations 后续项（board PATCH 事务化、fail-open metric 落点、rework 幂等键）；② git 工作树未提交（`master` @ `d8d1543`，含本文件）；③ `README.md` 仍写"未开始编码"（已过期）；④ live 测试数据清理（见 §8）；⑤ 缺 `docs/retro` 复盘；⑥ 未接 CI（201 条测试与 e2e 建议纳入）；⑦ devops `check-m0-api.sh` 有 MEDIUM（语法/覆盖缺口，独立 Live API 证据已由 tester 补）；⑧ `verify-live-m0.mjs` 的 inject 断言需更新为三项 locale | 交接后按优先级处理；清理 live 测试数据前先确认用户是否还要保留 |

> **已知性能边界（2026-11-18 hotfix 后）**：会话列表在 **fresh 大工作区 `limit=50`** 时仍 >2s（实测 `capability-settings` 工作区 3.85–5.30s）；当前 **UI 已固定 `limit=20`**（设置页/自定义 attach 选择器），该范围实测 0.18–1.2s。**后端分页/缓存列为后续优化项**（不做无谓缓存；若未来 UI 需要更大列表，先加 cursor 分页再放开 limit）。

---

## 7. 开发约定（硬约束）

1. **不改冻结决策**：`docs/NEXT-PHASE.md` §2 十条（尤其：指挥官是普通会话、不拆工作/不评估、只注入最后回复、无 scheduler、任务记录唯一真相、Jev 只判工作区/会话、能力交给面板、审批只在界面、一期只在 DSH）。
2. **不做什么**：原生壳、能力目录/Resolver、scheduler、投影/事件表、`brief_user`、一期不做 FTS、不新增确认路由、不新增表/事件类型。
3. **Host 是唯一写者**：Client 只发命令/发消息；存储只经 store 层；HTTP 写入走 requestId 幂等。
4. **任何代码改动必须补测试**并跑 `pnpm --filter dsh-commander test`（当前 **232/232**）；涉及工具 schema/渲染、client 加载、派发状态机、去重/幂等的改动必须有针对性回归（历史 HIGH 均源于这些点）。
5. **改契约先改 `docs/architecture/**`**（implementation-plan + 对应 patch），保持单一权威；冻结文档（NEXT-PHASE/ARCHITECTURE/PRODUCT-DESIGN）只允许 Lead 批准的**事实修正**。
6. **live 操作前先隔离验证**（`tools/dev/*` / 隔离 `DSH_HOME`），安装/重启/卸载由用户执行；不要在 live 上游脚本或反复重载。
7. **全确认模式是当前产品决策**：默认每次人工确认、`autoDispatch=false`；重开 auto 需重跑 V5 并满足 `V0-GATE.md` §6，不得通过调参/放宽阈值。

---

## 8. 当前 live 状态与残留测试数据（2026-11-18 11:4x，以 `/commander/state` 实测为准）

| 项 | 值 |
|---|---|
| origin | `$DSH_WEB_URL`（**不要写死**；重启/重载后端口会变，本次会话实测 `http://127.0.0.1:54132`） |
| 插件 | desktop profile 已装 `file:/Users/lzx/Documents/GitHub/dsh-commander/packages/dsh-commander`（bundles 含 `dsh-commander`）；`/commander/health` 200 `{ok:true,version:"0.1.0",panel:"present",binding:"bound"}`；**client `lib/client.js` = 246,540B（sha 前 16 `07d9af06…`，含看板/审批卡/自定义卡/i18n 81 key 修复）**；**最后 reload ≈ 2026-11-18 11:36** |
| 绑定 | workspaceId `c83dde64-4bf2-43c3-91ec-6f455401475b`，路径 `/Users/lzx/Documents/deepseek-harness/commander`，commander 会话 **`session-5e70318d-7148-4b58-9ce7-80905d5f4e53`**（本轮重绑；旧 `session-59d99d5b…` 已弃用，勿用于 handover 之后的验证），model 未设置（空） |
| 配置 | Jev `typesafe` / `https://api.typesafe.ai/v1/systemone` / `jev-latest` / keyEnv `JEV_API_KEY` / threshold 0.8 / confidenceFloor 0.5 / timeout 1500ms；board archiveAfterDays 30 / syncUserEdits true；ui theme `follow` |
| 任务计数 | 快照 **rev=3、tasks=6、workSessions=4、pendingDispatch=null**（平台重启后 rev 归零；tasks/workSessions 随测试数据增长）；`metrics={injections:0,deduped:0,pendingSkipped:0,injectFailures:0,projectionUnavailable:0}`；快照含 `archiveSummary`/`workSessions`（M2/M3 最终 build 已部署） |
| 残留测试任务 | `task_mwky02js3cad7e`（running，调研 LlamaIndex 最近更新，Research 工作区）、`task_mwkvrhkie0ad1a`（running，HtDot 导出按钮灰度开关·auto 能力验证）、`task_mwkv0q9d7230c9`（running，HtDot 订单导出加开关）、`task_mwkux1fs73b059`（draft，HtDot 订单导出加开关）——均为 M1 live 测试数据；对应测试工作会话仍在 `sessions` 表/DSH 侧栏，清理/保留由后续开发者与用户决定 |
| white名单 | 仅 `agent-workspace`、`Research` 为 allowed=true（commander/dsh-commander 工作区 allowed=false） |
| 注意 | 历史文档（m0-live-install 等）记录的是更早绑定（repo 路径/`session-55f9f4dc…`）；以本表实测为准（用户可能已重绑）。live 测试数据目录：`docs/tasks/htdot-order-export-switch/`、`tests/artifacts/m0/live/**`、`tests/artifacts/m1/live/**` |

---

## 9. 文档索引

| 类别 | 文档 |
|---|---|
| 产品/交接 | `docs/PRODUCT-DESIGN.md`、`docs/NEXT-PHASE.md`、`docs/ARCHITECTURE.md`、**本文件** |
| 实现蓝图/契约 | `docs/architecture/implementation-plan.md`、`m0-contract-patch.md`、`m1-contract-patch.md`、`validation-protocol.md` |
| 复核/审计 | `docs/architecture/{m0-review,client-load-audit,v5-review,v5-reopen-plan}.md`；`docs/validation/{V0-GATE,audit-m0,audit-m1,audit-V1-V4,audit-V5-*}.md` |
| 验收/运行记录 | `docs/validation/{m0-accept,m0-live-install,m1-accept,m1-boot,m2-accept,m3-accept,m1-artifacts/client-load-repro}.md`、`v1–v5-*.md` |
| 研究/评测 | `docs/research/{validation-env,capability-panel-api,v5-failure-analysis}.md`、`research/notes/dsh-capabilities.md`、`docs/eval/**` |
| 原型 | `prototype/README.md`、`prototype/app/`、`prototype/shots/` |


---

## 10. M5 追加派发（2026-11-20，已实现，待 live 走查）

> 契约：`docs/architecture/m5-continue-dispatch.md`（含实现落点 §19、验证证据、已知限制）。本次只实现代码与测试，**未动 live**。

### 10.1 行为变化

- `commander_task_dispatch` 允许 `draft/proposed/review`；`queued/running/blocked/done/cancelled/archived` 仍拒绝。`review` 续派 = 第 N+1 轮：`round+1`、上一轮 `acceptance`/`reportSummary` 进 `acceptanceHistory`、当前验收清空、`review→queued`。
- review 首次调用 `needs_confirmation` **保持 review**（不再写成 proposed）；默认推荐原会话 attach；续派复用 `autoDispatch` 门控（100% 且开关打开可直接开新一轮，不再强制确认）。同一会话续派 brief 只发增量，不重复目标/上一轮验收。
- `commander_task_dispatch` 新增 `instruction`（写进 brief 的「本轮要求」）与 `userRequest`（用户原话，展示/审计）；`DispatchRecord` 落 `brief/round/kind/userRequest`，详情返回 `dispatches[]` 全部轮次。
- 看板「返工」改为「继续派发」：`POST /continue`（`/rework` 兼容别名）只写 `pendingInstruction` + timeline，任务保持 review，向指挥官注入 `[task-continue]`；由指挥官再走 `commander_task_dispatch`。不再直接 prompt 工作会话。
- Client 详情：标题第一；状态/工作区/轮次在标题下；轮次导航（无轮次级状态）；每轮「用户原话 → 派发 brief 原文 → 工作会话 → 报告/验收」；历史轮折叠；继续派发 composer；看板卡显示「第 N 轮」而非「验收 N/N」。
- 旧轮次 `sessions` link 不参与状态跟踪/注入；`commander_task_report` 在 round>1 时只接受当前轮主会话。
- **2026-11-20 live 反馈修复**：同一会话续派 brief 只发增量（不再重复目标/上一轮验收）；续派复用 `autoDispatch` 门控（100% 且开关打开自动开新一轮）；`finishDispatch` 对 `turn/start` 顶掉 task.version 的竞态做重试，避免「第一次报 version changed、brief 已发出、重试又发一遍」的重复派发；取消任务（工具/看板）先 `sessionController.cancel` 关联 running/queued 会话，停止失败则不取消任务。

### 10.2 验证（2026-11-20）

| 项 | 结果 |
|---|---|
| typecheck | PASS |
| `pnpm --filter dsh-commander test` | **344/344 PASS** |
| `pnpm --filter dsh-commander build` | PASS |
| client harness | **173/173 PASS** |
| `node packages/dsh-commander/tests/e2e/m23-e2e.mjs` | **26/26 PASS，0 FAIL，3 INFO** |

### 10.3 部署

- Host 改动 → `pnpm --filter dsh-commander build` 后**重装插件 + 重启 DSH**。
- Client 改动 → 重装/重启后**硬刷新**；原生壳需 `build:native` + 重装（如启用）。
- 存储零迁移（新字段可选，旧记录按 round=1 / 空 history 读取）。

### 10.4 未走查

- live 真实多轮任务（review → 继续派发 → 确认 → 第二轮 → 验收）尚未由用户走查；隔离 e2e/harness 已覆盖 Host 语义与 DOM 装配。
- continue composer 只提交批注；最终目标仍在确认卡里选择。
- `blocked` 不允许续派；续派复用 `autoDispatch`，开关关闭或门控不通过时才确认。


**最近一次更新：2026-11-20 00:4x（Asia/Shanghai），M5 追加派发已实现并通过 typecheck/344 单测/harness 173/173/m23 e2e 26/26；未动 live，待用户重装+重启+硬刷新后走查真实多轮任务。**


---

## 11. 任务状态机定案 v1.0 实施（2026-11-22）

- **契约**：`docs/architecture/task-state-machine-final.md`（唯一口径）。实施范围：A 状态机/工具、B 依赖与提醒、C 看板/UI、D 文档/测试。
- **状态枚举不变**（9 个），看板六列：待派发 / 待运行 / 运行中 / 受阻 / 待验收 / 已验收；取消/归档在回收站；**删除通用状态拖拽**，人只保留 accept/archive/restore/cancel 按钮。
- **唯一迁移入口**：`src/host/tasks/state-machine.ts`（迁移图 + actor 权限 + 守卫 + 副作用）。所有写任务状态的入口（dispatch/report/turn/update/accept/archive/restore/cancel）都经它；`src/host/tasks/dependencies.ts` 负责 `dependsOn/ready/waitingFor` 纯函数与 DAG 校验。
- **工具面**：新增只读 `commander_task_get`；`commander_task_update` 改为 action enum + 必填 `expectedRevision`（stale → `task_stale_revision`，不落盘）；`commander_task_dispatch` 增加 `dependency_unmet` / `pending_dispatch_exists` 守卫；`commander_task_report` 来源仅 queued/running/blocked。
- **依赖提醒**：`src/host/tasks/notifications.ts`。accept 首次成功 → `[task-unblocked]`（一次一条，dispatch 结算后 pump 下一条；成功写 `dependencyNotifiedAt`）；cancel 成功 / review 来源 archive → `[task-dependency-blocked]`；Host 不自动派发、不自动改后继状态。
- **看板/API**：`PATCH /commander/board/tasks/:id` 只允许 priority/title（status → 400）；新增 `POST /commander/tasks/:id/cancel`；archive 写 `archivedFrom`，restore 按 archivedFrom 回退。
- **验证（本地，2026-11-22）**：typecheck PASS；`test` **373/373**；`build` PASS；`build:client` + client harness **51/51 smoke + 182/182 interact**（合计 233/233）；m1/m1r/m23 e2e 见交付报告。
- **部署**：Host 改动 + 新增 `lib/host/tasks/*` → `pnpm --filter dsh-commander build` 后**重装插件 + 重启 DSH**；Client 改动 → 硬刷新。存储零迁移（只加可选字段 `dependsOn/dependencyNotifiedAt/archivedFrom`，不新增表）。
- **破坏性变更**：task_update 参数（status→action+expectedRevision）、看板 PATCH status（移除）、新增 task_get；旧任务记录可继续读写。
