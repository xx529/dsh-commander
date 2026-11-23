# M0 验收独立复核（tester，task-32）

> 角色：tester（独立复核；只写 `packages/dsh-commander/tests/e2e/**`、`docs/validation/**`、`tests/artifacts/m0/**`；未改实现/配置、未碰 live Desktop）。
> 任务：`task-32`（M0 验收测试与独立复核，对应 NEXT-PHASE §4 M0-1..M0-4 + §6 DoD）。时间盒 40 分钟（含 backend 修复往返）。
> 复核对象：`packages/dsh-commander`（Host/Client）、`docs/validation/m0-build-spike.md`、`docs/validation/m0-artifacts{,-real}/`、`tools/dev/smoke-m0.sh`、`tools/dev/check-m0-api.sh`。
> 复跑命令：`node packages/dsh-commander/tests/e2e/m0-e2e.mjs`（隔离 e2e，证据写 `tests/artifacts/m0/e2e/`）。

## 0. 裁定摘要（截至本文件生成时）

| 项 | 裁定 | 依据 |
|---|---|---|
| **M0-4 面板缺失降级** | **PASS** | 隔离 web profile（无 capabilityPanel）真实 Host：`/commander/health` 200 `{panel:'absent',binding:'unbound'}`；host stderr 仅 `[commander] host ready`；无崩溃 |
| **M0-3 绑定持久化** | **PASS**（backend 修复后复测） | binding `cwd` 分支与 `workspaceId` 分支均 200 且 bound；重启 Host 后 `health.binding='bound'`，`state.binding.workspaceId/sessionId` 与 boot1 完全一致 |
| **M0-2 消息通道（user/assistant/SSE/status）** | **PASS（隔离）+ PASS（live API 真实模型）/ UI 点击路径 UNVERIFIED** | 隔离：stub provider 全链路 20/20 PASS；**live：`POST /commander/binding`→`POST /commander/message`→真实模型回复**（session `session-55f9f4dc-7926-4026-abf6-ca21225fa580`，assistant 484 字、约 8.1s；SSE 7 帧：snapshot/binding.updated/status/message(user)/heartbeat/message(assistant)/status；`state.messages=[user:1, assistant:2]`）证据 `tests/artifacts/m0/live/{binding-live.json,message-live.json,sse-live.json,state-live-after.json,live-api.log}`；**面板内 UI 点击/视觉路径因 GUI 自动化被兜底阻断，UNVERIFIED** |
| **M0-1 球/面板 UI + live 安装** | **PASS（live 核心，23:32–23:43）**；client 装配/交互预检 **PASS** | live：硬刷新（Cmd+Shift+R）后**右下角 56px 球出现**；**真实点击球 ×2** 完成面板打开/关闭后重开、**Esc ×1** 关闭；面板标题「指挥官/已绑定」、空态、消息流、输入框/发送按钮可见。证据 `tests/artifacts/m0/live/{20-current.png,22-panel-open-click.png,23-panel-closed.png,24-escape*.png,25-reopen.png,26-settings.png}`、`click-walkthrough.md`；**未验**：设置页四组（Lead 尝试 Cmd+,）、明暗主题、console、发送按钮实际点击（→ UNVERIFIED 待补） |
| **视觉/交互/样式/原型/截图审美五维** | **视觉 PASS / 交互 PASS（核心）/ 样式 PASS / 原型 UNVERIFIED / 截图审美 PARTIAL** | 依据 live 截图：球与面板符合 DSH 暗色 token；实际点击球开/关、Esc 关闭、重开；消息流/空态/输入区层级清晰；未做 prototype 并排对照、未切主题；评审意见见 §4.6 |
| **M0 整体验收（DoD）** | **PASS（核心：自动化 M0-2/3/4 + live M0-1 球/面板/点击开关/消息流）**；设置页/主题/console/发送点击 UNVERIFIED（补验项） | 隔离 e2e 20/20、单测 67/67、client harness 31/31+24/24；live：硬刷新后球/面板可见、真实点击开/关/Esc/重开 PASS、面板消息流 PASS、M0-2 live API 真实模型往返 PASS；未验项已在 `m0-accept.md` §6 标注 |

