# Client 半未加载/无球排查（静态审计）

> 版本：v1.0　日期：2026-11-17 23:20（Asia/Shanghai）
> 角色：architect（**只读**实现/现场插件/安装目录；只写本文件；未改实现/构建/他人证据）。时间盒 30 分钟。
> 现场事实（只读核对）：
> - Host 正常：`GET http://127.0.0.1:49921/commander/health` → `200 {"ok":true,"version":"0.1.0","panel":"present","binding":"bound"}`。
> - 插件已装：`~/.dsh/profiles/desktop/node_modules/dsh-commander`（**目录副本，非 symlink**；profile deps=`file:/…/packages/dsh-commander`，bundles 含 `dsh-commander`）。
> - Client 产物为最新构建：安装目录 `lib/client.js` sha256=`a5949864c978041c81dc99e0137877bad974046fb215589ccf36224796c3b9fe`**与工作区构建一致**（128777 B）；wrapper 头 `window.__ModuleLoader__.load({id:"dsh-commander",factory:require=>…})` 正确。
> - `package.json dsh.client`：`platform:"web"`、`immediately:true`、`inject:[ui-layout, ui-settings]`；`exports["./client"]` 存在。
> 结论：**bundle 已被安装到最新字节，但页面没有球** → 优先怀疑 **Client apply 在真实 ctx 上抛错（槽位注册代码未执行到）**，其次才是 Client 图未包含本插件。
>
> **修复验证（2026-11-17 23:2x）**：TOP1 已由 devops 在隔离 web Host + 无头 Chrome/CDP **正向验证**——修复后 console `[dsh-commander] client apply begin / slots registered / client apply ok`，0 exception / 0 console error，页面 DOM 有球（`dshcNodes=2`、`ballNodes=4`），截图见 `docs/validation/m1-artifacts/client-repro/screenshot.png`。详见 §8。

---

## 1. 结论（TOP3，按可能性排序）

| # | 候选原因 | 可能性 | 一句话 | 证据 |
|---|---|---|---|---|
| **TOP1** | **`ctx.locale` 未注入却被直接访问 → apply 抛 `cannot get property "locale" without inject`，槽位注册从未执行** | **高** | `inject=['slots']` 未含 `locale`，`readLocale()` 第一行直接读 `ctx.locale`（非 `ctx.get`），Cordis 代理对未注入服务**直接 throw**；失败点在两处 `ctx.slots.inject` 之前 | 本仓库 `src/client/index.tsx:20`（inject）、`:38`（readLocale 在注册前）、`:64-65`（`ctx.locale` 直接访问）、`:47/:54`（注册在其后）；Cordis 证据 `@deepseek-ai/cordis/lib/index.js:1257` `cannot get property "${prop}" without inject`；同现场可工作插件均把 `locale` 显式注入：`dsh-terminal-panel` runtime `inject=['slots','locale']`、`dsh-capability-settings` runtime `inject=[…,'locale',…]` |
| **TOP2** | **Client 图未包含 dsh-commander（或 factory 未执行）**：boot 图/loader 未把本包纳入，或页面仍用旧图 | 中 | Host 行已加载 ≠ Client 行一定被扫描；安装为目录副本+服务重启后页面若未拿到新 boot 图则无条目 | 现场可工作插件 `package.json dsh.client.inject` 均含 `@deepseek-ai/dsh-client-locale`（terminal-panel/capability-settings），我们只列 ui-layout/ui-settings；无法从无鉴权 curl 验证 boot 图（`/` 401、`/plugins/…` 404），需 DevTools/鉴权页确认（§3） |
| **TOP3** | **apply 其它早期抛错 / 组件渲染崩溃**：`store.start()`（EventSource/fetch）在 `ctx.effect` 内同步抛；`ctx.slots.register` options 形状；Overlay 渲染抛错（会显示 `slot entry crashed in 'shell.overlay'`） | 中低 | 若 slot 已注册但组件崩，渲染器会 `console.error("slot entry crashed in 'shell.overlay'")`；若 apply 抛错则连注册都没有 | 渲染器错误文案：`@deepseek-ai/dsh-client-ui-renderer/lib/client.js` `slot entry crashed in '${slotKey}'`；我们的 apply 先起 transport（`index.tsx:33`）再注册（`:47`）——transport 任何同步异常都会导致无注册 |

