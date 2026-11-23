# M0 契约复核（architect，独立只读）

> 版本：v1.0　日期：2026-11-17 21:12（Asia/Shanghai）
> 角色：architect（**只读实现与证据**；只写本文件；未跑 e2e、未改代码/配置/他人证据）。
> 复核对象：`packages/dsh-commander`（`src/host/**`、`src/client/**`、`lib/**`、`package.json`、`cordis.patch.yml`）、`docs/validation/m0-build-spike.md`、`m0-api-shapes.md`、`m0-accept.md`、`audit-m0.md`、`m0-artifacts*/`、`tests/e2e`/`tests/artifacts/m0`。
> 判据源：`implementation-plan.md` §11（M0-1..M0-4 + DoD）、§3/§4/§6/§8/§12；`m0-contract-patch.md` §1/§2/§3/§6（sha256 `4e8bfb93…`）。
> 说明：本复核不重跑 e2e（tester task-32 已复跑 18/18 PASS）；功能结果引用其证据，契约一致性由我逐文件只读核对。

---

## 0. 结论（先给裁定）

**M0 契约复核 = FAIL（3 项 HIGH 开放；M0-1 live 仍 UNVERIFIED）。**

| 维度 | 裁定 |
|---|---|
| 功能（隔离 e2e M0-2/3/4） | **PASS**（tester 复跑 18/18；我未重跑，引用证据） |
| M0-1 live 安装/球/视觉 | **UNVERIFIED**（live 未安装；client harness 26/26 + 24/24 仅装配/交互预检，不等于 live 视觉） |
| 契约一致性（本复核重点） | **FAIL**：3 项 HIGH（见 §2），其中 2 项会直接影响 M0-1/M1 行为 |
| 是否可进入 M0 整体验收 | **不可**：先修 HIGH + 完成 live M0-1 后再复核 |

**HIGH 3 项（owner）**：

1. **H1（backend）domain 未声明 `layout:'per-record'`** → `storageDomain.open` 按默认 `single` 打开，违反 `ARCHITECTURE §3.1`、`implementation-plan §4.1` 与 V4 已验证口径。
2. **H2（frontend）`shell.overlay` 条目缺少 `pointer-events:auto`** → 浮层默认 click-through，live 下球大概率点不到（jsdom harness 无法覆盖 hit-testing）。
3. **H3（frontend）存在未经评审的 Client Remote + polling 兼容通道**（Host 路由 404/405 时自动启用）→ 违背补丁 §1.2"唯一方案"与本轮冻结的"不做轮询"精神，且 `dsh.client.inject` 仍依赖 `@deepseek-ai/dsh-api-remotes`。

---

## 1. 逐项核对表（契约 → 实现 → 证据）

### 1.1 HTTP 路由（`implementation-plan §8.2` + 补丁 §2）

| 契约 | 实现 | 裁定 |
|---|---|---|
| `GET /commander/health` → `{ok,version,panel,binding}` | `handlers.handleHealth`；`binding` 额外支持 `'broken'`（契约只写 bound/unbound） | **PASS（含文档缺口 M1）** |
| `GET /commander/state`（JSON/SSE 升级） | `server.ts` 前缀路由 + Accept 判断 + `sse.attach` | **PASS** |
| `PUT /commander/config`（partial、严格拒绝未知段/字段、绑定字段拒绝、不含明文 key） | `validation.validateConfigPatch`（rejectUnknown 三层；`commander.sessionId/workspaceId` 拒绝；返回 `configView` 无 key） | **PASS** |
| `PUT /commander/workspaces`（整体替换、id 必须已注册、policy 两档、summary≤500） | `handlers.handleWorkspacesPut` + `workspaces.replaceAll` | **PASS** |
| `POST /commander/binding`（new/select、workspaceId|cwd 二选一、preset/session 校验） | `binding.bindNew/bindSelect`；H1（旧）已修为二选一（`m0-accept` M0-3 证据） | **PASS（功能）；见 §2 说明** |
| `POST /commander/message`（text≤8192、requestId、绑定校验、prompt queue、返回字段） | `handlers.handleMessagePost` + `deliver.deliverUserMessage`（`controllerRef.prompt(req, new AbortController().signal)`） | **PASS（含 H3/M-e 旁注）** |
| 404/405 语义 | 未知路径 404；已知路径错方法 405（code 用 `not_found`） | **PASS（低风险，见 L2）** |
| 写操作 `requestId` 5 分钟幂等 | `server.createIdempotencyCache`（TTL 300000ms；仅缓存 200；按 `METHOD path requestId` 键） | **PASS（并发同 requestId 见 L4）** |
| 额外路由 `GET /commander/config`（补丁未定义，Client 设置页探测用） | 已实现（只读、无 key） | **契约缺口 M2**（加法式，需补文档） |