**严重级别计数（终态）：HIGH 0 / MEDIUM 3 / LOW 0**（M0 期间 4 个 HIGH 均已修复并由独立复跑关闭；原 MEDIUM M4「live GUI 自动化不可用」已降级关闭：Lead 代用户完成真实点击、tester 审阅截图/取证，M0-1 核心 live 走查已完成；设置页/console/主题仍为补验项）。

## 1. 方法与环境

- **隔离 profile 自动化**（不碰 live Desktop / `~/.dsh`）：一次性 `DSH_HOME=tests/artifacts/m0/e2e/probe-root/home`，`dsh --profile m0e2e --from-default-profile web` 初始化 → `dsh plugin add file:packages/dsh-commander` → `--patch tests/artifacts/m0/e2e/m0-e2e.patch.yml` 挂测试探针 → `dsh --profile m0e2e --patch … --port 0 --no-open` 启动真实 Host。
- **测试探针**（tester 新增，仅测试用，不进包产物）：`packages/dsh-commander/tests/e2e/probes/m0-e2e-probe.mjs`——apply 时 `workspaceRegistry.create(path)`（隔离 home 初始 0 工作区，binding 合同要求已注册）+ 注册确定性 stub LLM provider（复用 `tools/validation/probes/stub-llm.mjs`，`probe-stub/stub-1`，不联网）。
- **断言方式**：真实 HTTP（`fetch`）+ SSE 流逐帧解析 + 两次 boot 快照对比；不用 fake/单测替身。
- 证据目录：`tests/artifacts/m0/e2e/`（`commands.log`、`summary.json`、`health-boot1/2.json`、`binding-boot1.json`、`binding-cwd-branch.json`、`sse-capture.txt`、`message-1.json`、`state-boot2.json`、`boot-one.{out,err}`）。
- 构建产物只读复用（`packages/dsh-commander/lib/**`，由 backend 构建；e2e 记录 sha256）。

## 2. 隔离自动化结果（两次复跑）

- 第一次（修复前）：18 项断言 **8 PASS / 10 FAIL**——M0-3 binding 两分支均 500（H1）。
- 第二次（H1 修复后）：18 项断言 **12 PASS / 6 FAIL**——M0-3 全 PASS；M0-2 因 H2（prompt this 丢失）仍 FAIL。
- 第三次（prompt this 修复后）：18/18 PASS。
- 第四次（architect H1/M5/M6/M7 修复后，全新隔离 home）：**20/20 PASS，0 FAIL**（终态）：
  - M0-4/M0-3/M0-2 全部保持 PASS（binding 两分支 + 重启持久一致；message 200 + SSE user/assistant/status + 消息环）
  - **M5 PASS**：`state.messages` order=`user:1,assistant:2`（user echo 在 prompt 前 reserve order，无倒置）
  - **M6 PASS**：SSE 首帧 `event:snapshot id=4` 与快照 `rev=4` 相等，后续事件 id=`5,6,7` 递增
  - **H1（domainSpec layout=per-record）**：全新隔离 home 下 M0-2/3/4 业务链路全 PASS、无 storageDomain layout 错误（间接验证；布局本身由 backend 断言 + architect 复核）
- 备注：`env fixture workspace` 断言原按探针 stdout 判定存在时序误报，已改为轮询 `state.workspaces`（LOW，测试脚本口径问题，已修复）；终态 18/18。

## 3. 单测有效性抽查（task-32 第 2 项）

- `pnpm --filter dsh-commander test` → **61/61 pass**（unit+integration 44 + client 17；client 17 条**确实在 package test glob 内**，Lead 担心的“未进 glob”不成立，无需 devops 处理）。
- 逐条抽查关键路径断言真实性（不是只跑不失败）：
  - `tests/integration/host.test.ts`（17 条）：apply/health/snapshot/config merge/workspaces/绑定持久化/message 幂等/session-event→消息环/broken 语义/SSE/404-405-400/7 表 schema——覆盖 M0 契约面，断言具体字段值而非仅 200。
  - `tests/client/state.test.ts`（17 条）：SSE parser、rev 合并、消息去重/上限、失败归一化——纯函数断言。
  - unit：keys/messages/schema/sse/store/timeline/validation——均有显式期望值。
