# V1 能力面板服务（capabilityPanel.jev.rank/apply 冷会话）

- **结论：PASS**（V1-C1 ∧ C2 ∧ C3 ∧ C4 ∧ C5 全部 PASS；证据见 §9，命令与退出码见 `commands.log`）
- 执行人 / 执行时间：devops（DSH Agent Team teammate）/ 2026-11-17 16:43–16:54（Asia/Shanghai）
- 环境：隔离探针 Host（`DSH_HOME=<repo>/.probe/home`、`DSH_AGENTS_HOME=<repo>/.probe/agents`、profile=`probe` = shipped `web` 模板 + 只读符号链接的 live `dsh-capability-settings`）；**未触碰 live Desktop、未写 `~/.dsh`**
- 协议依据：`/Users/lzx/Documents/GitHub/dsh-commander/docs/architecture/validation-protocol.md` §2；前置取证：`/Users/lzx/Documents/GitHub/dsh-commander/docs/research/validation-env.md`、`/Users/lzx/Documents/GitHub/dsh-commander/docs/research/capability-panel-api.md`

---

## 0. 一句话结论与门禁影响

在**与 live 完全隔离**的 web 形态探针 Host 里，`ctx.get('capabilityPanel')` 解析（工厂 thunk）可用、`jev.rank` 带真 key 正向返回、`jev.apply` 对**尚无 agent 的冷会话**入队（`pending:true`）、`sessionController.create({sessionId})` 建出同一 id 的 agent 后**排队计划被重放**（`pendingOutcome.applied:1`）、二次 rank 中计划内能力 `enabledInSession===true`、面板被禁用时探针仍启动并判定回退 `inherit`。**V1 五项判据全 PASS，不触发 NEXT-PHASE §7.1 停止条件。**

两点必须随结论一起读（不改变 PASS，但影响实现口径）：

1. **冷会话重放确实依赖 `create({sessionId})` 预留 id**：`sessionController.create` 会立即建出 agent（`agent/created` 在 create 返回前 15ms 触发），所以「apply 先于 agent」只能靠**先 apply 一个预留 sessionId、再用同一 id create**。这条路径已实测通过，实现可直接用。
2. **隔离探针环境里唯一的可开关能力来自 fixture skill**（见 §3.2）：探针 Host 的内建能力全部是 `host-injected`（`applicable:false`，只展示不可开关），真实 Desktop 的可开关能力来自用户安装的 skills/MCP。fixture 是**隔离 home 里真实注册的 skill**（不是 mock 数据），用于让 rank/apply 有可开关对象；判据结论不依赖它的业务语义。

---

## 1. 环境与版本

原始记录：`/Users/lzx/Documents/GitHub/dsh-commander/docs/validation/v1-artifacts/env-versions.txt`

| 项 | 值 | 采集方式 |
|---|---|---|
| dsh CLI | `0.2.2-rc.2` | `dsh --version` |
| live Desktop（仅版本核对，未运行/未重启） | `0.2.2-rc.3` | `plutil -extract CFBundleShortVersionString raw "/Applications/DeepSeek Harness.app/Contents/Info.plist"` |
| 探针 Host 运行时 node | `v24.19.0` | 探针 `/probe/v1/health` 的 `node` |
| 能力面板 | `dsh-capability-settings@1.19.3` | `/probe/v1/health` 读 profile 内包 `package.json`；符号链接 → `/Users/lzx/.dsh/profiles/desktop/node_modules/dsh-capability-settings`（只读） |
| 面板引擎约束 | `engines.dsh = ">=0.2.0-rc.2 <0.3.0"` | 同上 |
| 探针 profile | `<repo>/.probe/home/profiles/probe`（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + `dsh-capability-settings`） | `setup-probe-env.sh` |
| rank 服务端模型 | `jev-1.14.0`（配置 `model=jev-latest`，服务端回选） | rank 返回 |
| 面板 Jev 证据 | `hasApiKey:true, apiKeySource:"env", apiKeyEnv:"TYPESAFE_API_KEY", apiKeyLast4:"3fab", baseURL:"https://api.typesafe.ai", decisionThreshold:0.5, timeoutMs:30000` | `/probe/v1/config`（B1） |
| git rev | `d8d1543` | `git rev-parse --short HEAD` |