### 1.2 SSE（`§8.4` + 补丁 §1.7）

| 契约 | 实现 | 裁定 |
|---|---|---|
| 首帧 `event: snapshot`、`id`=rev、15s heartbeat、unload `bye`、头（no-cache/no-transform 等） | `sse.attach/broadcast/dispose` 全部实现；heartbeat 常量 15_000；`bye` 在 dispose | **PASS** |
| rev 单调、客户端按 rev 丢弃乱序 | `sse` 每次 broadcast `rev+=1`；client `applyEvent` 用 frame `id` 丢弃 `rev < state.rev` | **PASS（首帧 id/data.rev 差 1，见 M-f）** |
| `commander.message`/`commander.status` 事件名与 payload | 见 §1.3 | **PASS** |
| 多连接/断开清理 | `clients` Set + `res.on('close'/'error')` | **PASS** |

### 1.3 消息通道（补丁 §1）

| 契约 | 实现 | 裁定 |
|---|---|---|
| `POST /commander/message` 校验顺序：参数→幂等→绑定→`prompt`→写环→SSE | `handleMessagePost` + `deliver`（幂等由 server 层统一；绑定/失败→`DeliverError`→ApiError） | **PASS（顺序见 M-e）** |
| user echo `messageId=requestId`、`order` 单调、`role/text/at` | `messages.push({messageId: requestId, role:'user', …})` | **PASS** |
| assistant 只发一条文本、去重 `asst_<turn>_<seq>`、空文本不发 | `commander-events.extractAssistantText` + `assistantMessageId` + `messages.push` 去重 | **PASS** |
| 8KB 截断 6144/2048 + `truncated/fullChars` | `messages.truncateMessageText`（Array.from 码点计数，契约一致） | **PASS** |
| 内存环 ≤500、快照 ≤200、order 升序、重启 best-effort 回填 | `MESSAGE_RING_MAX=500`/`MESSAGE_SNAPSHOT_MAX=200`；`backfillCommanderMessages`（user 只取 `source.kind==='user'`） | **PASS（回填 user messageId 语义见 L3）** |
| `commanderBusy`（turn/start→true、turn/end→false） | `commander-events` 维护；`snapshotOf` 注入 | **PASS** |
| 绑定/懒 resume 失败降级：仅"会话不可恢复"类错误 markBroken，参数/provider 错误保留 bound | `deliver.isSessionBrokenError` 正则 + `markBroken` 分支；H2 修复为保留 receiver/AbortSignal | **PASS** |
| **唯一通道（不得 Auto 回退 Remote）** | client `store.send` 在 404/405 时自动 `sendViaRemote` + `startPolling` | **FAIL（H3）** |

### 1.4 domain 7 表与 key（`§4` + ARCHITECTURE §3.2/§3.3）

| 契约 | 实现 | 裁定 |
|---|---|---|
| 域 `commander`、version=1、per-record、**恰好 7 表** | `domain.commanderDomainSpec`：name/version/tables 正确（config/workspaces/commands/tasks/dispatches/**board_edits**/sessions）；**未声明 `layout:'per-record'`** | **FAIL（H1）** |
| 表名匹配平台契约、`board_edits`（Lead 裁定）、接口仍 `BoardEditRecord` | `config.TABLE_NAMES`、`assertDomainSpec` 均符合；schema 类型名不变 | **PASS** |
| key 规范：`[a-zA-Z0-9_-]+`、`__` 复合、非法字符归一 + 碰撞后缀 | `store/base.sanitizeKey`（保留合法字符；替换则追加 `--`+sha1 前 8 位）；`sessionKey=<ws>__<session>`；config 用 `singleton` | **PASS** |
| 写入：单写者、单记录 update、version 乐观、timeline≤100 | store 层统一 `update`；未在本轮逐条核对（M1 用）；M0 只 config/sessions 写 | **PASS（M0 面无阻塞）** |

