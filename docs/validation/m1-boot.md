# M1 真实 Host boot 验证 + live 更新准备

- **结论：boot PASS（22 项断言 PASS + 5 条 FINDING）**；**FINDING 已更正并撤回**：指挥官 tools 实际**已注册且可执行**（stub 模型真实回合驱动 `task_create` 验证，见 §5.1；此前 `tools.schemas()` 观测口径不反映动态 `register()`，属误报）。隔离 web profile 启动最新 M1 构建：boot 无致命错误、健康/状态/配置/Jev 测试/任务路由/绑定/消息/客户端 boot graph 全部符合契约；`systemPrompt` 注册路径 OK；指挥官 tools 由 stub 模型真实回合验证**可调用且真实执行**（§5.1）。
- 执行人 / 执行时间：devops / 2026-11-17 21:52–22:12
- 环境：一次性 `DSH_HOME=/tmp/dsh-commander-m1`（web 模板 + 本地包 + 只读 introspect fixture），**未写 live profile、未重启 DSH**
- 脚本：`tools/dev/check-m1-increment.sh`（可复跑：`PROBE_ROOT=/tmp/x OUTDIR=/tmp/ev bash tools/dev/check-m1-increment.sh`）
- 证据：`docs/validation/m1-artifacts/`（`commands.log` 含每条 curl/断言；boot/health/state/jev/tasks/binding/introspect 原文）

---

## 1. 命令与退出码

| # | 命令 | 退出码 |
|---|---|---|
| 1 | `pnpm --filter dsh-commander build`（Host tsc + Client tsdown+wrap） | **0** |
| 2 | `node tools/dev/verify-bundle.mjs packages/dsh-commander/lib/client.js dsh-commander` | **0**（9 项全 PASS；client 128,777B 级） |
| 3 | `dsh --profile m1 --from-default-profile web --dump-default-config` | **0** |
| 4 | `dsh plugin --profile m1 add file:<repo>/packages/dsh-commander` | **0** |
| 5 | `COMMANDER_BOOT_LOG=warn dsh --profile m1 --patch <introspect.patch.yml> --port 0 --no-open` | 启动后由脚本 HTTP 驱动 |
| 6 | `bash tools/dev/check-m1-increment.sh`（完整探针） | **0**（22 ASSERT PASS + 5 FINDING；FINDING 已按 §5 更正） |
| 7 | `bash tools/dev/check-m1-tools.sh`（stub 模型真实回合驱动 task_create） | **0**（11 ASSERT PASS） |

## 2. boot 证据

- `05-boot.out`：只有 `dsh web: http://127.0.0.1:…/?token=…`
- `05-boot.err`：**仅一行** `[commander] host ready (version=0.1.0, domainVia=defineDomain, configInitialized=true, panel=absent)` → **无 tools/systemPrompt 相关报错**（backend 关注的风险点未在 boot 期暴露）
- `--dump-config`（隔离 profile）含 `- id: commander`（M0 同流程已证）；bundle 自动追加（M0 已证）

## 3. 路由/状态面（隔离 Home，panel=absent）

| 检查 | 实测 |
|---|---|
| `GET /commander/health` | **200** `{"ok":true,"version":"0.1.0","panel":"absent","binding":"bound"}`（绑定后） |
| `GET /commander/state` | **200**；keys：`ok,rev,serverTime,binding,commanderStatus,panel,counts,tasks,workspaces,pendingDispatch,metrics,commanderBusy,messages`；`pendingDispatch:null`；`tasks:[]`、`workspaces:[]`、`counts` 全 0 |
| `GET /commander/config` | **200** |
| `POST /commander/jev/test`（无 key） | **200** `{"ok":false,"code":"jev_unavailable","message":"Jev API key env 'JEV_API_KEY' is not set","latencyMs":0,"requestId":"probe_…","apiKeyEnv":"JEV_API_KEY","hasApiKey":false}` —— **不回传 key**，分类正确 |
| `GET /commander/tasks/task_nonexistent_probe` | **404** `{"ok":false,"code":"not_found","message":"task 'task_nonexistent_probe' not found"}` —— envelope 正确（M1 新路由可达） |
| `POST /commander/binding`（cwd-only） | **200**，sessionId 已建、`commanderStatus:"bound"` |
| `POST /commander/message` | **200** `accepted:true`（M1 消息路径回归） |
| 页面 boot graph（带 token） | commander client entry：`inject=["@deepseek-ai/dsh-client-ui-layout","@deepseek-ai/dsh-client-ui-settings"]`（H3a 两项）、`immediately:true`、`rev=d9bc7a79545a` |