**首推修复（最小集）**：`src/client/index.tsx`
1. `export const inject = ['slots', 'locale']`（与 terminal-panel 一致；桌面 web 组合必有 locale）；
2. `package.json dsh.client.inject` 增加 `"@deepseek-ai/dsh-client-locale"`（对齐现场可工作插件；保证 factory 到达顺序）；
3. **调整 apply 顺序/容错**：先把两处 `ctx.slots.inject` 注册做完，再在 try/catch 内启动 transport 与 locale 注册；把 `readLocale` 改为只走 `ctx.get('locale')`（或注入成功后直接 `ctx.locale`），**任何 locale/transport 异常都不得阻断槽位注册**；
4. 给 apply 包一层诊断：`try { … } catch (e) { console.error('[commander] client apply failed', e) }`（保留 throw 与否由 lead 定；建议标记后 rethrow，至少让 console 明确出现 `[commander]`）。

> 依据：同现场插件 `dsh-terminal-panel` runtime `inject=['slots','locale']` + `dsh.client.inject=[ui-conversation, dsh-client-locale]` 可正常出浮层；`dsh-capability-settings` 也把 `locale` 列进 runtime inject，并在调用前用 `ctx.locale?.register`（注入后才安全）。我们未注入却直接访问，是唯一与「Host 正常、bundle 最新、无球」最吻合的路径。

---

## 2. 逐项对照（我们 vs 现场可工作插件）

| 项 | 我们 | 现场可工作（terminal-panel / capability-settings / better-sidebar） | 判定 |
|---|---|---|---|
| wrapper | `window.__ModuleLoader__.load({id:"dsh-commander",factory:require=>…})`，尾部 `exports.apply/inject` | 同形态（`window.__ModuleLoader__.load({id:…,factory})`） | ✅ 一致 |
| 模块 id | `dsh-commander`（=包名） | =各自包名 | ✅ |
| exports | `apply/inject` + 两个常量 | `apply/inject`（部分导出更多） | ✅ |
| runtime `inject` | **`['slots']`** | terminal-panel `['slots','locale']`；capability `['connection','slots','locale','workspaces']`；better-sidebar `['slots','sessions','locale','modules','connection','remote','remote.session']` | ⚠️ **缺 `locale`（TOP1 根因）** |
| 访问 locale | `ctx.locale` 直接读（未注入 → throw） | 注入后访问；capability 用 `ctx.locale?.register` | ❌ 不一致 |
| locale.register 签名 | `register(NS, DICTIONARIES)`，`DICTIONARIES={zh,en}` | capability：`ctx.locale.register(NS,{zh,en})`；真实类型 `register(ns, dicts|Record<BuiltInLocaleId,…>)` | ✅ 形状匹配（若 locale 已注入） |
| `ctx.effect` | `ctx.effect(fn, 'label')` 两处 | 现场插件同样 `ctx.effect(...)`（label 参数无害） | ✅ |
| `ctx.slots.inject` | `ctx.slots.inject('shell.overlay', ()=>ctx.slots.register(...))` | better-sidebar/capability 同形态（首参=槽名） | ✅ |
| `slots.register` options | `{name,id,order,inject}`（settings 多 `label`） | better-sidebar 同：`name,id,order,label?,inject` | ✅ |
| 组件 props | `inject: () => ({store, t})`，组件按注入面取 props | 同（inject 面） | ✅ |
| store/transport 起点 | apply 内 `ctx.effect(()=>{store.start(); return ()=>store.dispose()})`（**在注册之前**） | 现场插件 also start in apply，但注册不依赖 transport 成功 | ⚠️ 顺序风险（TOP3） |
| React | `import * as React` + `react/jsx-runtime`（外部 require） | 同（bundle 只 require react/react-jsx-runtime） | ✅ |
| 样式注入 | `STYLES` 字符串渲染在条目内（React 卸载即移除） | 同（installStyles→style 元素/或在组件内） | ✅ |
| `dsh.client` | `platform:web, immediately:true, inject:[ui-layout, ui-settings]` | terminal-panel `[ui-conversation, dsh-client-locale]`；capability 7 项含 locale；task-gantt `[]` | ⚠️ 缺 `dsh-client-locale` 包边（TOP2 辅助） |
| 包安装形态 | 目录副本（非 link）；安装目录 client.js sha **=最新构建** | 同（profile 内目录） | ✅ 排除"旧字节" |

---

## 3. 验证与取错步骤（无需改实现即可先做）

1. **打开 DevTools**：Web GUI（浏览器）用 `F12`；Desktop 若有「视图 → 切换开发者工具 / Cmd+Opt+I」则用之。Console 里按关键字过滤：
   - `cannot get property "locale" without inject` / `without inject` → **命中 TOP1**；
   - `slot entry crashed in 'shell.overlay'` → 命中 TOP3（组件渲染崩溃）；
   - `client-modules:` / `[commander]` / fiber error 对象 → 加载/激活阶段错误；
   - `404`/`401` 的 `/plugins/…dsh-commander/client.js` 请求 → 图未包含/路由鉴权（TOP2）。