- **测试有效性口径补充**：architect/M7 轮后 package 测试为 **67/67 PASS**（tester 独立复跑；unit+integration 50 + client 17），新增 domainSpec layout 断言、消息 order 断言、SSE 首帧 id 断言、M7 panel 形状不符集成用例等。
- **已发现并已修补的测试有效性缺口（均已关闭）**：
  - H1：fake 原先同时接受 `workspaceId+cwd`，掩盖真实 `session.create` 合同违规 → 改为同传即 throw，并新增合同断言（58→61）。
  - H2：fake 的 `prompt` 是独立函数、不依赖 receiver，掩盖“解构丢 this” → 改为**每个方法先断言 `this === controller`**，解构调用即 throw；集成测试新增断言第二参为 AbortSignal。
- **仍存在的测试缺口（MEDIUM）**：
  1. ~~fake 无法覆盖 receiver/this~~（已由 fake receiver 断言关闭，61/61）。
  2. package 内**没有真实 Host/真实 sessionController 的 e2e**（integration 全用 fake）；本轮 tester e2e 是首个真实 Host 路径覆盖，建议纳入 CI（或 devops 的 smoke 扩展）。
  3. ~~`jsdom 24/24` 无可复跑证据~~（已关闭）：frontend 已把 client harness 入库 `packages/dsh-commander/tests/client/harness/`（`smoke.mjs`/`interact.mjs`/`run-harness.mjs`/README）；tester 独立复跑（architect H2/H3 修复后、`build:client` exit 0）**smoke 31/31、interact 24/24、`[harness] PASS` exit 0**（client=`lib/client.js` sha256 `692ceede2a360c9ed4518df9ec2601a26e3af319bbcd9b36196c3bdc984d373f`、85,992B；证据 `tests/artifacts/m0/harness/{run.log,build.log}`）；独立核对：bundle 内 `session.prompt|getRemote` 命中 **0**、`pointer-events` **4** 处；`package.json` 的 `dsh.client.inject` 已不含 `dsh-api-remotes`（仅 layout+settings）。缺可选依赖时单脚本 exit 2 + 安装指引（wrapper exit 1）。**边界**：只证明 client 装配/交互与产物形态，不替代 live Desktop 视觉/主题/console 走查；react/react-dom/jsdom 为 harness 可选依赖（不在 package devDependencies、不进 `test` 脚本，client 保持零运行时依赖）。
  4. SSE 的 busy→idle 迁移只在 fake session/event 下测过，真实回合的 `commander.status` 时序需 e2e（H2 修复后由本 e2e 覆盖）。

## 4. 发现清单（id / 证据 / 严重级别 / owner）

### HIGH

**H1（已修复关闭）binding 三选一违规 → M0-3 必然 500。**
- 证据：`tests/artifacts/m0/e2e/binding-boot1.json`（修复前）`500 {"code":"internal","message":"session.create accepts workspaceId or cwd, not both"}`；根因 `src/host/session/binding.ts` bindNew 同时传 `workspaceId`+`cwd`；真实 Desktop 工作区都有 path → binding 永久失败。
- 修复：backend 已改二选一 + fake 合同校验 + 3 条断言；tester 复测 **M0-3 转 PASS**（两分支 200、重启持久一致）。
- 测试缺口已同步修补（61/61）。

**H2（已修复关闭）prompt 方法丢失 this → 502 `Cannot read properties of undefined (reading 'ctx')`。**
- 证据：`tests/artifacts/m0/e2e/message-1.json`（502）、`sse-capture.txt`（无 assistant/status）；根因 `src/host/session/deliver.ts:57` `const prompt = controller()?.prompt` + `:66` 解构调用；真实 `dsh-api-session-controller` 实现依赖 `this.ctx`（已核对安装包 `this.ctx = ctx` / `const ctx = this.ctx`）。
- 影响：M0-2 消息通道（user→assistant→SSE→busy 状态）不可用；面板“发送后无回复”。
- owner：**backend**（修法：`controller().prompt(...)` 或 `prompt.call(controllerRef, …)`；fake 需以 this 自省补断言）。
- 状态：backend 已改为 `const controllerRef = controller(); await controllerRef.prompt(...)` 并给 fake 加“方法必须以 controller 为 receiver”断言；tester 复测 **M0-2 转 PASS（18/18）**，单测 **61/61**。

