# Client 半构建产物 harness（M0-1 / M0-2 证据）

对 `packages/dsh-commander/lib/client.js` 与 `lib/window.js`（devops 的 build 产物）做三层可复跑验证：

| 脚本 | 做什么 | 断言数 |
|---|---|---|
| `smoke.mjs` | 用假 `window.__ModuleLoader__` 加载官方 factory 包裹，校验产物 id/`exports.apply`/`exports.inject`、四个槽位注册（`shell.overlay`=commander.floating、`settings.section`=commander、`main`=commander-board、`sidebar.panellist`=commander-board「任务看板」入口，含 id 与 main key 一致性、order、label 与图标 SSR）、inject（含 locale/layout）、严格 Cordis 代理下 apply 不抛错、无 remote 直连回退、`[dispatch-confirm]` 模板、attach 会话路由、审批 status 接线、accept/continue 路由、pointer-events 规则、SSR 渲染球与设置页四组 | 52 |
| `bubble.mjs` | jsdom 加载真实 `lib/window.js`（`role=bubble`）+ 假 Host 数据面，驱动 `commander.status`：快照活动、SSE 活动替换、50 字符截成 40 + `...`、`null` 回退「正在思考」、turn/end 切成功文案 | 6 |
| `interact.mjs` | jsdom 挂载 overlay：球→点击开面板→输入→点击发送/Enter 发送（Shift+Enter 不发）→助手回复渲染→Escape 关闭→「看板」按钮 selectPanel(`commander-board`)；C 面板：状态条→指挥状态浮层（绑定/任务/连接）、待处理 FAB→底部抽屉、审批卡在抽屉而非 transcript、无 disabled「总是允许」、候选折叠 disclosure；M1 确认卡：新 decision 自动开面板+抽屉→采用建议/自定义/取消各发 `[dispatch-confirm]` 用户消息→pendingDispatch=null 收起+状态条更新→过期置灰；M1R attach：自定义→切「已有会话」→`GET /commander/sessions` 列表/选中/确认发出 `mode:attach;sessionId` 模板→路由缺失降级；M2 看板：六列/卡片/受阻/依赖与待确认 badge→抽屉（五段进度/依赖面板/六分区）→取消按钮（无状态拖拽/无 status PATCH）→回收站列表+恢复→返回对话；M3：审批卡渲染/允许 answer/answerable 守卫/角标、review 抽屉验收确认+返工批注、系统消息样式、**`reportSummary`「结论」卡（结论胶囊/4 行折叠/展开收起/中文字典/摘要只渲染一次）**；**方案 A 材料区（缩略图/链接/文档行/验收 chips/灯箱/文件动作单）**；ask_user_question 问答卡（渲染/选项选中/提交走官方 `PendingQuestion.answer`、请求结束后消失）；**生产 zh 字典渲染**（看板/抽屉 5 个 kv 值非空且本地化、无 `board./approval./system.` key 直出；C 抽屉本地化）、**依赖连线覆盖层（固定矩形驱动绘制：等待中琥珀箭头 / ready 绿色箭头）**；设置页：四组/autoDispatch 固定/`TYPESAFE_API_KEY`/测试连接/**绑定已有会话选择器（打开→加载→已绑定高亮→确认→POST binding body、空态/错误/重试/禁用、标题/未命名/短id/相对时间/水位/创建时间、错误码映射，incl. invalid_request 原文；会话列表 limit=20 与 truncated 提示）** | 197 |
| `run-harness.mjs` | 依次跑上面三个并汇总退出码 | — |

实测（2026-11-26，气泡活动 + 依赖连线箭头）：`52/52 checks passed`、`197/197 checks passed`、`6/6 checks passed`。

## 前置

1. 先构建产物（`lib/client.js` + `lib/window.js`，gitignored，由 build 流程维护）：

   ```bash
   pnpm --filter dsh-commander build
   ```

   `typecheck`/`node --test tests/client/*.test.ts` 不需要这一步。

2. Node ≥ 22。

3. harness 运行需要 `react`、`react-dom`（SSR 用 `react-dom/server`）与 `jsdom`。它们**不是**插件的 devDependencies：client bundle 保持零运行时依赖，运行时 React 由 DSH 浏览器模块表提供。两种提供方式：

   **A. 临时目录（推荐，不污染仓库/package.json）**

   ```bash
   mkdir -p /tmp/dshc-harness-modules
   npm install --prefix /tmp/dshc-harness-modules --no-audit --no-fund \
     --cache /tmp/dshc-npm-cache \
     --registry=https://mirrors.cloud.tencent.com/npm/ react@19 react-dom@19 jsdom

   DSH_COMMANDER_HARNESS_MODULES=/tmp/dshc-harness-modules/node_modules \
     node packages/dsh-commander/tests/client/harness/run-harness.mjs
   ```

   > 若本机 `~/.npm` 含 root-owned 文件导致 `npm` 报 `EPERM`（tester 复跑时遇到），加 `--cache /tmp/dshc-npm-cache` 即可绕过。

   **B. 若 devops 后续把 `react`/`react-dom`/`jsdom` 加入包 devDependencies**，直接：

   ```bash
   node packages/dsh-commander/tests/client/harness/run-harness.mjs
   ```

   也可只跑单个脚本：`node .../harness/smoke.mjs [lib/client.js 路径]`、`node .../harness/interact.mjs [lib/client.js 路径]`（默认 `../../../lib/client.js`）、`node .../harness/bubble.mjs`（固定 `lib/window.js`）。

## 输出摘要示例

```text
== smoke.mjs (client=…/lib/client.js)
PASS loader called
PASS module id — dsh-commander
… 
52/52 checks passed

== interact.mjs (client=…/lib/client.js)
PASS bundle registers module
PASS ball rendered
PASS click opens panel
PASS click send posts text — ["你好指挥官"]
PASS Enter sends message — ["你好指挥官","Enter 发送"]
PASS Escape closes panel
PASS settings renders four groups — 4
…
195/195 checks passed

== bubble.mjs
PASS bubble page loads and shows snapshot activity — 查看当前目录
…
6/6 checks passed

[harness] PASS (smoke + interact + bubble)
```

## 边界（写进验收证据时必须带）

- 这些 harness **不替代 live Desktop 走查**：jsdom 无真实布局/主题样式计算，仍需要 M0-1 的 live 截图、明暗主题与「无 slot entry crashed」的 console 证据。
- 它们**不在** `package.json` 的 `test` 脚本里：需要可选依赖与已构建产物，避免让 `pnpm --filter dsh-commander test` 依赖网络安装的 react。
- jsdom 环境有两个已知坑，脚本内已处理：`react-dom` 必须在 jsdom globals 之后加载（否则 input 事件走 legacy `attachEvent` 路径）；`attachEvent`/`detachEvent` 需 stub（React 19 legacy polyfill）。
- 假 store 只验证组件装配与交互，不验证 Host 语义；Host/SSE 契约由 backend 单测与 tester e2e 覆盖。