### 1.5 capabilityPanel 软依赖（`§6`）

| 契约 | 实现 | 裁定 |
|---|---|---|
| 不进 `inject`、启动不阻塞、`ctx.get` 每次重解析、兼容 thunk | `api/panel.resolvePanel`：`ctx.get('capabilityPanel')` → `typeof raw==='function' ? raw() : raw`；缺失/形状错/抛错三态；`index.inject` 不含面板 | **PASS** |
| 形状校验（`jev.rank/apply`） | M0 只校验 object + jev 可选；未校验 rank/apply | **PASS（M0）；M1 前必须加（M-g）** |

### 1.6 Client（槽位/令牌/指针事件）

| 契约 | 实现 | 裁定 |
|---|---|---|
| 只用 `shell.overlay`（list，additive）+ `settings.section`；不替换 single 槽位/根 | `client/index.tsx`：`ctx.slots.inject('shell.overlay')` id `commander.floating`、`settings.section` id `commander`；无 single 槽替换 | **PASS** |
| 只用设计令牌色（`--dsw-alias-*`），无字面色 | `styles.ts` 93 处 `var(--dsw-alias-*)`；`grep` 无 `#hex`/`rgb()` 字面色 | **PASS** |
| **条目必须 opt-in pointer events**（overlay 层 click-through） | `.dshc-ball`/`.dshc-root`/面板样式**均无 `pointer-events:auto`**；注释声称 opt-in 但无实现 | **FAIL（H2）** |
| SSE 客户端：snapshot/事件合并、rev 丢弃、消息去重/上限、重连拉快照 | `state.applySnapshot/applyEvent/mergeMessages`；上限 200；`frameRev` 用 `id` | **PASS** |
| 设置页 M0 四组 + 未知字段拒绝在 Host 侧 | `SettingsSection` 调 `PUT config/workspaces`；Host `rejectUnknown` 严格 | **PASS** |
| 不直连 `ctx.remote.session` | 存在兼容回退路径 | **FAIL（H3）** |

### 1.7 构建/打包（`§12` + 补丁）

| 契约 | 实现 | 裁定 |
|---|---|---|
| 双半 bundle：Host tsc → `lib/host/**`；Client tsdown → CJS → 包裹为 `window.__ModuleLoader__.load({id:"dsh-commander",factory:require=>…})` | `package.json build`：tsc + `tsdown && wrap-client.mjs dsh-commander lib/client.cjs lib/client.js`；实测 `lib/client.js` 头尾包裹正确、id 正确、`exports.apply/inject` 导出 | **PASS（L1 冗余重复 defineProperty）** |
| 零第三方运行时依赖（Host 不 import `@deepseek-ai/*`；Client 只 require react） | Host 静态 import 仅相对路径 + `node:crypto/module/url`；Client 产物只 `require("react")`（浏览器模块表提供） | **PASS** |
| `files`/`exports`/engines/locale/icon/DETAIL 齐 | package.json 字段齐；`locale/{en,zh}.json`、`icon.svg`、`docs/DETAIL.md` 存在 | **PASS** |
| `dsh.client.inject` 与合并后蓝图一致（不含 api-remotes） | 实现仍含 `@deepseek-ai/dsh-api-remotes`（因 H3 回退） | **FAIL 关联 H3（M3）** |

### 1.8 M0-1..M0-4 验收状态（引用 tester）

