# AGENTS.md

`dsh-commander`：DSH（DeepSeek Harness）里的「指挥官」插件。用户在指挥官会话里下指令，插件把任务派发到目标工作区/会话、维护任务看板，并在工作会话停止时把最后一条回复注入回指挥官。仓库是 pnpm workspace，实现只有 `packages/dsh-commander` 一个包。

插件是**双半 bundle**：Host 跑在 DSH 进程（`src/host`，tsc → `lib/host`），Client 注入 Web 壳（`src/client`，tsdown + 包裹 → `lib/client.js`）。两半独立构建、独立生效；动手前先判断改动落在哪一半。

## 先读

| 文件 | 触发条件 |
|---|---|
| `docs/HANDOVER.md` | 接手、排障、要动安装/部署前必读；§3 是核对过的命令，§5 是已知限制与真实事故，§8 是 live 现状 |
| `docs/architecture/implementation-plan.md` | 改接口、存储、路由、工具、派发前：唯一的实现契约（§8 HTTP+SSE、§9 派发门控、§10 工具、§13 测试分层） |
| `docs/NEXT-PHASE.md` §2 | 判断需求是否触碰已冻结的产品边界 |
| `packages/dsh-commander/src/host/index.ts` | 看 Host 装配顺序与硬/软依赖（组合根只装配，业务在模块） |
| `packages/dsh-commander/tests/client/harness/README.md` | 跑 client harness（react/react-dom/jsdom 的临时依赖装法） |

`README.md` 里的「未开始编码」已过期：M0–M3 已实现并验收，以 HANDOVER 为准。任务状态机/工具/看板以 `docs/architecture/task-state-machine-final.md` v1.0 为唯一契约。

## 工作循环

1. 定位改动属于 Host、Client 还是两者，读对应源码与契约章节。
2. 写代码与测试。每个修复/新行为都要有能在旧代码上失败的测试；需要假 ctx/服务时用 `packages/dsh-commander/tests/fakes/fakes.ts` 的契约型 fake（形状对齐真实 DSH，不 mock 语义）。
3. `pnpm --filter dsh-commander typecheck`，再 `pnpm --filter dsh-commander test`。
4. 按下表补验证（改动跨类时全跑）。
5. `pnpm --filter dsh-commander build`，然后向用户交代：改了什么、要不要重装/重启/硬刷新。安装与重启由用户执行。

完成标准：typecheck 与全量单测/集成测试全绿；按改动类型该跑的 harness 或 e2e 也全绿。

## 验证分层

| 改动 | 必跑 |
|---|---|
| Host 逻辑、存储、路由 | `pnpm --filter dsh-commander test` |
| Client UI、样式、i18n | 单测 + `pnpm --filter dsh-commander build:client` + `node packages/dsh-commander/tests/client/harness/run-harness.mjs` |
| 工具 schema/render、状态机/依赖/派发/attach、`turn/end` 注入 | 单测 + `build` + `node packages/dsh-commander/tests/e2e/m1-e2e.mjs`（按改动换成 `m1r-e2e.mjs` / `m23-e2e.mjs`；隔离 profile + stub 模型，只写 `tests/artifacts/`） |
| Client 加载失败、无球、白屏 | `bash tools/dev/client-repro.sh`（隔离 profile + 无头 Chrome；jsdom/harness 不复现 Cordis 严格代理错误） |
| 安装、升级后核对 | `bash tools/dev/install-live-m0.sh`（只读预检，不写 live） |

## 不可违反

- **Host 是唯一写者**。Client 只发命令；持久化一律经 `src/host/store/*` 写 `commander` 域（7 张表，per-record）。新增表、事件类型或确认路由前先改契约文档。
- **任务状态只有一个写入口**：所有状态写入必须经 `src/host/tasks/state-machine.ts` 的 `transitionTask`（迁移图 + actor 权限 + 守卫 + 副作用）；`commander_task_update` 只接受 action enum + 必填 `expectedRevision`，不接受裸 `status`；`done` 仅人 accept、`archived` 仅人 archive。
- **看板只做显示与命令**：六列（待派发/待运行/运行中/受阻/待验收/已验收），无通用状态拖拽；`PATCH /commander/board/tasks/:id` 仅 priority/title；accept/archive/restore/cancel 是人专用路由。依赖只提醒 commander，**不自动派发、不自动改依赖任务状态**。
- **面板消息只有 `POST /commander/message` 一条通道**。回复与状态由 Host 订阅会话事件后经 SSE 推回；SSE 断开时只允许 3 秒只读快照降级，Client 不直连 session prompt。
- **派发先确认，确认后才落地**。`commander_task_dispatch` 首次恒返回 `needs_confirmation`，用户确认后才创建/attach 会话；这是 V5 门禁未达标时的产品决策，不是可调参数，不要加自动派发捷径。
- **工具注册一次、按会话放行**。在插件 `apply` 里 `ctx.tools.register(definition, { when })`，`when` 只放行当前指挥官会话；`output.schema` 必须与真实返回值逐字段一致（`commander_task_dispatch` 用 `oneOf` 覆盖全部 variant），`output.render` 必填——缺一项会被 DSH 运行时拒绝。
- **Client 访问的服务必须写进 `inject`**。Cordis 严格代理会直接抛 `without inject`；晚激活的软依赖（`uiWorkspace`、`uiSession`）走 `src/client/lazy-services.ts`，不在 apply 时捕获。改 `inject` 或 `dsh.client` 字段属于 boot 变更，必须重装 + 重启。
- **两半都零运行时依赖**：Host 只 import `node:*` 与相对模块；Client 只用 Web 壳 seed（`react`、`react/jsx-runtime` 等，清单见 HANDOVER §5 的 seed 模块那条），其它依赖打进 bundle 会在浏览器缺模块。Client 产物必须由 `tsdown + tools/dev/wrap-client.mjs` 生成，`lib/` 不入库、不手改。
- **i18n 两份字典同改**：`src/client/locales.ts` 的 zh/en。新增 key 漏一份 `packages/dsh-commander/tests/client/locales.test.ts` 会挂，live 会直接显示 key。
- **live 属用户**：不重启 DSH、不写 `~/.dsh`、不在 live 上跑脚本；验证用一次性 `DSH_HOME`。改完先 `build`；只动已有 client 文件 → 用户硬刷新即可，Host 改动或新增 `lib/` 文件 → 必须重装 + 重启（安装是快照式的，只重启不生效）。

## 约定

- 提交信息与文档用中文（与现有提交一致）。
- 契约改动先改 `docs/architecture/**`，再改代码。
- 验收/审计结论写到 `docs/validation/**` 对应文档（带日期与证据），不改写既有结论；`docs/eval/frozen/**` 是冻结样本、`tests/artifacts/**` 由脚本生成，两者都不手改。