### MEDIUM
- **M1 devops `tools/dev/check-m0-api.sh` 覆盖缺口（owner devops）**：① binding 只断言 200、实测 400 记为 FAIL 后仍继续，未覆盖“成功绑定”路径（M0-3 正例缺失）；② 脚本第 192 行存在 shell 语法错误（`line 192: syntax error near unexpected token ')'`），以 `OUTDIR=tests/artifacts/m0/devops-api` 复跑时 `exit=2`，后半段断言未执行 → 该脚本目前不能作为完整证据。
- **M4 live GUI 自动化不可用（环境，owner Lead/用户）**：`agent-desktop` 在 tester sandbox 下所有窗口命令失败（`ps: Operation not permitted` → inventory 不可稳定），`osascript` Automation 权限违例（-10004）→ 无法发送 Cmd+R、点击、读取 console。影响 M0-1 视觉/点击走查与 M0-2 的 UI 路径；已请 Lead 协调用户手动刷新/配合点击，或在非沙箱终端执行 agent-desktop。**不是实现缺陷**。
- **M2 测试基础设施缺口**：fake 无法发现 this 丢失类合同违规（见 §3）；建议 fake 以真实 receiver 语义实现 + 集成断言。
- **M3 M0-2 的 assistant 证据依赖测试用 stub provider**（不联网、非真实模型）：真实 provider 回复留 live 验收，报告中必须标注（`m0-accept.md` §7 已写）。

### LOW
- **无未关闭 LOW**。原 L1（M7 panel_shape_mismatch 未独立复验）已由 backend 补**集成级**用例关闭：`tests/integration/host.test.ts`「panel with wrong shape (jev.rank/apply not functions) degrades to panel:absent at integration level (M7)」用真实 `apply()` 装配 + fake `capabilityPanel={jev:{rank:true,apply:true}}` 断言 `GET /commander/health → panel:'absent'`；单测 `tests/unit/panel.test.ts` 覆盖 object/thunk/缺 rank/非 function/抛错（`panel_shape_mismatch`/`panel_threw`/`panel_unavailable`）。tester 独立复跑 `pnpm --filter dsh-commander test` → **67/67 PASS**。
- 原 L1（e2e fixture 断言时序）已改轮询修复；原 L2（client harness 不可复跑）已由 frontend 入库 + tester 独立复跑关闭（31/31、24/24）。
- **L2（口径说明，非缺陷）**：client 保留「SSE 不可用时只读 `GET /commander/state` 轮询（3s）」作为**快照降级**（task-30 契约 §8.4 断线重连），与已删除的 remote 消息直连（H3）不同；审计认可其存在，边界要求：不得发送消息、不得替代 `POST /commander/message`（当前 bundle 内 `session.prompt|getRemote`=0 已证）。

## 4.5 live 验收证据（task-36，2026-11-17 21:13–21:2x）

- **环境**：运行中 DSH Desktop（live Host `http://127.0.0.1:51062`，health 200 `panel:'present'`、28 workspaces）；插件已安装 0.1.0。
- **M0-2 live（API 路径）PASS**：`binding(new, workspaceId=dsh-commander)` → 200 `session-55f9f4dc-…`；`message` → 200 `accepted=true`；SSE 7 帧含 user/assistant `commander.message` 与两次 `commander.status`；**真实模型回复 484 字、约 8.1s**；`state.messages=[user(order1), assistant(order2)]`、`status=bound`、`rev=5`。证据：`tests/artifacts/m0/live/{binding-live.json,message-live.json,sse-live.json,state-live-after.json,live-api.log}`。
- **M0-1 live（UI）UNVERIFIED（环境阻断）**：
  - 刷新：`agent-desktop press cmd+r` ×2 → TIMEOUT（`ps: Operation not permitted`，sandbox 拒绝应用清单）；`osascript` → Automation 权限违例。截图（`00-before.png`、`frames/*.png`、`04-corner-now.png`）**未见 commander 球**（右下为 DSH 原生 stop 按钮），确认页面仍为旧 bundle、需用户 Cmd+R。
  - UI 规格静态核对：球 56×56（`styles.ts:15`）、面板 420×660（`:54`）、`entryPosition:'br'`、`theme:'follow'`（live config 实测）、设置页四组数据面（commander/jev/board/ui）HTTP 200。
  - 点击走查（控件 ≈10–12，实际点击 **0**）、console 检查：**UNVERIFIED（环境阻断）**；完整记录与待办见 `tests/artifacts/m0/live/walkthrough.md`。

