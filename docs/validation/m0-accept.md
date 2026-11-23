# M0 验收清单与证据模板（tester 维护，task-32）

> 用途：M0（NEXT-PHASE §4 四条 + §6 DoD）验收的执行清单、证据模板与判定口径。
> 执行人：tester（隔离自动化部分已执行；**live M0-1 视觉/点击走查于 2026-11-17 23:32–23:43 由 Lead 代用户真实点击 + tester 截图/审阅完成**，见 `docs/validation/audit-m0.md` §4.6）。
> 隔离约束：自动化部分只用一次性 `DSH_HOME`（`tests/artifacts/m0/e2e/probe-root`），不碰 live Desktop / `~/.dsh`；证据写 `tests/artifacts/m0/**`。
> 时间：2026-11-17（M0 验收阶段）。

## 0. 判定口径

- **PASS**：清单内可执行步骤全部完成且期望结果逐条匹配，证据文件存在且可复跑。
- **FAIL**：任一硬性期望不满足（含启动崩溃、路由/持久化失败、DoD 缺项）。
- **UNVERIFIED**：依赖 live 安装或其他未就绪前置，当前无法执行；**不得以“看起来正常”代替证据**。
- 视觉/交互/样式/原型/截图审美五维：live 未安装时一律 **NOT_APPLICABLE（待 live 安装）**；无 Figma 原型时以 `prototype/app`+`prototype/screens` 截图作参照并在证据中标注“原型=仓库原型，非 Figma”。

## 1. M0-1：插件可安装/球与面板可见（live Desktop）

| 项 | 内容 |
|---|---|
| 操作步骤 | ① Lead 安排把 `packages/dsh-commander` 安装到 live Desktop profile（`dsh plugin --profile desktop add file:…`，需 Lead 明确授权）→ ② 重启 Desktop → ③ 观察右下/左下球与面板入口 |
| 命令/证据 | live 安装命令输出、Desktop 版本、`/commander/health`（live origin 不可直连时用 UI 状态）、截图：`tests/artifacts/m0/live/*.png` |
| 期望 | 插件被加载（无 "did not activate"）；球显示在配置位置（br/bl）；点击球打开面板；明暗主题跟随 |
| 实际 | **live M0-1 核心 PASS（23:32–23:43）**：硬刷新（Cmd+Shift+R）后右下 56px 球出现；**真实点击球 ×2**（打开/关闭后重开）+ **Esc ×1** 关闭；面板标题「指挥官/已绑定」、空态/消息流/输入框/发送按钮可见。证据 `tests/artifacts/m0/live/{20-current.png,22-panel-open-click.png,23-panel-closed.png,24-escape*.png,25-reopen.png,26-settings.png}` + `click-walkthrough.md`。**未验（UNVERIFIED）**：设置页四组（Lead Cmd+, 尝试中）、明暗主题、console（sandbox 无 GUI；用户 DevTools 仅见非 commander 的 `ingest` WS/404 错误）、发送按钮实际点击。**client 装配/交互预检 PASS**：harness smoke 31/31 + interact 24/24（`tests/artifacts/m0/harness/`）。 |
| 视觉五维 | **视觉 PASS / 交互 PASS（核心）/ 样式 PASS / 原型 UNVERIFIED / 截图审美 PARTIAL**：球与面板符合 DSH 暗色 token；实际点击开/关/Esc/重开/消息流正常；未做 prototype 并排对照、未切主题；评审见 `audit-m0.md` §4.6 |

## 2. M0-2：面板消息通道（隔离已自动化 + live 复核）

| 项 | 内容 |
|---|---|
| 操作步骤（隔离） | 隔离 web profile（无 capabilityPanel）→ 安装本包 → 探针 patch 注册 workspace + stub provider（`probe-stub/stub-1`）→ `POST /commander/binding {mode:'new', workspaceId}`（=M0-3）→ 打开 SSE `GET /commander/state`（`Accept: text/event-stream`）→ `POST /commander/message {text,requestId}` |
| 期望 | POST 200 `{accepted:true,messageId}`；SSE 收到 `event: commander.message`（user 回显）、`commander.message`（assistant，stub 回复）、`commander.status`（busy true→false）；重复 `requestId` 幂等返回同 messageId |
| 命令/证据 | `node packages/dsh-commander/tests/e2e/m0-e2e.mjs`；`tests/artifacts/m0/e2e/{message-1.json,sse-capture.txt,state-after-message.json}` |
| 实际 | **PASS（H2 修复后复测）**：POST message 200 `accepted=true`；SSE 收到 user echo + assistant（stub）+ commander.status；`state.messages=user,assistant`。证据 `tests/artifacts/m0/e2e/{message-1.json,sse-capture.txt,state-after-message.json}` |
| live 复核（Host API 路径已完成） | **PASS（API 层）**：`POST /commander/binding(new, workspaceId)` → 200 sessionId `session-55f9f4dc-…`；`POST /commander/message` → 200 accepted；SSE 7 帧（snapshot/binding.updated/status/user message/heartbeat/assistant message/status）；**真实模型回复 484 字、约 8.1s**；`state.messages=[user:1,assistant:2]`。证据 `tests/artifacts/m0/live/*.json`+`live-api.log`；**面板内 UI 点击路径因 GUI 自动化阻断 UNVERIFIED** |

## 3. M0-3：绑定持久化（隔离已自动化）