## 4. tools / systemPrompt 注册路径（introspect fixture）

`tools/dev/spike/m1-introspect.mjs`（只读探针，`GET /m1/agent-tools?sessionId=`）在**绑定后的指挥官 agent 作用域**观察：

```json
{
  "agentFound": true,
  "toolNames": ["working_directory","team_task_create","team_task_list","team_task_get","team_task_update"],
  "commanderTools": [],
  "systemPrompt": "object",
  "errors": []
}
```

- **systemPrompt**：`agent.ctx.get('systemPrompt')` 为 object → `ctx.inject(['systemPrompt'])` 路径**已生效**（指挥官 prompt 段注册无异常）。
- **tools**：`agent.ctx.get('tools')` 可用（能列出 5 个宿主工具），但 **`task_create/task_update/dispatch_task/board_query` 四个指挥官工具未出现在该 agent 的 tools 列表** → 见 §5 FINDING。

## 5. 工具注册验证（含对初版 FINDING 的更正）

### 5.1 结论：tools 已注册且可执行（真实回合判据）

boot 面无法直接观测动态注册的工具：`tools/dev/spike/m1-introspect.mjs` 用 `agent.ctx.get('tools').schemas()` 判断时，即使**手动 `register()` 一个合法工具**，`schemas()` 也不返回它（selftest 实测 `registerOk:true`，`schemasAfter` 仍只有宿主 5 个工具）→ **`schemas()` 不是动态注册的观测口径**；我最初据此报的 4 条 "tools 未注册" FINDING 属**误报**，现撤回（F2 的"重启 resume 后仍缺"同因）。

改用**真实 agent 回合**判据：`tools/dev/check-m1-tools.sh` 在隔离 web Host 注入确定性 stub LLM（`tools/dev/spike/m1-tools-driver.mjs`）：bind cwd-only → 指挥官会话 `selectModel(probe-stub/stub-1)` → `POST /commander/message`（含 `PROBE_M1_TASK`）→ stub 模型发 `task_create` 工具调用 → 工具执行。

实测（exit 0，**11 项断言 PASS / 0 FAIL**，证据 `docs/validation/m1-tools-artifacts/`）：
- 回合完成：`turn/end` 出现，事件流含 `tool/call` + `tool/result`；
- **`task_create` 真实执行**：`GET /commander/state.tasks` 出现 1 条记录，title=`probe-m1-tool-task`；
- `GET /commander/tasks/<taskId>` 返回该任务（M1 新路由联调通过）；
- 证据：`08-drive.json`（事件流）、`09-state.json`、`11-task-by-id.json`、`commands.log`。

### 5.2 早前 FINDING 的处理

- backend 已按该反馈加固（defineTool 多锚点/`onDiagnostic`/`onBound` 主动安装/未就绪重试），加固**保留**（有益稳定性）；
- 但**原始判据不成立**，F1/F2 不构成"tools 未注册"的证据；不再要求 backend 为此"修 bug"，以 §5.1 真实回合结果为准。
- 诊断留档：`15b-introspect.json`（defineTool 加载 OK / register OK / schemas 不反映）、`15c-specs-test.json`（repo 构建产物 `specs()` 返回 4 工具名、diagnostics 空）；新版 introspect 已不再据此下结论。

### 5.3 说明

- `systemPrompt` 路径：指挥官 agent 作用域 `systemPrompt` 为 object → OK。
- 隔离 Home 无真实模型 key，dispatch 全链路（needs_confirmation→确认→queued→turn/start running）由 tester M1 e2e 覆盖；§5.1 已证明"模型能调用指挥官工具并真实执行"这一前提。

## 6. live 更新步骤（含新增文件时的正确流程）

### 6.1 当前 live 状态（重装修复后，devops 只读核查 2026-11-17 22:5x）