## 4.6 live M0-1 视觉/点击走查（2026-11-17 23:32–23:43，硬刷新后）

- **环境**：live DSH（origin `http://127.0.0.1:49921`）；client `lib/client.js` sha256 `e82b4d16…`（131,141B）、`package.json` client inject 含 `@deepseek-ai/dsh-client-locale`；硬刷新 Cmd+Shift+R 后 client 正常加载。
- **控件清单与实际操作**：悬浮球 ×1、面板（开/关）、输入框 ×1、发送按钮 ×1、设置入口 ×1；**实际点击：球 ×2、Esc ×1**；面板消息流可见（含真实 commander 回复）；发送/设置入口未实际点击。
- **证据与结果**：

| 步骤 | 操作 | 期望 | 证据 | 结果 |
|---|---|---|---|---|
| 1 | 硬刷新后观察 | 右下 56px 球出现 | `tests/artifacts/m0/live/20-current.png` | **PASS** |
| 2 | 真实点击球 | 面板打开、标题「指挥官/已绑定」、空态/输入框 | `tests/artifacts/m0/live/22-panel-open-click.png` | **PASS** |
| 3 | 点击关闭/Esc | 面板关闭、球保留 | `tests/artifacts/m0/live/23-panel-closed.png`、`24-escape.png`、`24-escape-closed.png`、`24-close-click.png` | **PASS** |
| 4 | 再点球 | 面板重开正常 | `tests/artifacts/m0/live/25-reopen.png` | **PASS** |
| 5 | 面板消息流 | user/commander 消息、状态可见 | `22-panel-open-click.png`、`26-settings.png` | **PASS** |
| 6 | 设置页四组（指挥官/工作区/派发与 Jev/外观） | 四组可见、Jev 测试连接可用 | — | **UNVERIFIED**（Lead Cmd+, 尝试中，未截到） |
| 7 | 明暗主题切换 | 球/面板样式跟随 | — | **UNVERIFIED**（未切换） |
| 8 | console 无 slot crashed / 无 commander 异常 | `[dsh-commander]` 无 error | 用户 DevTools 可见大量非 commander 错误（`ingest` WS/404，来自其它插件） | **UNVERIFIED**（tester sandbox 无 GUI；未见 `[dsh-commander]` 前缀异常，但不能替代 console 断言） |

- **视觉五维裁定**：
  - 视觉 **PASS**：球 56px 圆角/配色与 DSH 暗色 UI 一致；面板右侧抽屉层级清晰（标题/已绑定 badge/空态/输入区），无溢出遮挡。
  - 交互 **PASS（核心）**：球点击开/关、Esc 关闭、重开、消息流渲染均正常；发送按钮与设置页交互未验。
  - 样式 **PASS**：字体/圆角/暗色 token 与 DSH 主界面一致。
  - 原型 **UNVERIFIED**：未与 `prototype/app|screens|shots` 做并排对照（无 Figma，仓库原型为参照）。
  - 截图审美 **PARTIAL**（主观，需 Lead/UX 复核）：信息层级与留白良好；建议后续补主题/设置页截图再审。
- **裁定**：M0-1 live **PASS（核心）**；M0 整体 **PASS（核心）**，设置页/主题/console/发送点击为补验项（不影响 M0-1 球/面板/点击核心结论）。

## 5. M0 逐条复核结论与 owner