> key 来源：`/tmp/dsh-commander-probe/jev.env`（umask 600，仅 `TYPESAFE_API_KEY` 一行）。复跑脚本用 `set -a; . <file>; set +a` 注入**子进程继承环境**，全程未打印、未写入任何证据文件；证据里只出现 `panel.jev.getConfig()` 自带的 `apiKeyLast4` 与 `hasApiKey` 布尔。

---

## 2. 探针形态（P-A）与文件

**P-A：Host 探针插件**（协议 §1.3/§2.3 固定形态），`inject: []`——**不注入** `capabilityPanel`，否则面板缺失时探针不启动、看不到"缺失"这个事实（这一点与 task-3 表述的 `inject:["capabilityPanel"]` 不同，按冻结协议 §2.3 执行）。

| 文件（绝对路径） | 作用 |
|---|---|
| `/Users/lzx/Documents/GitHub/dsh-commander/tools/validation/probes/probe-v1.mjs` | 探针插件：订阅 `agent/created`/`session/event`，注册 `/probe/v1/*` 只读观测口；结束时 `ctx.get('appExit')(0)` 有序退出 |
| `/Users/lzx/Documents/GitHub/dsh-commander/tools/validation/probes/probe-v1.patch.yml` | 覆盖层：插入探针行（面板由 profile bundles 自带） |
| `/Users/lzx/Documents/GitHub/dsh-commander/tools/validation/probes/probe-v1-nopanel.patch.yml` | C5 覆盖层：`- id: capability-panel / disabled: true` + 插入探针 |
| `/Users/lzx/Documents/GitHub/dsh-commander/tools/validation/scripts/setup-probe-env.sh` | 建一次性 `$DSH_HOME`/`$DSH_AGENTS_HOME`、只读符号链接面板包、把面板加进 bundles、写 fixture skill |
| `/Users/lzx/Documents/GitHub/dsh-commander/tools/validation/scripts/run-v1.sh` | 一键驱动：启动隔离 Host → 逐条 curl → 落盘原始返回 → 退出码 → live 前后基线比对 |
| `/Users/lzx/Documents/GitHub/dsh-commander/tools/validation/scripts/live-state.sh` | live Desktop profile 树 hash / `.env` stat 前后快照 |

探针 HTTP 观测口（宿主 `webServer.register`，loopback）：

```
GET /probe/v1/health   服务形状：panelRawType/panelIsFactory/panelKeys/panelJevKeys/panelVersion/fallback/services/envBools
GET /probe/v1/config   panel.jev.getConfig()（无明文 key 视图）
GET /probe/v1/units    panel.tools.list + panel.skills.sessionListView 的可开关候选（含派生 capabilityId）
GET /probe/v1/rank     panel.jev.rank({sessionId,draft,cwd}) 原始返回 + applicableItems
GET /probe/v1/apply    panel.jev.apply({sessionId,plan,cwd}) 原始返回（含 pendingOutcome/failed）
GET /probe/v1/create   sessionController.create({sessionId?,cwd})
GET /probe/v1/prompt   sessionController.prompt({requestId,sessionId,mode:'queue',content})
GET /probe/v1/session  事件缓冲中该会话的事件摘要 + agents.list（判 live）
GET /probe/v1/state    该会话在 session-capabilities.json 的记录 + tools/skills 会话视图
GET /probe/v1/events   全量事件缓冲（agent/created、session/event 压平）
GET /probe/v1/quit     写 summary 证据后 appExit(0)
```

`capabilityId` 派生（确定性，用于在没有 rank 时从真实单元构造 plan，`P/lib/jev/rank.js:116-119`）：`cap_` + `sha256(namespaceKey)[:36]`，`namespaceKey`：skill=`skill:<name>`、tool=`tool:plugin:<unit>`、mcp=`mcp:server:<serverName>`。

---

## 3. 精确步骤与原始返回

完整命令 + HTTP 状态 + curl 退出码：`/Users/lzx/Documents/GitHub/dsh-commander/docs/validation/v1-artifacts/commands.log`。
所有 `/probe/v1/*` 请求均 `curl -sS -o <file> -w '%{http_code}'` → **http=200、curl_exit=0**；Host 退出码 0（A 阶段与 B 阶段各一次）。