| 项 | 状态 | 依据 |
|---|---|---|
| M0-1 安装/球/面板 | **UNVERIFIED（live 待装）**；harness 预检 PASS（26/26 + 24/24）、build spike PASS | `m0-accept.md` §1；`m0-build-spike.md` |
| M0-2 消息通道 | **PASS**（隔离 e2e 18/18；H2 已修） | `audit-m0.md` §2；`tests/artifacts/m0/e2e/*` |
| M0-3 绑定持久化 | **PASS**（H1 已修；两分支 + 重启一致） | 同上 |
| M0-4 面板缺失降级 | **PASS**（panel:absent、不崩） | 同上 |
| DoD 单测/装配 | **PASS（隔离部分）**：unit+integration+client 61/61；e2e 18/18；client harness 26/26+24/24 | `audit-m0.md` §3；`m0-accept.md` |

---

## 2. HIGH 缺口（必须修，owner 明确）

### H1 · domain 未声明 `layout:'per-record'`（owner: backend）

- **事实**：`packages/dsh-commander/src/host/domain.ts:45-57` 的 `commanderDomainSpec` 只有 `name/version/tables`，无 `layout`；`TableValueMap`/注释写"per-record"，但实际未声明。`storageDomain` 文档：`layout` 缺省为 `'single'`。
- **影响**：域以 single 打开 → 与 `ARCHITECTURE §3.1`、`implementation-plan §4.1`、V4 已验证的 per-record 口径（每个 key 独立文档、per-record key 必须匹配 `[a-zA-Z0-9_-]+`、单条 version 检查）不一致；M1 的 key 规则与"单记录更新/版本"承诺在真实 Host 上不成立。
- **修法**：spec 增加 `layout: 'per-record'`（并让 `resolveCommanderDomainSpec` 通过 `defineDomain` 时保留该字段）；补一条单测断言 `spec.layout==='per-record'`；隔离 Host 重跑 M0-3 持久化 + V4 等价检查。
- **验收证据**：`domain-spec.json`（打印 layout）+ 重启持久 e2e PASS。

### H2 · shell.overlay 条目缺少 `pointer-events:auto`（owner: frontend）

- **事实**：`src/client/index.tsx` 正确注册 `shell.overlay`，但 `src/client/styles.ts` 的 `.dshc-root`/`.dshc-ball`/面板均为 `position:fixed` + 样式，**全文件无 `pointer-events`**；Overlay.tsx 也无内联 `pointerEvents`。`shell.overlay` 层本身 click-through（`docs/research/dsh-capabilities.md` §1.2/§7.2："条目必须自己 opt-in 指针事件，否则悬浮球点不到"）。
- **影响**：live 下球/面板可能不可点击（M0-1 直接 FAIL）；jsdom harness 用 `dispatchEvent` 点击，**不验证 hit-testing/命中测试**，不能覆盖此风险。
- **修法**：`.dshc-root { pointer-events: none }`（可选）+ `.dshc-ball, .dshc-panel { pointer-events: auto }`；或根节点内联 `pointerEvents:'auto'`。保持无全屏遮罩。
- **验收证据**：live M0-1 点击走查（真实浏览器命中测试）；或至少补一条 css 断言（`STYLES` 含 pointer-events:auto）。

### H3 · 未经评审的 Client Remote + polling 兼容通道（owner: frontend；需 lead 裁定保留与否）

- **事实**：`src/client/store.ts` `send()` 在 `POST /commander/message` 返回 404/405 时自动 `sendViaRemote()`（`remote.session.prompt`）并 `startPolling()`；`client/index.tsx` 注入 `getRemote`；`package.json dsh.client.inject` 仍含 `@deepseek-ai/dsh-api-remotes`。
- **契约冲突**：补丁 §1.2 明确"Host 路由为**唯一实现口径**；若未来改用 Client Remote 必须同时满足取回 assistant/绑定对齐/去重模型不变，否则视为破坏本契约，需重新评审，**不由 frontend 擅自切换**"；本轮还冻结了"不做轮询"的产品语义（客户端 polling 虽不等同 Host scheduler，但属未评审机制）。
- **影响**：版本偏斜或 Host 路由 404 时，面板会静默切到"Remote+轮询"通道——缺少 `commander.message/status` 的统一模型、无幂等 requestId、行为未验证；也与合并后的 `implementation-plan §2.1`（已移除 api-remotes）不一致。
- **修法（二选一，需 lead 裁定）**：**(a) 删除回退**（推荐，回到唯一通道；页面提示"Host 路由不可用，请升级/重启插件"）；**(b) 保留但显式化**：只在 `DSH_COMMANDER_ALLOW_LEGACY_REMOTE=1` 时启用、写入补丁 §1.2 作为"降级兼容"，并去掉 polling（改为提示刷新），同时更新 plan §2.1/§8 与 `dsh.client.inject` 说明。
- **验收证据**：删除则代码 grep 无 `remote.session.prompt`/`POLL_INTERVAL_MS` 使用；保留则补丁文档 + e2e 覆盖该 flag。

