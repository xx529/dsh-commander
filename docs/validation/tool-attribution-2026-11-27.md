# 验收：指挥官工具归属被标成 `scope` 的修复

- 日期：2026-11-27
- 范围：模型工具的**注册路径**（不改 schema、不改 `when` 门禁、不改工具数），让插件面板（dsh-context 工具浏览器、capability-settings）把 10 个 `commander_*` 工具认出是本插件注册的。
- 现象：dsh-context 的 Context 面板「工具」列表里，10 个指挥官工具的来源标签显示 `scope`（红框 `commander_session_list`），而 `ask_user_question` 显示 `tool-ask-user`。
- 契约：`docs/architecture/implementation-plan.md` §3.2 `CordisContext` / `Tools` 两条。

## 根因（可复现）

1. `scope` 不是插件名，是 cordis 作用域 fiber 的名字：`@deepseek-ai/dsh-scope` 的 `createScope()` 用 `function scope() {}` 当空插件挂 fiber（`ctx.plugin(scope)`），所以每个 agent/工作区作用域的 `ctx.fiber.name === 'scope'`。
2. cordis 只在**属性访问服务**时发 `internal/get`（`reader`=访问方）；`ctx.get('tools')` 走直接解析，不发该事件，返回的也是未代理实例。
3. 生态面板的归属靠这个信号：dsh-context `src/host/attribution.ts` 里 `owner = receiverFiberNameOf(this) ?? lastReader`，`lastReader` 是**不按宏任务清理**的粘性变量。指挥官用 `deps.ctx.get('tools')` + `.register(...)` 注册时既没有 traced receiver，也没把自己的 fiber 写进 `lastReader`，于是继承了「最近一次读 `ctx.tools` 的 fiber」= 某个作用域 = `scope`。
4. 旁证：capability-settings 的运行时归属（优先 `internal/get`、兜底注册栈）同样认不出来，把指挥官工具归到了拦截器 `dsh-trace-inspect`（`~/.dsh/dsh-capability-settings/tool-attribution.json` 的 `runtime.commander_task_dispatch.package`），机制同源。

最小复现（cordis 4.1 + dsh-scope，`provide` 一个 tools 服务并套用上面的归属逻辑）：先让作用域读一次 `tools`，再分别注册——

| 注册写法 | 解析出的归属 |
|---|---|
| `ctx.get('tools').register(...)`（旧） | `scope` |
| `ctx.inject(['tools'], s => s.tools.register(...))`（新） | 插件 fiber 名（如 `commander`） |

## 改动

- `src/host/tools/index.ts`：
  - `install()` 保留 `ctx.get('tools')` 只做**探活**（无服务时照旧降级返回 `false`），注册改走 `ctx.inject(['tools'], scoped => scoped.tools...)` 的**属性访问器**，让 cordis 记下访问方身份；`tools` 已就绪时 cordis 同步回调，注册时点与旧路径一致，仍是全局层（插件 ctx 不是作用域）。
  - 仍保留两条兜底：插件自己声明过 `inject` 时直接属性访问；旧宿主无 `inject` 时退回裸实例注册（工具可用，只是归属信号缺失）。
  - 新增内部 `ToolServiceLike` / `probeToolsService` / `readToolsAccessor`。
- `tests/fakes/fakes.ts`：`createFakeCtx` 新增可选 `inject`（模拟 cordis 的 scoped ctx）。
- `tests/integration/m1-tools-scope.test.ts`：新增回归测试「注册经 inject 的 scoped tools 访问器」，断言 10 个工具全部注册在 inject 回调的访问器上、`ctx.get` 的裸实例零注册。
- `docs/architecture/implementation-plan.md` §3.2：把 `inject?` 补进 `CordisContext`，并写明 `Tools.register` 必须走属性访问器及原因。

## 验证结果（本机，隔离环境）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm --filter dsh-commander typecheck` | PASS |
| 单测/集成 | `pnpm --filter dsh-commander test` | **515/515 PASS** |
| 变异验证 | 临时把 `inject` 置空（退回旧路径）后单跑 `m1-tools-scope.test.ts` | 新测试 **FAIL**（`traced.registered=0`、`raw.registered=10`），还原后 PASS |
| 构建 | `pnpm --filter dsh-commander build` | PASS |
| Host e2e（M1） | `node packages/dsh-commander/tests/e2e/m1-e2e.mjs` | **54/54 PASS**，0 FAIL，3 INFO |
| Host e2e（M1R attach） | `node packages/dsh-commander/tests/e2e/m1r-e2e.mjs` | **33/33 PASS**，0 FAIL，1 INFO |

未做：live 环境走查（安装/重启由用户执行；未写 `~/.dsh`）。

## 部署与可见结果

Host 改动（无新增 `lib/` 文件）：`pnpm --filter dsh-commander build` 后需用户**重装 + 重启 DSH**；Client 未改，无需硬刷新。

重启后 dsh-context 工具浏览器的标签会是插件 fiber 名 `commander`（与 `tool-ask-user` 同款：标签取插件的 `name` 导出，不是包名 `dsh-commander`）。若希望标签就是 `dsh-commander`，把 `src/host/index.ts` 的 `export const name = 'commander'` 改成 `'dsh-commander'`（cordis 的 fiber 名直接取该导出；patch 里的 `id: commander` 不受影响）。