### 3.0 启动（两条命令，均 exit 0）

```bash
export DSH_HOME=/Users/lzx/Documents/GitHub/dsh-commander/.probe/home
export DSH_AGENTS_HOME=/Users/lzx/Documents/GitHub/dsh-commander/.probe/agents
# 首次准备（幂等）
bash tools/validation/scripts/setup-probe-env.sh
# 一键执行：无面板阶段 → 冷会话阶段 → live 顺序阶段
bash tools/validation/scripts/run-v1.sh
```

启动日志（`boot-main.out`）：`dsh web: http://127.0.0.1:52169/?token=…`；`boot-main.err` **0 字节**（无 "entry did not activate" 告警；`dsh-client-ui-chat` 符号链接已在 setup 中建立）。

### 3.1 阶段 A：V1-C5 失败回退（面板行 `disabled: true`）

| 步骤 | 命令（节选） | 原始返回 |
|---|---|---|
| A1 | `GET /probe/v1/health` | `panelRawType:"undefined"`, `panelIsFactory:false`, `panelResolved:false`, `fallback:{"mode":"inherit","reason":"panel_unavailable"}`，其余服务仍为 object（探针正常启动）；**http=200, curl_exit=0** |
| A2 | `GET /probe/v1/rank?sessionId=session-c5-nopanel&draft=probe` | `{"ok":false,"reason":"panel_unavailable","fallback":{"mode":"inherit","reason":"panel_unavailable"}}` |

→ 探针**不因面板缺失而失败启动**；派发判定函数返回 `inherit` + `reason=panel_unavailable`（V1-C5 的"判定函数返回该值"口径）。

### 3.2 阶段 B：冷会话路径（rank → apply → create → 重放 → 二次 rank）

冷会话 id **预留**为 `session-v1cold-38b38f19-0cb4-424c-b9e4-59018826545f`（脚本 `uuidgen` 现生成；本文件写死本次运行值，复跑会生成新值）。