---

## 3. MEDIUM / LOW / 可后置项

| # | 级别 | 项 | owner | 处置 |
|---|---|---|---|---|
| M1 | MEDIUM | `health.binding` 额外返回 `'broken'`，契约只列 bound/unbound | architect（文档）/ backend | 在补丁 §1/§2 或 plan §8.2 补 `broken` 语义（面板红条） |
| M2 | MEDIUM | `GET /commander/config` 为契约外加法路由（Client 启动探测用） | architect（文档） | 补丁 §2 增加只读路由行（或在 plan §8.2 标注"加法式只读"） |
| M3 | MEDIUM | `dsh.client.inject` 含 `@deepseek-ai/dsh-api-remotes`，与合并后 plan §2.1 不一致（H3 依赖） | frontend | H3 处理时一并删除/注明 |
| M4 | MEDIUM | Host `inject` 仅 `storageDomain/webServer`（blueprint §3.1 列了 sessionController/tools/sessionProjections） | architect（文档） | 实现更稳健（软解析降级）；建议同步 plan §3.1（标注"M0 仅强依赖 storageDomain/webServer"） |
| M5 | MEDIUM | 用户 echo 写入在 `await prompt` 之后：assistant 事件若先到，`order` 会小于 user echo（面板按 order 排序可能出现"回复在提问前"） | backend | prompt 前先占 `order`/先 push（或 `prompt` 成功后补号但保留顺序字段） |
| M6 | MEDIUM | SSE 首帧：`attach` 先 `rev+=1` 再写 snapshot，但 snapshot 内 `rev` 是 attach 前构建的 → 帧 `id` = data.rev+1 | backend | `attach` 内先 `nextRev()` 再构建 snapshot（或帧 id 用 data.rev） |
| M7 | MEDIUM | `resolvePanel` 未校验 `jev.rank/apply`（M0 仅 health 可接受） | backend | M1 auto 前补形状校验（plan §6.1 要求） |
| L1 | LOW | `lib/client.js` 头部与 body 各 `defineProperty(Symbol.toStringTag)` 一次（重复、无害） | backend/frontend | 可选清理 wrap 模板 |
| L2 | LOW | 405 使用 code `not_found`（契约未列 405 code） | architect/backend | 文档补 405 语义或改 code |
| L3 | LOW | 重启回填的 user 消息 `messageId=user_<seq>` 与实时 `requestId` 不同（重启后去重边界） | backend | M1 前说明/统一（如用 `user_<seq>` 也接受） |
| L4 | LOW | 同 requestId **并发**重复请求：幂等缓存在完成后才写，in-flight 期间可能双 prompt | backend | 可加 in-flight Promise 缓存（M0 非阻塞） |
| L5 | LOW | `handleConfigPut` 中"显式拒绝 binding 字段"分支实际不可达（`rejectUnknown` 先生效） | backend | 清理或保留作防御，无害 |

---

## 4. 契约文档与实现的冲突（需 lead 裁定/文档更新）