- repo 与 live 的 `lib/**/*.js` **均 39 个**（一致）；M1 新增文件 `dispatch/{capability,service,candidates,gate,spawn}.js`、`jev/client.js`、`tools/index.js` 在 live 侧全部存在；
- `GET /commander/health` → **200** `{"ok":true,"version":"0.1.0","panel":"present","binding":"bound"}`
- `GET /commander/state` → **200**（`commanderStatus:"bound"`、`pendingDispatch:null`、workspaces=28、tasks=0、messages=0；重启后 rev 重新从 0 计）
- `GET /commander/config` → 200；`node tools/dev/verify-live-m0.mjs --origin http://127.0.0.1:<PORT>` → **exit 0（15 PASS + 1 SKIP：页面 boot graph 需 token）**
- `POST /commander/jev/test` → 200，`hasApiKey:true`，但本次 `code:"timeout", latencyMs:1502`（live Jev 配置 `timeoutMs=1500` 内未返回；网络/端点问题待观察，非插件崩溃）
- desktop `dependencies["dsh-commander"]="file:/Users/lzx/…/packages/dsh-commander"`、`bundles` 含 `dsh-commander`（count=42）

### 6.2 升级流程（**含新增源文件时必须重装**）

> **重要（M1 事故教训）**：安装是**快照式**（`dsh plugin add file:` / `plugin_manager install_bundle`）；hardlink 只覆盖安装时已存在的文件。**M1 新增的 `lib/host/dispatch/*.js` 等新文件不会自动进入已装副本** → 实际导致 live 无球 + `ERR_MODULE_NOT_FOUND`（详见 §7.9）。因此：

1. **build**：`cd /Users/lzx/Documents/GitHub/dsh-commander && pnpm --filter dsh-commander build`
2. **重装（含新增文件时必须）**：`plugin_manager remove_bundle` + `install_bundle file:/Users/lzx/Documents/GitHub/dsh-commander/packages/dsh-commander`（等价 CLI：`dsh plugin --profile desktop remove dsh-commander` + `add <绝对包路径>`）
3. **一致性预检**：`bash /Users/lzx/Documents/GitHub/dsh-commander/tools/dev/install-live-m0.sh`（新增 lib 文件集对比；repo/live 应同数、`comm` 差集为空）
4. **重启 DSH**（退出并重开 DeepSeek Harness；会**中断当前会话/agent**）：boot 期 manifest / systemPrompt / tools 注册以重启后为准
5. **验收**：`node tools/dev/verify-live-m0.mjs --url '<浏览器地址栏完整 URL（含 ?token=）>'`（有 token 时补页面 boot graph/client bundle 断言）；`/commander/state`（pendingDispatch/tasks）、`/commander/jev/test`、用户手测（M0-1 球/面板/设置四组；M1 确认卡派发由 tester 执行）

### M1 live 全链路验收 PASS（真实模型；Lead/用户执行 2026-11-18 00:04）

- 链路：真实模型 `board_query` → `task_create` → `dispatch_task` → **needs_confirmation**（确认卡截图 `tests/artifacts/m1/live/33-confirm-card.png`）→ 采纳建议 → **dispatched**，task **running**，`primarySessionId` 已建（成功截图 `34-dispatch-success.png`）。
- auto 策略派发：capability **applied**，`enabledCount:5`、`disabledCount:0`、`durationMs:982`；`session-capabilities.json` 已写新建会话（`39-session-capabilities-excerpt.json`：`sessionId=session-a9566b13-…`、`cwd=/Users/lzx/Documents/sunteng/Htdot-OrderCenter`、toolsCount=8、mcpCount=6、skillsCount=190、enabledSkills=[]；auto 交付截图 `35-auto-confirm-card.png`/`36-auto-success.png`）。
- final state（`tests/artifacts/m1/live/37-final-state.json`）：`rev:35`、`commanderStatus:"bound"`、`pendingDispatch:null`、counts=`{draft:1,running:2}`；running 任务 `task_mwkvrhkie0ad1a`（title「Htdot 导出按钮灰度开关（auto 能力验证）」、`workspaceId=8c9e4bc0…`、`primarySessionId=session-a9566b13-…`、`capability={status:"applied",enabledCount:5,durationMs:982}`）。
- final health（`38-final-health.json`）：`{"ok":true,"version":"0.1.0","panel":"present","binding":"bound"}`；`/commander/state` 200。
- devops 最终 `verify-live-m0.mjs` 复查（`node tools/dev/verify-live-m0.mjs --origin http://127.0.0.1:49921`）→ **exit 0（15 PASS + 1 SKIP：页面 boot graph 需 token URL）**；证据 `docs/validation/m1-artifacts/live-acceptance/{verify-live-final-stdout.txt,final-health.json,final-state.json}`。
- 其它证据：`tests/artifacts/m1/live/{30-message-send.json,31-state-poll.json,40-state-after-attempts.json,41-live-m1-attempts.md,task-task_*.json,walkthrough.md}`。