| # | 命令（`$BASE` 为本次 Host origin） | 原始返回（关键字段） |
|---|---|---|
| B0 | `GET $BASE/probe/v1/health` | `panelRawType:"function"`, `panelIsFactory:true`, `panelResolved:true`, `panelKeys:["jev","mcp","mcpTools","overrides","prompt","session","skills","tools"]`, `panelJevKeys:["apply","dispose","getConfig","rank","setConfig","test"]`, `panelVersion:"1.19.3"`, `services:{"sessionController":"object","agents":"object","workspaceRegistry":"object","storageDomain":"object","webServer":"object","skills":"object","tools":"object"}` |
| B1 | `GET /probe/v1/config` | `hasApiKey:true`, `apiKeySource:"env"`, `apiKeyLast4:"3fab"`, `decisionThreshold:0.5`, `model:"jev-latest"`, `baseURL:"https://api.typesafe.ai"` |
| B2 | `GET /probe/v1/rank?sessionId=session-v1cold-38b38f19-…&draft=需要单测和浏览器自动化&cwd=<repo>/.probe/ws-cold` | `ok:true`, `model:"jev-1.14.0"`, `usage:{input_tokens:4855,output_tokens:1248}`, `elapsedMs:1417`, `requestCount:1`, `capabilitiesTotal:8`, `items.length:8`；前 5 条见下 |
| B2b | `GET /probe/v1/units?sessionId=<cold>&cwd=…` | `unitCount:2`（均 host-injected，不可开关）、`skillCandidates` 含 `probe-e2e-testing`、`ui-ux-pro-max`；`skillsView.count:6` |
| B3 | `GET /probe/v1/apply?sessionId=<cold>&cwd=…&planIds=cap_7c67247df25ba4eb4630c351c7f2bc05696f` | `{ok:true,applied:0,enabled:0,disabled:0,skipped:[{"id":"cap_7c672…","reason":"already-applied"}],pending:true,elapsedMs:2}`，`liveBefore:false` |
| B4 | `GET /probe/v1/events`（create 前） | `count:0`，`agent/created` 计数 **0** |
| B5 | `GET /probe/v1/create?sessionId=<cold>&cwd=…` | `{sessionId:"session-v1cold-38b38f19-…",agentPreset:"standard"}`，`error:null`，`elapsedMs:28` |
| B6 | `GET /probe/v1/session?sessionId=<cold>`（create 后 2s） | `live:true`，`agentsList:["session-v1cold-38b38f19-…"]`，`agent/created@08:53:22.841Z`（`elapsedMs` 从探针加载算 2905），会话事件 = `permission/preset, sandbox/mode, approval/policy`（seq 0/1/2） |
| B7 | `GET /probe/v1/apply?sessionId=<cold>&planIds=<plan>`（重放后再 apply） | `{ok:true,applied:0,enabled:0,disabled:0,skipped:[{"id":"cap_7c672…","reason":"already-applied"},{"id":"cap_7505ed…","reason":"already-applied"}],pending:false,pendingOutcome:{"applied":1,"failed":0,"errors":[],"at":1794905603292}}` ← **排队计划已重放**（`applied:1` = 把未选中能力 `ui-ux-pro-max` 关闭） |
| B8 | `GET /probe/v1/rank?sessionId=<cold>&draft=同上` | `ok:true`；`probe-e2e-testing`：`applicable:true, score:0.99, enabledInSession:true`；`ui-ux-pro-max`：`applicable:true, enabledInSession:false` |
| B9 | `GET /probe/v1/state?sessionId=<cold>` | `session-capabilities.json` 记录：`{"updatedAt":…,"cwd":"<repo>/.probe/ws-cold","headerCreatedAt":…,"skills":{"ui-ux-pro-max":false}}` |
| B10 | `GET /probe/v1/prompt?sessionId=<cold>&text=准备中，确认可用能力。` | `accepted:{"accepted":true}`；回合事件 `turn/start(seq=4,turn=1) … turn/end(seq=18,turn=1)`，`reason.kind:"error"`，`error.code:"MISSING_CREDENTIAL"`（探针 home 无 provider 凭据；见 §6.3） |
| B11 | `GET /probe/v1/apply?sessionId=<cold>&planIds=`（空 plan=关闭全部可应用） | `{ok:true,applied:1,enabled:0,disabled:1,pending:false,skipped:[…already-applied],elapsedMs:8}` |
| B12 | `GET /probe/v1/rank?…` | `probe-e2e-testing.enabledInSession:false`、`ui-ux-pro-max.enabledInSession:false` |
| B13 | `GET /probe/v1/state?…` | `skills:{"ui-ux-pro-max":false,"probe-e2e-testing":false}` |
| B14 | `GET /probe/v1/apply?…&planIds=<plan>` | `{ok:true,applied:1,enabled:1,disabled:0,pending:false,elapsedMs:21}` |
| B15 | `GET /probe/v1/rank?…` | `probe-e2e-testing.enabledInSession:true` |
| B16 | `GET /probe/v1/state?…` | `skills:{"ui-ux-pro-max":false,"probe-e2e-testing":true}` |

B2 rank 原文（`/probe/v1/rank` 返回，保留结构与数值，略去每条 `description`）：

```json
{
  "ok": true, "sessionId": "session-v1cold-38b38f19-0cb4-424c-b9e4-59018826545f",
  "draft": "需要单测和浏览器自动化", "cwd": "<repo>/.probe/ws-cold", "elapsedMs": 1417,
  "result": {
    "ok": true, "model": "jev-1.14.0",
    "usage": { "input_tokens": 4855, "output_tokens": 1248 },
    "elapsedMs": 1417, "requestCount": 1, "capabilitiesTotal": 8,
    "items": [
      { "id": "cap_7c67247df25ba4eb4630c351c7f2bc05696f", "kind": "skill", "name": "probe-e2e-testing",
        "score": 0.99, "applicable": true, "enabledInSession": true, "source": "global" },
      { "id": "cap_…", "kind": "tool", "name": "dsh-tool-working-directory", "score": 0.49,
        "applicable": false, "reason": "host-injected", "enabledInSession": true },
      { "id": "cap_…", "kind": "tool", "name": "dsh-tool-agent-team", "score": 0.13,
        "applicable": false, "reason": "host-injected", "enabledInSession": true },
      { "id": "cap_…", "kind": "skill", "name": "office-docx", "score": 0.08,
        "applicable": false, "reason": "host-injected", "enabledInSession": true },
      { "id": "cap_…", "kind": "skill", "name": "office", "score": 0.07,
        "applicable": false, "reason": "host-injected", "enabledInSession": true }
    ]
  }
}
```