| # | 冲突 | 建议 |
|---|---|---|
| C1 | 补丁 §1.2「唯一通道」 vs 实现 H3 自动回退 | 按 §2 H3 二选一裁定（推荐删除回退） |
| C2 | 补丁 §2 未列 `GET /commander/config`、未列 `health.binding:'broken'` | architect 在补丁/plan 增补（不改变实现行为） |
| C3 | plan §2.1 已去掉 `dsh-api-remotes` vs package.json 仍含 | 随 H3 一并解决；若保留兼容则恢复 plan 说明 |
| C4 | plan §3.1 inject 列表 vs 实现软依赖集合 | 更新 plan §3.1 为"M0 强依赖 storageDomain+webServer；其余软解析"（更符合 M0-4/降级目标） |

> 以上 C1–C4 不改变冻结决策/判据；C2/C3/C4 由 architect 在 lead 批准后落 `implementation-plan.md`/`m0-contract-patch.md`（本复核不改）。

---

## 5. 复核结论与下一步

1. **M0 契约复核 = FAIL**：H1/H2/H3 修完并验证前，M0 不应进入整体验收；M0-1 live 仍 UNVERIFIED。
2. **修复顺序建议**：H1（1 行 + 单测）→ H2（CSS + live/静态断言）→ H3（lead 裁定后 frontend 执行）→ M5/M6（小改）→ 文档同步 C2/C3/C4 → **tester 复跑 e2e 18/18 + architect 二次契约复核** → 用户执行 live 安装/重启 → 按 `m0-contract-patch §3.2/§3.3` 出 `m0-accept.md` live 部分。
3. **本复核不修改实现/证据**；引用证据均为只读：`docs/validation/{m0-build-spike,m0-api-shapes,m0-accept,audit-m0}.md`、`docs/validation/m0-artifacts*/`、`tests/artifacts/m0/**`。
4. 复核限制：未跑 e2e/live（tester/devops/用户负责）；H2 的 live 可点击性需真实浏览器命中测试确认；H3 若保留需重新评审。

---

## 6. 证据索引（本复核引用）

- 代码：`packages/dsh-commander/src/host/{index,domain,config}.ts`、`src/host/api/{server,sse,panel}.ts`、`src/host/api/routes/handlers.ts`、`src/host/api/validation.ts`、`src/host/session/{binding,deliver,messages,commander-events}.ts`、`src/client/{index,store,state,styles,Overlay,SettingsSection}.tsx|ts`、`src/host/store/base.ts`、`package.json`、`lib/client.js`、`lib/host/**`
- 构建/证据：`docs/validation/m0-build-spike.md`、`m0-api-shapes.md`、`m0-accept.md`、`audit-m0.md`、`m0-artifacts/`、`m0-artifacts-api/`、`m0-artifacts-real/`、`tests/artifacts/m0/e2e/**`、`tests/artifacts/m0/harness/run.log`
- 判据：`docs/architecture/implementation-plan.md` §11、`docs/architecture/m0-contract-patch.md`、`docs/ARCHITECTURE.md` §3.1/§3.2/§3.3

---

## 7. 二轮契约复核（H1/H2/H3/M5/M6/M7 + C2/C3/C4；2026-11-17 21:2x）

> 触发：Lead 已批准 H3=(a)/C2–C4 并让 backend/frontend/devops 修复；本轮为只读复核（读修复后代码 + tester 二轮证据，未改实现/证据）。
> 复核材料：`packages/dsh-commander/src/**`（修复后）、`package.json`、`docs/validation/audit-m0.md`（21:18 二轮，HIGH 0 / MEDIUM 4 / LOW 0）、`docs/validation/m0-api-shapes.md`（21:29）、`docs/validation/m0-live-install.md`（21:29，live 已装/健康检查）、`tests/artifacts/m0/**`。

### 7.1 修复验证