| M0 项 | 结论 | 证据 | owner/整改 |
|---|---|---|---|
| M0-1 插件安装 + 球/面板可见 | **UNVERIFIED**（live 部分待安装）；client 装配/交互预检 **PASS** | `m0-build-spike.md`（隔离加载 PASS）；client harness `smoke 31/31`/`interact 24/24`（`tests/artifacts/m0/harness/run.log`）；live 截图待补 | Lead 安排 live；tester 执行走查 |
| M0-2 面板消息通道 | **PASS**（H2 修复后复测，18/18） | `tests/artifacts/m0/e2e/{message-1.json,sse-capture.txt,state-after-message.json}` | ✅ 已闭环 |
| M0-3 绑定持久化 | **PASS**（修复后） | `binding-boot1.json`、`state-boot2.json`、`health-boot2.json` | ✅ 已闭环 |
| M0-4 面板缺失降级 | **PASS** | `health-boot1.json`、`boot-one.err`（0 fatal） | ✅ |
| DoD：可复现记录 | **PASS（隔离部分）** | `node packages/dsh-commander/tests/e2e/m0-e2e.mjs` + `commands.log` | live 部分待补 |
| DoD：关键路径自动化 | **PASS（隔离部分）** | 单测 61/61 + 真实 Host e2e 18/18（M0-2/3/4）+ client harness 26/26+24/24（M0-1 预检）；建议纳入 CI | backend/frontend |
| DoD：失败降级 | **PASS（隔离部分）** | 面板缺失不崩 PASS；prompt 失败分级（仅会话不可恢复错误 markBroken）已由 fake/集成断言覆盖 | backend |
| DoD：无新概念 | **待 architect** | 域 commander + 表结构与蓝图一致（board_edits 为 Lead 裁定） | architect |

## 6. 视觉/交互/样式/原型/截图审美五维（live，待执行）

| 维度 | 状态 | 原因 |
|---|---|---|
| 视觉 | **UNVERIFIED（环境阻断）** | live 页面未刷新出新 bundle（无球）；GUI 自动化被 sandbox 拒绝 → 无法取得球/面板/设置页截图；静态规格已核对（56px/420×660/br/follow）；待用户 Cmd+R 后补 |
| 交互 | **UNVERIFIED（UI，环境阻断）**；逻辑层 harness PASS | harness `interact 24/24`；live Host API 真实消息往返 PASS（binding→message→assistant→SSE）；live UI 点击（控件≈10–12，实际 0 次）因 agent-desktop/osascript 被拒无法执行 |
| 样式 | **UNVERIFIED（环境阻断）** | 明暗主题/DSH token 一致性需面板可见后截图；live config `theme:'follow'` 已就绪 |
| 原型 | **UNVERIFIED（无 Figma + 环境阻断）** | 参照 `prototype/app`、`prototype/screens`、`prototype/shots`（仓库原型，非 Figma）；需面板截图后并排对照 |
| 截图审美 | **UNVERIFIED（环境阻断）** | 当前仅 DSH 主窗口截图；面板/设置页截图待用户刷新配合 |

模板与执行步骤见 `docs/validation/m0-accept.md` §6；live 安装后证据写 `tests/artifacts/m0/live/**`。

## 7. 限制

1. 隔离 e2e 使用测试探针注册临时工作区（隔离 `workspaceRegistry` 初始为空）+ stub provider（无真实凭据）；真实 Desktop/真实 provider 行为留 live 验收。
2. 未触碰 live Desktop、未写 `~/.dsh`、未读 `.env`；未改实现代码/配置（仅 tests/e2e 探针与脚本、证据文件）。
3. 时间盒内完成两轮修复-复跑（H1 关闭、H2 已定位在修）；M0-2 转 PASS 需 backend H2 修复后一次复跑确认。
4. 本轮 M0 自动化三项（M0-2/3/4）全 PASS（e2e 20/20）；live M0-1 球/面板/点击开关/消息流已 PASS（§4.6）。**M0 整体裁定：PASS（核心）**；设置页四组/主题/console/发送按钮点击为 UNVERIFIED 补验项（待 Lead/用户补截图后可关闭）。