形状核对（脚本内以真实 JSON 复算，非人工抄写）：8/8 条 `id` 匹配 `/^cap_[0-9a-f]{36}$/`；`score ∈ [0,1]`；排序为 score 降序；`capabilitiesTotal(8) >= items.length(8)`。

**协议 §2.4 第 4 步的 plan 构造**（threshold 取面板 `getConfig().decisionThreshold = 0.5`）：

```json
{
  "label": "cold", "threshold": 0.5, "ok": true, "code": null,
  "itemsTotal": 8, "applicableTotal": 2, "selectedCount": 1,
  "applicableItems": [
    { "id": "cap_7c67247df25ba4eb4630c351c7f2bc05696f", "kind": "skill", "name": "probe-e2e-testing", "score": 0.99, "enabledInSession": true },
    { "id": "cap_7505ed85594e36b0588421697e66d0f35727", "kind": "skill", "name": "ui-ux-pro-max", "score": 0.07, "enabledInSession": true }
  ],
  "plan": [ { "id": "cap_7c67247df25ba4eb4630c351c7f2bc05696f", "kind": "skill", "name": "probe-e2e-testing", "score": 0.99, "enabled": true } ]
}
```

> `applicableTotal=2` 里的第二个是 live `~/.claude/skills` 下的 `ui-ux-pro-max`（只读兼容根，但会话开关可写），score 0.07 低于 0.5 未入 plan；按面板"筛选语义"，**未选中的可应用能力目标态 = false**，所以重放会把它关掉——这正是 B7 `pendingOutcome.applied:1` 与 B9 落盘 `{"ui-ux-pro-max":false}` 的来源。

### 3.3 阶段 C：协议字面顺序（create → rank → apply → prompt → 二次 rank）

| # | 命令（节选） | 原始返回（关键字段） |
|---|---|---|
| C1 | `GET /probe/v1/create?cwd=<repo>/.probe/ws-cold`（不传 sessionId） | `{sessionId:"session-3e6a1cb0-4abb-4c1f-9535-e47774b4dd1c",agentPreset:"standard"}`，`live`（B6 同法可判） |
| C2 | `GET /probe/v1/rank?sessionId=<live>&draft=需要单测和浏览器自动化&cwd=…` | `ok:true`, `items:8`, `capabilitiesTotal:8`, `model:"jev-1.14.0"`, `elapsedMs:453` |
| C3 | 同 §2.4 第 4 步构造 plan | `threshold:0.5, applicableTotal:2, selectedCount:1` → plan=`[{id:"cap_7c67247df25ba4eb4630c351c7f2bc05696f",…}]` |
| C4 | `GET /probe/v1/apply?sessionId=<live>&planIds=<plan>` | `{ok:true,applied:1,enabled:0,disabled:1,skipped:[{"id":"cap_7c672…","reason":"already-applied"}],pending:false,elapsedMs:6}`（live 路径；把未选中的 `ui-ux-pro-max` 关掉） |
| C5 | `GET /probe/v1/rank?…` | `probe-e2e-testing: applicable:true, enabledInSession:true, score:0.99`；`ui-ux-pro-max: enabledInSession:false` |
| C6 | `GET /probe/v1/state?…` | 该 live 会话 `session-capabilities.json` 记录 `skills:{"ui-ux-pro-max":false}` |
| C7 | `GET /probe/v1/prompt?sessionId=<live>&text=…` | `accepted:true`；`turn/end(seq=18,turn=1) reason.kind="error" / MISSING_CREDENTIAL`（同 §6.3） |
| C8 | `GET /probe/v1/session?…` | 事件序列完整：`turn/start → step/start → system/message → user/message×4 → request/header → request/context → session/title → session/title-llm-request → assistant/attempt → step/end → turn/end` |

> V1 的"能力在会话中生效"由 **二次 rank 的 `enabledInSession` + 面板自身落盘 `session-capabilities.json`** 证明（协议 §2.5/§2.6 C4 口径），**不依赖模型回合跑通**；模型回合属 V3（见 §6.3）。

### 3.4 live 隔离基线（前后一致）