| 项 | 二轮判定 | 证据（只读） |
|---|---|---|
| **H1** domain per-record | **PASS** | `src/host/domain.ts:40` 类型与 `:50` `layout:'per-record'`；`:68` 断言 `spec.layout!=='per-record'` 即抛；`resolveCommanderDomainSpec` 走 `defineDomain`/local 两路径均保留；tester 二轮 `pnpm test` 67/67、隔离 e2e 20/20 PASS |
| **H2** overlay pointer-events | **PASS（静态契约）** | `src/client/styles.ts:11` `.dshc-root{pointer-events:none}`、`:17` 球、`:56` 面板、`:191` 设置页均 `pointer-events:auto`；**live hit-test 仍 UNVERIFIED**（页面未刷新出新 bundle + GUI 自动化被 sandbox 阻断，见 audit-m0 M4）——属环境阻断，不是契约缺陷 |
| **H3** 唯一 Host 消息通道 | **PASS** | `src/client/store.ts` 已删除 `sendViaRemote`/`remote.session.prompt`；404/405 返回 `route_missing` + 文案「Host/插件版本不匹配，请升级 dsh-commander 后重启 DSH」；`package.json dsh.client.inject` 已移除 `@deepseek-ai/dsh-api-remotes`；tester 复核 bundle 内 `session.prompt|getRemote`=0 |
| **H3 边界** SSE 降级只读轮询 | **PASS（已记录边界）** | client 保留 EventSource 不可用时的 3s **只读快照**轮询（`startPolling`/`POLL_INTERVAL_MS`），不发送消息、不替代 `POST /commander/message`；已写入 `m0-contract-patch.md` §7 C3 行（tester audit 亦认可该边界） |
| **M5** user echo order | **PASS** | `handlers.handleMessagePost` 先 `messages.reserve({messageId:requestId,...})` 占 order，`await deliver` 后广播；失败 `messages.remove(requestId)` 回滚（无幽灵消息） |
| **M6** SSE 首帧 rev | **PASS** | `sse.attach` 不再 `rev+=1`，帧 `id`=`snapshot.rev`（快照由调用方 attach 前构建）；后续事件 `rev+1` 起 |
| **M7** panel 形状校验 | **PASS** | `api/panel.ts` 要求 `jev.rank`/`jev.apply` 均为 function，否则 `panel_shape_mismatch`（thunk 兼容）；tester 补单测（object/thunk/缺 rank/非 function/抛错）与集成用例，67/67 PASS |
| **C2** GET config + health broken | **PASS（文档已同步）** | `implementation-plan §8.2` 已加 `GET /commander/config`（加法只读）与 `health.binding:'broken'`；`m0-contract-patch §7` 记录 |
| **C3** client inject | **PASS** | `implementation-plan §2.1` 与 `package.json` 均 = ui-layout + ui-settings（无 api-remotes）；`m0-contract-patch §7` 记录 |
| **C4** Host inject | **PASS** | `implementation-plan §3.1` = `['storageDomain','webServer']`（强依赖），其余软解析；`m0-contract-patch §7` 记录 |

### 7.2 二轮结论

- **契约复核 = PASS，HIGH = 0**（一轮 3 项 HIGH 全部关闭；M5/M6/M7 修复）。
- **剩余未闭合（不属契约缺陷）**：
  1. **M0-1 live UI UNVERIFIED**：插件已装、Host 健康 `panel:'present'`，但页面未刷新出新 client bundle（截图无球）+ GUI 自动化被 sandbox 拒绝 → 需**用户在无任务时 Cmd+R 刷新**后，按 `m0-contract-patch §3.2/§3.3` 做球/面板/点击/console 走查并补 `docs/validation/m0-accept.md` live 证据；这是 M0 整体 PASS 的最后一项。
  2. **环境 M4（tester 记录）**：live GUI 自动化不可用（agent-desktop `ps: Operation not permitted`、osascript -10004）→ 需用户配合或非沙箱终端；不是实现缺陷。
  3. **devops `check-m0-api.sh` MEDIUM（tester M1）**：脚本语法错误 + 覆盖缺口；独立 Live API 证据已由 tester live 路径补齐，可不 block M0（建议 devops 后置修）。
  4. M1/M2/M3/M4 文档/测试归档项：不 block M0（M1/M2/M3 已在 §3 归档，M4 为环境项）。
- **契约文档同步完成**：`implementation-plan.md`（M1 合并 + C2/C3/C4 + §7/§11 M1 范围修正）与 `m0-contract-patch.md §7` 已更新；补丁文档保留。