2. **确认 boot 图是否包含本包**：Console 执行 `window.__DSH_BOOT__.entries.map(e=>e.id)`（或 `JSON.stringify(window.__DSH_BOOT__,null,1)`），查是否含 `"dsh-commander"`；Network 面板查 `client.js` bundle 是否 200 且尺寸≈128777B。
3. **确认 factory 是否执行**：Console 执行 `typeof window.__ModuleLoader__`；在 Sources 里给 `lib/client.js` 的 wrapper 行打断点（或加 `debugger`）看重载后是否命中；若命中但未注册，错误会出现在 Console/异常栈。
4. **服务端隔离验证（不需要 live 页面）**：用隔离 web profile 加载本包 + 最小 client harness（tester 的 client harness 已在 fake ctx 下 PASS，但 fake ctx **不会像真实 Cordis 那样对未注入服务抛错**——这正是本地 harness 漏掉 TOP1 的原因）。
5. **拿不到 Desktop DevTools 时**：让 frontend 临时加诊断（`console.error('[commander] client apply failed', e)` + 在 apply 首行 `console.info('[commander] client apply start')`），重装+刷新后看 Console；或将 GUI URL `http://127.0.0.1:49921` 在浏览器打开（需登录态）复现。
6. **客户端崩溃是否写日志**：DSH **不把 Client 运行时报错写入 Host 日志/文件**；渲染器仅 `console.error`（`slot entry crashed…`），模块加载器同理。因此排查必须靠 DevTools Console，Host 侧日志（`/commander/health` 正常）不能证明 Client apply 成功。

---

## 4. 修复建议（frontend 执行；不改契约）

按优先级：

1. **（必做）** `src/client/index.tsx`：`inject = ['slots','locale']`；或把 `readLocale` 改成只 `ctx.get('locale')`（try 内）且**不再直接访问 `ctx.locale`**。推荐两者都做：注入声明 + 软取兜底。
2. **（必做）** `package.json dsh.client.inject` 加 `"@deepseek-ai/dsh-client-locale"`（与现场插件一致）。
3. **（必做，防回归）** apply 顺序：先注册 `shell.overlay` / `settings.section`，再在 try/catch 中启动 transport 与 locale 注册；apply 整体 try/catch + `console.error('[commander] client apply failed', error)` 标记（不吞错）。
4. **（可选验证项）** 若 TOP2 仍成立：检查 boot 图/鉴权；必要时先临时去掉 `immediately` 验证是否与 prefetch 调度相关（不作为最终方案）。
5. **重装步骤**：`pnpm --filter dsh-commander build` → 重新 `plugin_manager install_bundle`/`dsh plugin --profile desktop add <路径>`（安装目录是**副本**，必须重装/重新复制 `lib/client.js`；仅 rebuild 不会更新已装副本）→ 页面硬刷新（Cmd+Shift+R）。注意：Host 侧已正常，重装后若仅替换 client 字节，仍建议重启 DSH 以刷新 Client 图（避免 HMR 缓存）。

**预期结果**：Console 无 `without inject` 错误，`window.__DSH_BOOT__.entries` 含 `dsh-commander`，右下出现 56px 球；若仍无球但 console 有 `slot entry crashed in 'shell.overlay'`，转查 Overlay 渲染期异常（store 初始 state/EventSource）。

---

## 5. 证据索引（只读）

- 我们实现：`packages/dsh-commander/src/client/index.tsx`（`:20` inject、`:33` transport effect、`:38-40` locale、`:47/:54` 槽位注册、`:64-65` ctx.locale 直接访问）；`src/client/locales.ts:310` DICTIONARIES；`lib/client.js`（wrapper/require）；`package.json`（`dsh.client`）。
- 现场插件：`~/.dsh/profiles/desktop/node_modules/dsh-terminal-panel/lib/client.js`（`const inject = ['slots','locale']`）；`dsh-terminal-panel/package.json`（dsh.client.inject 含 dsh-client-locale）；`dsh-capability-settings/lib/client.js`（inject 含 locale；`ctx.locale?.register(NS,{zh,en})`）。
- Cordis 行为：`@deepseek-ai/cordis/lib/index.js:1257`（`cannot get property "${prop}" without inject`）。
- 渲染器错误文案：`@deepseek-ai/dsh-client-ui-renderer/lib/client.js`（`slot entry crashed in '…'`）。
- 安装现场：`~/.dsh/profiles/desktop/node_modules/dsh-commander/`（目录副本、client.js sha=`a5949864…`）、`profiles/desktop/package.json`（dependencies/bundles）。
- 限制：无法在沙箱内打开 live 浏览器 Console/网络面板；`/`（401）与 `/plugins/*`（404，无鉴权）不足以判定图条目，需 DevTools 或用户配合只读采集（§3）。