`live-pre.txt` vs `live-post.txt`（`diff` 仅时间戳头不同）：`profiles/desktop` 树 hash、顶层 mtime hash、`~/.dsh/.env` stat（`858|1791515016`）、`node_modules` 顶层条目数（380）**全部一致**；未执行重启/关闭 Desktop、未写 `~/.dsh`。证据：`/Users/lzx/Documents/GitHub/dsh-commander/docs/validation/v1-artifacts/live-pre.txt`、`live-post.txt`。

---

## 4. 判据核对（二值）

| ID | 判据 | 实测值 | 结论 |
|---|---|---|---|
| **V1-C1** | 服务可解析 | `panelRawType="function"`（thunk；调用后对象键 8 个）；`panel.jev.rank/apply/getConfig` 均 `function`（`panelJevKeys=["apply","dispose","getConfig","rank","setConfig","test"]`） | **PASS** |
| **V1-C2** | 冷会话 rank 可用 | `ok:true`；`Array.isArray(items)=true`；`items.length=8>0`；`capabilitiesTotal=8>=8`；无 `bad-request`/`empty-capabilities`；`elapsedMs=1417<30000` | **PASS** |
| **V1-C3** | apply 成功 | (a) 冷会话：`pending:true, ok:true, applied:0`，`skipped` 仅 `already-applied`（合法 reason）；(b) live：`pending:false, applied:1, failed` 不存在 | **PASS** |
| **V1-C4** | 激活后生效 | apply(B3@08:53:22.809Z, pending) → `agent/created@08:53:22.841Z`（create 后同 tick 发出，晚于 apply）→ 重放 `pendingOutcome.applied:1` → 二次 rank(B8) 中 step-4 所选 id `cap_7c67247…`（probe-e2e-testing）`enabledInSession:true`，且 B11→B12 关闭后为 false、B14→B15 再启用后为 true（双向可观测） | **PASS** |
| **V1-C5** | 失败可回退 | 面板行 `disabled:true` 时探针仍启动（http 200），`panelRawType="undefined"`，判定函数 `{"mode":"inherit","reason":"panel_unavailable"}` | **PASS** |

**V1 总判据 = C1∧C2∧C3∧C4∧C5 = PASS。**

---

## 5. 冷会话 vs `agent/created` 时序（本次运行原始时间戳，UTC）

```
08:53:22.669Z  rank(cold, 无 agent)                 → ok:true items:8           （B2）
08:53:22.809Z  apply(cold, plan=[probe-e2e-testing]) → pending:true, applied:0    （B3，liveBefore:false）
08:53:22.809Z  （B4 事件缓冲：agent/created 计数 = 0）
08:53:22.841Z  agent/created(agentId=session-v1cold-…)                            （B6；36ms 后）
08:53:22.856Z  create 响应返回 {sessionId: 同一 id, agentPreset:"standard"}      （B5）
08:53:24.919Z  apply 再调 → skipped already-applied ×2 + pendingOutcome{applied:1}（B7；重放回执）
08:53:25.724Z  rank 二次 → probe-e2e-testing enabledInSession:true                （B8）
08:53:25.754Z  state → session-capabilities.json skills:{ui-ux-pro-max:false}     （B9）
```

要点：**`sessionController.create({cwd})` 不产生冷会话窗口**——它同步建 agent（`agent/created` 在 create 返回前 15ms 触发）。要验证"冷会话排队 → 重放"，必须用 **`create({sessionId})` 预留 id**：先 `apply({sessionId: 预留id})` 入队，再以同一 id create。此路径已实测可用（B5/B6/B7）。未采用协议 §2.4 的"备选 A/B"（先 prompt 极短回合 / 只在 created 后 rank+apply），因为主路径已可验且更贴近实现蓝图 §6 的 auto 顺序。

---

## 6. 与服务契约的差异与注意事项