**live 重载方式（本轮实测，无需整机重启）**：`plugin_manager remove_bundle` + `install_bundle file:<repo>/packages/dsh-commander`，再 `set_plugin` 重载该插件；Host 侧新代码即生效（用户无需退出 DSH）。
**经验（重要）**：Host 变更（新增 lib 文件、或 `tsc` 重写导致 hardlink 断开）后，**单纯刷新页面/重启 Host 不够**，必须重装/重载安装副本——`dsh plugin add file:`/`install_bundle` 是安装时快照语义；tzc 以原子写替换文件会**断开 hardlink**，repo 与 live 副本不再同 inode，磁盘不会自动跟随。校验：`find <repo>/packages/dsh-commander/lib -name '*.js' | wc -l` 与 profile 副本一致、`comm` 差集为空、关键新文件存在（`tools/dev/install-live-m0.sh` 预检已内置）。

### 6.3 回滚

- 卸载：`dsh plugin --profile desktop remove dsh-commander`（或 `plugin_manager remove_bundle`）+ 重启 DSH；`commander` 存储域数据保留，重装可读回。
- 回旧构建：`git` 切回目标 commit → `pnpm --filter dsh-commander build` → **同样要重装**（若文件集与已装副本不同）→ 重启 DSH。
- 回滚验证：`/commander/health` 不可达（路由消失）；`dsh --profile desktop --dump-config | grep -c "name: 'dsh-commander'"` 为 0。

**仍需 Lead/用户执行**：① 浏览器刷新/重开页面（重启已完成）；② 浏览器手测与截图（M0-1 UI + M1 确认卡派发由 tester）；③ 提供含 token 的页面 URL 让 devops 补页面级断言。

## 7. 与 tester 对齐（避免重复造环境）

- 共享脚本：`tools/dev/check-m1-increment.sh`（隔离 boot + 路由 + introspect；`PROBE_ROOT`/`OUTDIR` 可覆盖）、`tools/dev/verify-live-m0.mjs`（live 安装后检查）、`tools/dev/check-m0-api.sh`（M0-2 全清单）、`tools/dev/spike/{m1-introspect,m0-workspace-fixture}.mjs`（只读探针 fixture）。
- fake Jev 建议配方（供 tester e2e）：起本地 stub HTTP 服务（`/v1/systemone` 返回 systemone JSON），在隔离 Host 里 `PUT /commander/config {"jev":{"endpoint":"http://127.0.0.1:<PORT>/v1/systemone"}}`，并把 `JEV_API_KEY`/配置的 `apiKeyEnv` 通过**探针 boot 环境**注入（探针 `COMMANDER_BOOT_LOG=warn JEV_API_KEY=stub-... dsh …`）；`POST /commander/jev/test` 可作为连通性自检。fake Jev 服务实现放 `tests/e2e` 或 `tools/dev` 均可，devops 侧只依赖 `/commander/jev/test` 与 dispatch 响应形状。
- 若 tester 的 m1 e2e 已有隔离 boot helper，优先复用其 fake Jev + 模型 stub；devops 脚本可继续作为**boot/路由面**的独立复跑。

## 7.9 事故记录：live 安装副本陈旧（M1 新文件未进 profile）与修复

- **现象**（Lead 定位，devops 记录）：重启后 live 无球；`plugin_manager list_plugins` 显示 `include:commander` `fiberPhase=null`；重新 enable 报：
  ```
  ERR_MODULE_NOT_FOUND .../profiles/desktop/node_modules/dsh-commander/lib/host/dispatch/capability.js
  ```