| 项 | 内容 |
|---|---|
| 操作步骤 | 隔离 profile → boot1：POST binding new → 读 `GET /commander/state.binding` → 停止 Host → boot2（同一 `DSH_HOME`）→ 再读 `state.binding` |
| 期望 | 两次 boot 的 `binding.workspaceId/sessionId/workspacePath` 一致；`health.binding==='bound'`；不自动新建/不丢配置 |
| 命令/证据 | `node packages/dsh-commander/tests/e2e/m0-e2e.mjs`；`tests/artifacts/m0/e2e/{binding-boot1.json,state-boot2.json,health-boot2.json}` |
| 实际 | **PASS（backend 修复后复测）**：`bindNew` 已改为二选一（有注册工作区传 workspaceId、cwd-only 传 cwd）；隔离 e2e 两分支均 200 bound；重启后 `health.binding=bound` 且 `state.binding` 与 boot1 一致。证据 `tests/artifacts/m0/e2e/{binding-boot1.json,state-boot2.json,health-boot2.json}` |
| 附加 | `mode:'select'`（attach 已有会话）不调用 create，不受该缺陷影响；修复后需验两种 mode |

## 4. M0-4：失败降级/无面板启动（隔离已自动化）

| 项 | 内容 |
|---|---|
| 操作步骤 | 隔离 web profile（无 capabilityPanel）→ 安装本包 → boot Host → `GET /commander/health` |
| 期望 | Host 启动不崩溃（无 fatal / "did not activate"）；health 200；`panel:'absent'`；`binding:'unbound'`（无绑定也可用）；消息/状态路由存在但不因无面板拒绝启动 |
| 命令/证据 | `node packages/dsh-commander/tests/e2e/m0-e2e.mjs`；`tests/artifacts/m0/e2e/{health-boot1.json,boot-one.err,commands.log}` |
| 实际 | **PASS**（health 200 panel:absent、stderr 0 字节、进程存活；见 audit-m0.md） |
| 附加（live） | 面板缺失/崩溃时球行为与提示、`inherit` 回退（live 安装后复核） |

## 5. DoD 勾选（NEXT-PHASE §6）

| DoD 项 | 判据 | 当前 |
|---|---|---|
| 可复现记录 | 命令/退出码/原始返回/证据路径齐全，可一条命令复跑 | ✅ 隔离 `node packages/dsh-commander/tests/e2e/m0-e2e.mjs`；live 证据 `tests/artifacts/m0/live/{*.png,click-walkthrough.md,*.json}` |
| 关键路径自动化测试 | M0-1..M0-4 关键路径有自动化断言（非“只跑不失败”） | ✅ 隔离：M0-2/3/4 全 PASS（e2e **20/20**）、单测 67/67、client harness 31/31+24/24；live M0-1 视觉/点击核心 PASS（真实点击球2/Esc1，证据见上） |
| 失败降级 | 面板缺失不崩、绑定/投递失败不自动新建（broken 语义） | M0-4 面板缺失 PASS；binding 失败语义（500 internal）与 prompt 失败标 broken 待真实 Host 验证 |
| 无新概念 | 不引入未在蓝图 §3 的域/表/概念 | 待 architect 复核；tester 未发现新增概念（域 commander + 6+1 表与蓝图一致，board_edits 为 Lead 裁定改名） |

## 6. 视觉/交互/样式/原型/截图审美五维（live，已执行 2026-11-17 23:32–23:43）

| 维度 | 检查点 | 证据 | 结果 |
|---|---|---|---|
| 视觉 | 球/面板/设置页四组布局、间距、对比度、明暗主题 | `tests/artifacts/m0/live/{20-current,22-panel-open-click,25-reopen,26-settings}.png` | **PASS（球/面板）**；设置页四组/明暗主题 **UNVERIFIED** |
| 交互 | 球→面板→输入→发送→回复→关闭；设置页保存→重开生效；快捷键 | 截图序列（球点击×2、Esc×1、重开）+ `click-walkthrough.md` | **PASS（核心：开关/重开/消息流）**；发送点击/设置页交互 **UNVERIFIED** |
| 样式 | 与 DSH 现有 UI（token/字体/圆角）一致性、无溢出/遮挡 | 面板/球截图 | **PASS**（暗色 token 一致，无溢出） |
| 原型 | 与 `prototype/app`、`prototype/screens` 对照（无 Figma，标注为仓库原型） | 并排对照图 | **UNVERIFIED**（未做并排对照） |
| 截图审美 | 信息层级、留白、状态反馈清晰度（主观项，需 Lead/UX 复核） | 截图 + 评审意见 | **PARTIAL**（层级/留白良好；待 UX/Lead 复核 + 主题截图） |

## 7. 环境限制（必须随证据读）

1. 隔离 `DSH_HOME` 的 `workspaceRegistry` 初始为空；binding 合同要求已注册工作区 → 自动化用**测试专用探针**（`packages/dsh-commander/tests/e2e/probes/m0-e2e-probe.mjs`）在 apply 时 `workspaceRegistry.create(path)`，再用同一 path 走 binding。
2. 隔离 home 无真实 provider 凭据 → M0-2 的 assistant 回合用确定性 **stub provider**（`tools/validation/probes/stub-llm.mjs`，不联网、非真实模型）；真实模型回复留 live 验收。
3. 隔离 web profile **天然无 capabilityPanel**，用于 M0-4 panel:absent 场景；live Desktop 有面板，两者都需覆盖。
4. 本轮发现的 binding 缺陷（workspaceId+cwd 同时传）属实现问题，与隔离环境无关（真实 Desktop 工作区都有 path）→ M0-3/M0-2 在修复前判定为 FAIL/UNVERIFIED，不得用“隔离环境限制”免责。
5. live 部分需 Lead 明确授权安装到 Desktop；tester 未触碰 live。