1. **`ctx.get('capabilityPanel')` 是工厂 thunk**（本次再次确认）：必须 `raw()` 才拿到 service；兼容写法 `const panel = typeof raw === 'function' ? raw() : raw`。
2. **`apply` 的判据是 `failed`，不是 `ok`**：本次所有 apply 均无 `failed`；冷会话 `skipped[].reason` 只出现 `already-applied`（合法）。
3. **隔离探针环境无 provider 凭据**：`prompt` 被接受并开启回合，但 `turn/end.reason.kind="error"`、`error.code="MISSING_CREDENTIAL"`（`llm-deepseek: no API key for provider route "deepseek-official"`）。这**不影响 V1 判据**（C4 用 rank/落盘证据），但意味着 V3 的 prompt 正向用例必须解决模型凭据（见 V3 文档）。
4. **探针 profile 的能力面与真实 Desktop 不同**：隔离 home 下 `panel.tools.list` 只有 2 个 unit 且全部 `host-injected`（`applicable:false`），skills 里除 fixture 与 `~/.claude/skills` 的 `ui-ux-pro-max` 外全部 host-injected。因此 **plan 的可开关对象靠 fixture skill**（§3.2）；真实 Desktop 上可开关对象来自用户安装的 skills/MCP，语义相同。
5. **`decisionThreshold` 是客户端概念**：探针 home 无 `jev.json` → 面板默认 `0.5`（live 为 `0.7`）；rank 返回未按阈值过滤（8 条全返回），plan 的门控由调用方做——与 `capability-panel-api.md` §0.4 一致。
6. **`create({sessionId})` 是冷会话验证的关键能力**：`SessionCreateRequest.sessionId` 语义为"reusable 的空白会话 id，或未存储时的新会话 id"；实测未存储的 `session-<uuid>` 会直接以该 id 建 agent。实现可直接用它做"预留 id → apply → create"。
7. `getConfig()` 回的 `apiKeyLast4:"3fab"` 是面板自己的脱敏视图（不含 key 本体），证据里保留无风险。

---

## 7. 失败 → 停止条件映射

本次 **PASS，不触发停止条件**。若后续版本（面板升级/DSH 升级）出现下列现象，按映射处置：

| 现象 | 结论 | 映射 |
|---|---|---|
| `ctx.get('capabilityPanel')` undefined 或解析后无 `jev.rank/apply` | V1 FAIL | NEXT-PHASE §7.1：暂停 M1 auto，先做 inherit；auto 推迟 |
| 冷会话 rank `bad-request`/`empty-capabilities` 且备选均失败 | V1 FAIL | §7.1 |
| apply 永为 `pending:true`、created 后无重放、二次 rank `enabledInSession:false` | V1 FAIL（C4） | §7.1 |
| apply 写失败（`failed[]`/`errors[]` 非空） | V1 FAIL（C3） | §7.1 + 记录 inherit 兜底 |
| 仅 `no-config`/网络/鉴权 | **BLOCKED 非 FAIL** | 先修环境重测 |

面板版本漂移登记（协议 §12.1）：本证据写死 `dsh-capability-settings@1.19.3`；M0 安装前若版本变化，至少重跑 C1/C2/C3（`run-v1.sh` 一条命令）。

---

## 8. tester 独立复跑步骤（同环境、同命令、同输入）

> 第三方复跑：请用 `PROBE_ROOT=<tmp> bash tools/validation/scripts/setup-probe-env.sh` 建环境，并用 `OUTDIR=<tmp>/v1 bash tools/validation/scripts/run-v1.sh` 落盘；**默认路径会写 `docs/validation/v1-artifacts` 证据目录，请勿覆盖**。（M1/M2 已由 task-17 修复：setup 会幂等创建 `probe`(web) profile，run 脚本支持 OUTDIR 覆盖。）

前置：仓库 `/Users/lzx/Documents/GitHub/dsh-commander`、`dsh` 在 PATH、`/tmp/dsh-commander-probe/jev.env` 存在（600）。**不要 cat/grep key 文件。**