---

## 6. `dsh.client.inject` 最小集分析（Lead 关注项；以现场可工作插件为准）

| 包 id | 是否在安装中 | 现场可工作插件是否用 | 我们需要吗 | 结论 |
|---|---|---|---|---|
| `@deepseek-ai/dsh-client-ui-layout` | ✅（CLI/Desktop 均有） | —（壳层包） | 我们的 `shell.overlay` owner | **保留**（当前已有） |
| `@deepseek-ai/dsh-client-ui-settings` | ✅ | — | 我们的 `settings.section` owner | **保留**（当前已有） |
| `@deepseek-ai/dsh-client-locale` | ✅ | terminal-panel、capability-settings、better-sidebar 均列 | **需要**：修复 TOP1 后 runtime `inject` 含 `locale`，建议同步加包边保证 factory 顺序 | **新增（首推）** |
| `@deepseek-ai/dsh-client-ui-slots` | ⚠️ **CLI 安装中未找到**（Desktop app.asar 内可能存在；better-sidebar 引用它且工作） | better-sidebar 用 | 不必须：runtime `inject:['slots']` 已由 Cordis 服务等待保证；terminal-panel 未列它也工作 | **暂不加**；若 DevTools 证明 slots 服务晚到导致挂起，再加并先验证该包在 Desktop 安装中存在 |
| `@deepseek-ai/dsh-api-remotes` | ✅ | capability-settings 用 | **不需要**（H3 已裁定 client 不直连 Remote） | **保持移除** |
| `@deepseek-ai/dsh-client-ui-conversation` / `ui-sidebar` / `ui-renderer` / `client-connection` 等 | ✅ | terminal-panel/capability 用 | 我们不用其服务/槽位 | 不加 |

**推荐最小集（修复后）**：`["@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-locale"]`，runtime `inject=["slots","locale"]`。

> 注意：`dsh.client.inject` 是**包级 factory 到达/组合顺序边**，不是服务依赖声明；服务依赖仍由 runtime `inject` + Cordis 等待保证。两边都要对齐（runtime 注入 `locale` + 包级加入 locale），否则 locale 访问仍会 throw。

---

## 7. 待验证（等 devops 无头 Chrome console 原文 / frontend 修复回执）

> **已闭环（2026-11-17 23:2x）：console 原文与修复验证见 §8；本节检查项均已在隔离无头环境核对，live 侧待用户硬刷新后补最后一步。**

检查清单（拿到 console 后逐项判定）：
- [ ] Console 错误是否含 `cannot get property "locale" without inject`（命中 TOP1 → 修复后应消失）
- [ ] 是否出现 `[commander] client apply failed`（修复新增标记；若有，看其 error 栈定位下一处异常）
- [ ] 是否含 `slot entry crashed in 'shell.overlay'`（TOP3：组件渲染期；需看 Overlay/store 初始 state）
- [ ] `window.__DSH_BOOT__.entries.map(e=>e.id)` 是否含 `dsh-commander`（TOP2：图条目）
- [ ] Network：`/plugins/…dsh-commander/client.js` 是否 200、大小≈128777B（旧图/旧字节）
- [ ] 修复后球是否出现（56px、右下 `br`）；面板 420×660 可打开；`GET /commander/health` 仍 200
- [ ] 修复是否只改 client（Host 无回归）；重装为副本后 lib/client.js sha 是否更新

完成后在本文追加：修复提交/构建 sha、console 前后对比、无头 Chrome 步骤与截图路径、最终结论（PASS/FAIL）。

---

## 8. 修复记录与验证证据（2026-11-17 23:2x，devops 无头复现；architect 只读核对）

### 8.1 修复内容（frontend/devops，已落盘）