- **根因**：`dsh plugin add file:` / `plugin_manager install_bundle` 是**安装时快照式复制/hardlink**；M1 新增的 `lib/host/dispatch/capability.js` 等新文件不在已装副本里。**hardlink 只对安装时已存在的文件成立，新文件不会自动出现**；单纯重启/刷新不会同步。
- **修复**：`plugin_manager remove_bundle` + `install_bundle file:<repo>/packages/dsh-commander` → 重启 DSH。
- **修复后实测**（只读）：repo/live `lib/**/*.js` 均 **39** 个且 M1 新增文件（`dispatch/*.js`、`jev/client.js`、`tools/index.js`）在 live 侧全部存在；`/commander/health` 200 `{ok:true,version:"0.1.0",panel:"present",binding:"bound"}`；`/commander/state` 200；`verify-live-m0.mjs --origin http://127.0.0.1:<PORT>` → **exit 0（15 PASS + 1 SKIP 页面 token）**；`POST /commander/jev/test` → 200 `{hasApiKey:true, code:"timeout", latencyMs:1502}`（live Jev 1.5s 超时，待观察）。
- **升级规则（写入 M1 交接）**：任何**新增源文件/lib 模块**后，必须 `remove`+`add`（或 `remove_bundle`+`install_bundle`）→ 重启 DSH；`tools/dev/install-live-m0.sh` 预检已内置 lib 文件集一致性检查（repo vs live），缺文件会 FAIL 并提示重装。

## 7.10 事故闭环：live 无球（client `inject` 缺 `locale`）—— 根因/修复/验证/预防

- **现象**：Host 正常（`/commander/health` 200、panel present、binding bound）但页面无悬浮球；`plugin_manager` 侧 `include:commander fiberPhase=null`（历史上另有一次快照陈旧事故，见 §7.9，二者独立）。
- **根因**（architect 静态 + frontend 修复）：`src/client/index.tsx` 模块 `inject` 只有 `['slots']`，但 `apply` 读 `ctx.locale`；Cordis 严格代理对**未 inject 的服务属性读取直接 throw**（`cordis/src/reflect.ts:152`：`cannot get property "locale" without inject`）→ apply 中断、`ctx.slots.inject('shell.overlay')` 与 settings 注册均未执行 → 无球。jsdom/fake-loader harness 用的假 ctx 不抛，故本地测试不复现。
- **修复**（仅 client 源码 + 配置）：① 模块 `inject = ['slots','locale']`；② 槽位注册前移到所有可失败动作之前；③ locale 读取 try/catch 兜底；④ `apply` 外层 try/catch + 诊断日志（`[dsh-commander] client apply begin` / `slots registered` / `client apply ok` / `... failed`）；⑤ `package.json` 的 `dsh.client.inject` 加 `@deepseek-ai/dsh-client-locale`（配置由 devops 修改，装配顺序显式化）。
- **验证**：
  - 隔离无头 Chrome（devops，`tools/dev/client-repro.sh` + `cdp-probe.mjs`）：console 出现 `client apply begin / slots registered / client apply ok`，0 exception/0 console error，DOM `dshcNodes=2`/`ballNodes=4`，截图可见球（`docs/validation/m1-artifacts/client-load-repro.md` §2）；
  - **live PASS**：Lead 替用户硬刷新后，页面出现悬浮球与指挥官面板（截图 `docs/validation/m1-artifacts/client-repro/live-hardrefresh.png`）；live `/commander/health` 200 panel=present、state 200、`/commander/jev/test` 200 `ok:true`（model `jev-1.14.0`、latency 1351ms）。
- **预防（已落地）**：
  1. `apply` 成功/失败都有 `[dsh-commander]` 前缀 console 诊断（一眼区分“模块没加载”/“apply 抛错”）；
  2. frontend 的 harness 增加**严格 Cordis Proxy**（未注入属性读取即 throw）回归 + `exports.inject` 必须含 locale（38/38 smoke）；
  3. devops 新增 `tools/dev/client-repro.sh` + `tools/dev/cdp-probe.mjs`：一键隔离 web + 无头 Chrome 复现，抓 console/exception/网络/DOM/截图（macOS 需 `--no-sandbox --disable-dev-shm-usage --disable-breakpad --disable-crash-reporter`，否则 CDP `targetCrashed`）；
  4. 排查口径固定：先看页面 console `[dsh-commander]` 前缀 + `__DSH_BOOT__.entries` 的 inject 清单，再决定“硬刷新 / 重启 Host / 重装（仅新增 lib 文件时）”。