```bash
cd /Users/lzx/Documents/GitHub/dsh-commander
# 1) 干净重建一次性探针环境（幂等；只写 .probe/，.gitignore 已忽略）
rm -rf .probe
bash tools/validation/scripts/setup-probe-env.sh          # 退出码 0
# 2) 一键跑 V1（约 40s，含 6 次真实 rank 调用）
bash tools/validation/scripts/run-v1.sh                   # 退出码 0
# 3) 核对
cd docs/validation/v1-artifacts
cat commands.log | grep -c 'http=200'                     # 所有 curl 均 200
node -e 'const j=require("./B0-health.json"); console.log(j.panelRawType, j.panelVersion, JSON.stringify(j.fallback))'
node -e 'const j=require("./B3-apply-cold.json"); console.log(j.result.pending, j.result.ok)'     # true true
node -e 'const j=require("./B7-apply-replay.json"); console.log(JSON.stringify(j.result.pendingOutcome))'  # applied:1 failed:0
node -e 'const j=require("./B8-rank-after-replay.json"); const r=j.result.items.find(i=>i.name==="probe-e2e-testing"); console.log(r.enabledInSession)'  # true
node -e 'const j=require("./A1-c5-health.json"); console.log(j.panelRawType, JSON.stringify(j.fallback))'  # undefined {"mode":"inherit",...}
# 4) live 未被影响
diff <(grep -v '^#' live-pre.txt) <(grep -v '^#' live-post.txt) && echo "live-state identical"
```

复跑注意：脚本会重新生成 fixture skill（`<repo>/.probe/agents/skills/probe-e2e-testing/SKILL.md`）与冷会话 id；若 `JEV_ENV` 缺省，rank 会返回 `no-config`（此时 C2/C4 记 BLOCKED，不是 FAIL）。探针路由未加 host token 围栏，但只监听 loopback 且进程在脚本结束时经 `/probe/v1/quit` 退出。

---

## 9. 证据文件（绝对路径，均在 `/Users/lzx/Documents/GitHub/dsh-commander/docs/validation/v1-artifacts/`）

| 文件 | 内容 |
|---|---|
| `commands.log` | 全部 curl 命令原文 + http 状态 + curl_exit + 两次 Host 退出码 + live-state 结论 |
| `env-versions.txt` | CLI/Desktop/node/面板版本、engines、路径、git rev |
| `boot-main.out` / `boot-main.err` / `boot-nopanel.out` / `boot-nopanel.err` | 启动 URL 与 stderr（err 均 0 字节） |
| `A1-c5-health.json` / `A2-c5-rank.json` | C5：面板禁用后 health/rank |
| `B0-health.json` / `B1-config.json` | 服务形状、面板配置（无明文 key） |
| `B2-rank-cold.json` / `B2-plan.json` / `B2b-units-cold.json` | 冷会话 rank 原文、plan 构造、可开关候选 |
| `B3-apply-cold.json` / `B4-events-before-create.json` / `B5-create-cold.json` / `B6-session-after-create.json` | 冷 apply 入队、create 前无 agent、create、agent/created |
| `B7-apply-replay.json` | 重放回执 `pendingOutcome` + skipped |
| `B8-rank-after-replay.json` / `B9-state-cold.json` | 二次 rank `enabledInSession`、落盘记录 |
| `B10-prompt-cold.json` / `C7-prompt-live.json` | prompt 回合事件与 `MISSING_CREDENTIAL` 原文 |
| `B11..B16-*.json` | 关闭→rank→state→再启用→rank→state 的写方向证据 |
| `C1-create-minted.json` / `C2-rank-live.json` / `C3-plan.json` / `C4-apply-live.json` / `C5-rank-after-apply.json` / `C6-state-live.json` / `C8-session-live.json` | 协议字面顺序全链路 |
| `v1-probe-summary.json` | 探针进程内全量 log（含每步 `elapsedMs`）与事件缓冲（含原始时间戳） |
| `live-pre.txt` / `live-post.txt` / `live-state-diff.txt` | live Desktop 隔离基线前后一致 |

复跑脚本与探针源码在 `/Users/lzx/Documents/GitHub/dsh-commander/tools/validation/`（见 §2 表）。

---

## 10. 剩余风险 / 交接

1. **V3 前置**：prompt 正向用例需要模型凭据（本次 `MISSING_CREDENTIAL`）；V3 方案见 V3 文档（隔离 Home 无凭据时的选项）。
2. **真实 Desktop 能力面差异**：本验证用 fixture skill 提供可开关对象；真实 Desktop 上可开关对象更多（用户 skills/MCP），rank 的 `applicable/score` 分布会不同，但服务契约不变。
3. **面板版本漂移**：见 §7；升级后重跑 `run-v1.sh` 即可。
4. **独立审计**：本文件待 tester（task-6）独立复跑并追加审计签名；执行人未自审。