| 项 | 修复前 | 修复后（已核） |
|---|---|---|
| runtime `inject` | `['slots']` | **`['slots','locale']`**（`src/client/index.tsx:25`） |
| `ctx.locale` 访问 | `readLocale` 第一行直接读、无注入 → Cordis throw | 注入 `locale` 后访问；`apply` 用 try/catch 包裹并打诊断标记 |
| apply 顺序 | transport/`locale.register` 在槽位注册之前 | **先注册 `shell.overlay`/`settings.section`，再启 transport/locale**（保证 locale/transport 失败不阻断球的注册） |
| `package.json dsh.client.inject` | `[ui-layout, ui-settings]` | **`[ui-layout, ui-settings, @deepseek-ai/dsh-client-locale]`**（与 terminal-panel/capability-settings 现场可工作插件一致；`ui-slots` 不需要、`api-remotes` 保持移除） |
| 诊断日志 | 无 | `[dsh-commander] client apply begin / slots registered / client apply ok`（console.info） |

### 8.2 验证证据（只读核对原始件）

- 环境：隔离 web Host（`DSH_HOME=/tmp/client-repro`，未碰 live）+ 无头 Chrome `Chrome/157.0.8103.79`（CDP，`--no-sandbox --disable-dev-shm-usage --disable-breakpad --disable-crash-reporter`）；复跑脚本 `tools/dev/client-repro.sh` + `tools/dev/cdp-probe.mjs`。
- 构建：`lib/client.js` = **131,141 B，sha256 `e82b4d16d9ff3856123f8625f278b39068957bc0c03f45b08d753b9e57180bf4`**；`verify-bundle` exit 0。
- Console（`docs/validation/m1-artifacts/client-repro/cdp-events.json`，原文）：
  ```
  [console:info] [dsh-commander] client apply begin
  [console:info] [dsh-commander] slots registered | Object
  [console:info] [dsh-commander] client apply ok | Object
  ```
  `exceptions=[]`、`consoleErrors=[]`、`logEntries=[]`（无 `without inject`、无 `slot entry crashed`）。
- Boot 图（`evaluate.json`）：`commanderEntries=[{id:"dsh-commander", inject:["@deepseek-ai/dsh-client-ui-layout","@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-locale"], immediately:true, rev:"3e0cdda78b09"}]`；`moduleLoaderPresent="object"`、`bootExists="object"`。
- DOM：`dshcNodes=2`、`ballNodes=4`；截图 `client-repro/screenshot.png`（1440×813，右下角可见 Commander 悬浮球）。
- 网络：commander 组合 bundle 200（129,770B）、`/commander/state` 200（JSON+SSE）、`/plugins/events` 200（SSE）。
- 复现文档：`docs/validation/m1-artifacts/client-load-repro.md`；证据目录 `docs/validation/m1-artifacts/client-repro/`。

### 8.3 关于"修复前无 headless 异常原文"

- devops 首次 CDP 在 macOS + 受限父进程下 renderer `Inspector.targetCrashed`（CDP 无响应），**与页面代码无关**；补 Chrome 参数后稳定抓取。
- 修复前根因由两条独立证据闭环：① 本审计静态判断（`inject` 缺 locale + 直接读 `ctx.locale`；Cordis `reflect.ts:152` 未注入属性读取即 throw；同现场可工作插件均显式注入 locale）；② 修复后 `client apply begin → slots registered → client apply ok` 且球节点出现（正向验证）。jsdom/fake-loader harness 此前 31/31 通过是因为假 ctx 不执行 Cordis 严格代理 → 已在本审计 §3 记录该盲区。

### 8.4 live 后续动作（不是契约问题）

- 隔离环境已 PASS；live 侧磁盘已是修复后 bundle（devops 记录：`lib/client.js` 与 repo 同一 inode/sha `e82b4d16…`、`package.json` hardlink 且 `dsh.client.inject` 已含 locale）。
- **用户操作**：先硬刷新页面（⌘⇧R）→ 预期 `[dsh-commander] client apply ok` + 右下角球。
- 若硬刷后仍无球：检查页面 `__DSH_BOOT__` 的 commander entry `inject` 是否仍为 2 项（旧 boot 图）→ 重启 DSH Host（`dsh.client.inject` 属 boot 期清单；client bundle 本身无需 remove/add）。
- 若重启后仍无球：按 §3 抓 live DevTools console（预期已无 `without inject`；若出现其它异常，按 §7 清单归因）。

## 9. 最终结论

**TOP1 已确认并修复**：client `apply` 因未注入 `ctx.locale` 直接访问而在槽位注册前抛错，导致无球。修复（inject 加 locale、槽位前移、try/catch + 诊断日志、`dsh.client.inject` 加 locale 包边）已在隔离无头 Chrome 环境正向验证 **PASS**（0 exception / 0 console error / 球节点存在）。本审计的 TOP2（client 图未包含）与 TOP3（transport/组件崩溃）未出现，作为后续回归检查项保留。

- 审计文档更新：本 §8/§9；证据均只读引用，未改实现/构建/他人证据。