- **注意（不归因）**：live 浏览器 console 里大量 `WebSocket ... ws://127.0.0.1:9230/ingest failed` 与 `dsh-notify-me` 404 等，来自其它插件/工具的 inspector 通道，与 dsh-commander 无关。

## 7.11 M1 复跑：`board_query` model-visible 输出（先发现缺口，backend 修复后 PASS）

### 7.11.1 先发现的缺口（已修复）

- 背景：backend M1 live 修复要求「board_query 返回 workspaces 供指挥官取合法 id」。
- devops 用 stub 模型真实回合驱动 `board_query`（`tools/dev/check-m1-tools.sh` + `PROBE_M1_BOARD` 分支）时发现：工具可调用（tool/call+tool/result+turn/end 均出现），但**模型可见的 tool result blocks 只有 text** `"Board: 1 task(s), counts={\"draft\":1}"`；`workspaces[]` 只在 `execute()` 返回 value 里（`src/host/tools/index.ts` 的 render 只拼 Board 行）→ 模型拿不到 workspace id，live 上“先 board_query 再派发”可能仍 no_workspace。
- 该发现已报 backend（2026-11-17 23:5x）。

### 7.11.2 修复 + 复验 PASS（2026-11-17 23:55）

- backend 修复 `board_query.render` 为三行结构（Board / workspaces / tasks 紧凑 JSON，workspaces 含 id/name/allowed/policy/summary，tasks ≤30，summary/title 截断）；`dispatch_task.render` 同步补 decisionId/candidates 等；system prompt 同步“先 board_query”。
- devops 用**新 build + 新 home**重跑 `tools/dev/check-m1-tools.sh`（`/tmp/dsh-commander-m1-tools-b5`，启动时重建）→ **exit 0，全部断言 PASS**，其中新增 board_query 真实回合断言全部 PASS：
  - `board_query` model-visible 文本含 `workspaces:` / `tasks:` / `"id":` / `"allowed":true` / `"policy"`；
  - 含 fixture workspace 的合法 id（`d8b6900f…` 的前一轮为 `99c58f5e…`，随 fixture 随机 id 变化）；
  - 示例原文（`board-query-render-verified/board-result-extract.json`）：
    ```
    Board: 1 task(s), counts={"draft":1}
    workspaces: [{"id":"99c58f5e-…","name":"m0-probe-ws","allowed":true,"policy":"inherit","summary":"probe workspace summary"}]
    tasks: [{"id":"task_mwkvhwe1…","status":"draft","title":"probe-m1-tool-task","workspaceId":""}]
    ```
- `tools/dev/check-m1-increment.sh` 同轮新 build 复跑 → **exit 0**（boot 仅 ready 行、health/state/config/jev-test/tasks 404/binding/message/boot graph 全 PASS；旧 `tools.schemas()` 判定已改为 KNOWN-LIMITATION 记录，不再误判）。
- 脚本改动：`check-m1-tools.sh` 新增 workspace fixture（`m0-workspace-fixture`）+ `PUT /commander/workspaces`（allowed/summary/policy）+ 用 workspaceId 绑定，使 board_query 目录非空、可断言 id/allowed/policy。
- 证据：`docs/validation/m1-artifacts/board-query-render-verified/`（`board-result-extract.json`、`10b-events-board.json`、`09b-state-after-board.json`、`05c-put-workspaces.json`、`06-binding.json`、`commands.log`）；修复前证据保留在 `docs/validation/m1-artifacts/board-query-finding/`。
- 结论：**devops 隔离侧 PASS**；live 侧仍需 DSH 重启/插件重载后再由模型实测「board_query → dispatch_task(needs_confirmation) → 确认 → queued」全链路（tester/lead live 走查）。

## 8. 后续建议

1. ~~backend 修 F1/F2~~ → 已更正为观测口径问题；**tools 真实可执行已由 §5.1 证明**。M1 dispatch 全链路以 tester e2e 为准；`tools/dev/check-m1-tools.sh` 可作为无模型 key 时的工具可见性回归。
2. live 重启后：devops 跑 `verify-live-m0.mjs`（含 token URL 时补页面/client 断言），并把结果回填 `docs/validation/m0-live-install.md`。
