# 换代时定时任务跟随迁移 · 方案设计

> 日期：**2026-11-27（Asia/Shanghai）**　状态：**已实现（v1.0，方案 A）· 待用户验收**
> 范围：指挥官换代 / 手动绑定切换会话时，把 DSH 原生 `schedule` 中 target 指向旧指挥官会话的任务，改写到新指挥官会话。
> 本轮：**只出方案，不写实现代码、不改配置、不新建/编辑/删除真实定时任务、不重启 DSH**。
> 依据：第 1 轮源码核对结论（`docs/architecture/rotation-contract-patch.md`、`dsh-schedule` / `dsh-tool-schedule` 源码）；本轮新增核对 `@deepseek-ai/dsh-schedule@0.2.2-rc.3`（当前安装）与 `0.2.2-rc.2`（全局安装）的公开服务面。
>
> 路径约定：
> - `$REPO` = `/Users/lzx/Documents/GitHub/dsh-commander`
> - `$DSH` = `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh`
> - `$DSH_GLOBAL` = `~/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh`
>
> 文中 `path:line` 均为只读核对；`$DSH` 内文件只能用 read 工具读取（bash/grep 无法直接读 `app.asar`），`$DSH_GLOBAL` 用于全包范围 grep 与 rc.2 对照。

---

## 0.0 实现状态（2026-11-27）

**状态：已实现（方案 A，v1），待用户验收。**

落地勾选：

- [x] 新增 `$REPO/packages/dsh-commander/src/host/schedule/migration.ts`：`catalog()` 全量枚举、target 精确匹配、`edit()` + `expectedUpdatedAt` CAS、scope/并发守卫、幂等、3s 总超时、debug 跳过日志、失败汇总。
- [x] `$REPO/packages/dsh-commander/src/host/rotation/service.ts`：`commitRotation()` 之后执行迁移；`RotationResult.scheduleMigration`；`rotation.updated` 携带结果。
- [x] `$REPO/packages/dsh-commander/src/host/api/routes/handlers.ts`：`bindNew` / `bindSelect` 复用同一迁移函数；`POST /commander/rotation` 与 `POST /commander/binding` 响应携带结果。
- [x] `$REPO/packages/dsh-commander/src/host/api/server.ts`、`src/host/index.ts`：ApiDeps 与组合根接线。
- [x] `$REPO/packages/dsh-commander/src/host/dsh-types.ts`：`ScheduleServiceLike` / `ScheduleEntryLike` / `ScheduleEditRequestLike` 结构化最小面（不 import DSH 包）。
- [x] 客户端：`types.ts` 增加 `ScheduleMigrationView`；`store.ts` 对 `rotation.updated` / `binding.updated` 的失败计数发 warn；`SettingsSection.tsx` 手动换任结果行显示迁移计数；`locales.ts` zh/en；`styles.ts` / `window-styles.ts` warn 样式。
- [x] 测试：`tests/unit/schedule-migration.test.ts`（15 条）+ `tests/integration/rotation.test.ts` 新增 6 条（手动换代、turn/end、投递前兜底、bindNew、bindSelect、失败不阻断）。
- [x] 仓库检查：`typecheck` PASS、全量 `test` 514/514 PASS、`build` PASS。
- [ ] 隔离 profile 手动验收（需要真实 DSH schedule 服务；本轮未跑，以避免碰 live）。
- [ ] 真实 DSH 上的 `ctx.get('schedule')` 调用与 `[SCHEDULE CHANGE]` 通知观察（见 §10 U1/U2/U5）。

> 说明：本文件 §8.1 的表格仍是「方案期」的文件级计划；上面的勾选是本轮实际的落地状态。§8.4 的 A12（隔离 profile 手动验收）尚未执行。

---

## 0. 一页结论

**推荐方案 A：在换代/绑定提交完成之后，直接调用 DSH 公开的 Host 服务 `ctx.schedule.catalog()` + `ctx.schedule.edit({ patch: { target: { kind:'session', sessionId: 新会话 } } })`，把 target 精确等于旧指挥官会话的任务逐个重指；不新增表、不新增调度器、不删除/重建任务。**

一句话语义：

> **当指挥官绑定从会话 A 切到 B 时，把所有 `target.kind === 'session' && target.sessionId === A` 的 schedule 的 target 原子改写为 B；任务 id、标题、prompt、规则、状态、投递历史保持不变。**

关键结论：

1. **可行**：`schedule` 是 DSH 的公开 Cordis 服务（`ctx.schedule`），`catalog()` 返回全部任务，`edit()` 接受 `{kind:'session', sessionId}` 目标与 `expectedUpdatedAt` CAS。来源：`$DSH/node_modules/@deepseek-ai/dsh-schedule/src/index.ts:247-248、440-443、555-592`；`.../types.ts:531-578`。
2. **不需要 model tool 的 target 枚举**：`schedule_create/schedule_edit` 只暴露 `this_session|new_once|new`（`$DSH/node_modules/@deepseek-ai/dsh-tool-schedule/src/index.ts:329-330、382、448-450`），但 Host 服务的 `ScheduleTargetRequest` 支持显式 `sessionId`；插件直接调服务即可。
3. **不改 DSH**：只走公开服务面；不改 `dsh-schedule` 源码，不依赖内部文件格式。
4. **无 provenance**：schedule 记录没有「创建者」字段，`involvedSessionIds` 只表示参与变更的会话，不能可靠区分「本插件创建」与「用户手动创建」。因此推荐**按 target 精确匹配迁移**，而不是按创建者过滤（见 §2.3、§9-D1）。
5. **失败不阻断换代**：迁移发生在 `commitRotation()` 之后，属于 post-commit 补偿；失败只告警，不把已经成功的换代回滚（见 §4）。
6. **仍有小竞态**：提交完成到迁移完成之间，旧任务仍可能投给旧会话；窗口通常为毫秒级，但任务很多时会放大。方案不引入「先暂停再迁移」的两阶段写（理由见 §5）。

---

## 1. 现状与缺口（承接第 1 轮）

- 换代触发：指挥官 `turn/end`、`POST /commander/message` 投递前、手动 `POST /commander/rotation`；到点判定是自然日懒检查，不跑定时器。`$REPO/packages/dsh-commander/src/host/rotation/service.ts:402-443`、`.../rotation/config.ts:60-65`、`.../api/routes/handlers.ts:505-512、609-616`。
- 新会话：`sessionController.create()` 生成新 id；旧会话只在插件自己的 `sessions` 表标 `retired`，不 archive、不删除。`$REPO/packages/dsh-commander/src/host/rotation/service.ts:305-312、365-373`；`.../session/binding.ts:351-387`。
- 定时任务：插件全仓无 `ctx.schedule` 调用；用 `this_session` 创建的提醒在创建时就被解析成固定 `sessionId`。`$DSH/node_modules/@deepseek-ai/dsh-tool-schedule/src/index.ts:329-330`；`.../dsh-schedule/src/types.ts:353-361`。
- 旧会话归档时，宿主会删除指向它的 active 定时任务，而不是迁移：`$DSH/node_modules/@deepseek-ai/dsh-schedule/src/index.ts:334-336、754-762`；`.../dsh-workspace/src/index.ts:381-401、503-506`。

缺口：换代后，旧任务仍然指向旧会话；用户必须手动重建或改 target。本方案补上这个缺口。

---

## 2. 目标与非目标

### 2.1 目标（准确定义）

**自动迁移**指：

> 在指挥官绑定从 A 切到 B 的**提交完成之后**，把 DSH 原生 schedule 中 `target.kind === 'session' && target.sessionId === A` 的任务，通过 `ctx.schedule.edit()` 把 target 原子改写为 `{ kind:'session', sessionId: B }`；不改变任务的其它字段与状态。

覆盖的触发路径（推荐，见 §9-D3）：

1. 自动换代（`rotation.rotate()`，含 turn/end、投递前兜底、手动立即换任）。
2. 手动「绑定到新会话」（`bindNew`）。
3. 手动「选择已有会话」（`bindSelect`）——**建议覆盖**，否则换回/换到任意会话后 target 仍指向前一任。

### 2.2 唯一匹配谓词

```text
migrate(task) :=
  task.target.kind === 'session'
  && task.target.sessionId === fromSessionId
```

只按 **target** 匹配，不按 `involvedSessionIds` 匹配。原因：`involved()` 会把「创建者/编辑者会话」和「目标会话」都放进 `involvedSessionIds`（`$DSH/node_modules/@deepseek-ai/dsh-schedule/src/index.ts:175-188`），用它匹配会误伤 `new_once` 任务（其目标是自己预留的新会话，不是指挥官）。

### 2.3 三类 target 分别怎么算

| target 类型 | 存储形态 | 是否迁移 | 理由 |
|---|---|---|---|
| `this_session`（创建时） | 落盘为 `{kind:'session', sessionId: 创建时会话}` | **是**，仅当该 id = 旧指挥官 | 这是最常见、也是本需求的目标 |
| `new_once` | `{kind:'new_once', sessionId: 预留新会话, create}`；首次投递后变 `{kind:'session', sessionId: 该新会话}` | **否** | 它的目标从一开始就是自己的新会话，不是指挥官；`involvedSessionIds` 里即使出现指挥官也不代表 target |
| `new` | `{kind:'new', create}`，无 sessionId | **否** | 每次投递新建会话，与指挥官绑定无关 |

### 2.4 显式「不迁移」清单

- `target.kind === 'new'`。
- `target.kind === 'new_once'`（含首次投递后转成的自有 `session`）。
- `target.kind === 'session'` 但 `sessionId !== 旧指挥官`（工作会话、其它指挥官、任意普通会话）。
- 在 `catalog()` 快照之前已被宿主删除的任务（例如旧会话已归档且宿主执行了 `stopSessionTasks`）。
- 在迁移快照之后才创建、且 target 仍指向旧会话的任务（并发创建；本轮不追补，见 §6.5）。
- `schedule` 服务不可用（未安装/未启用/未就绪）。
- 未来若增加 kill switch，开关关闭时的全部任务。
- 非 schedule 的计时器（插件自己的 SSE 心跳、看板合并窗口、轮换 `setTimeout(0)` 等）——不碰。

### 2.5 非目标

- 不新建 `schedules` 表、不新增 `ScheduleRun`/`health`/`target_lost` 持久字段。
- 不新建调度器、不轮询、不做结果观测。
- 不修改 DSH 的 `dsh-schedule` / `dsh-tool-schedule`。
- 不改变交接简报内容（brief 仍只含任务/未完成/用户原话/待确认派发）。
- 不做「定时任务看板列」、不做 run 历史、不做失败自动重试守护进程。
- 不删除、不重建 schedule（保留 id、规则、投递历史）。

---

## 3. 技术可行性核查

### 3.1 服务名与获取方式

`ScheduleService` 在构造时注册为 Cordis 服务 `'schedule'`：

`$DSH/node_modules/@deepseek-ai/dsh-schedule/src/index.ts:247-248`
```ts
constructor(ctx: Context, config: Config) {
  super(ctx, 'schedule')
```

插件侧通过软依赖获取：

```ts
const schedule = ctx.get('schedule')   // unknown，需运行时形状校验
```

依据：插件已有 `CordisContext.get(name)` 的最小面（`$REPO/packages/dsh-commander/src/host/dsh-types.ts:5-10`），且现网代码已用 `ctx.get('sessionController')` / `ctx.get('workspaceRegistry')` 等软解析；不需要把 `schedule` 加进 `inject`（`$REPO/packages/dsh-commander/src/host/index.ts:44`）。

**设计约束**：Host 零运行时依赖、不 import `@deepseek-ai/*`（`$REPO/packages/dsh-commander/src/host/dsh-types.ts:1-2`；`$REPO/AGENTS.md`「Host 只 import `node:*` 与相对模块」）。因此只在 `dsh-types.ts` 里加**结构化最小接口**，不 import `dsh-schedule` 类型。

### 3.2 枚举能力：`catalog()` 返回全部任务

`$DSH/node_modules/@deepseek-ai/dsh-schedule/src/index.ts:440-443`
```ts
@Remote('catalog')
async catalog(): Promise<ScheduleCatalogEntry[]> {
  return this.entries()
}
```
`entries()` 从 `tasks` 表全量读取并排序（`.../index.ts:682-685`），不受分页限制。这比 `list()` 更适合迁移：`list()` 默认 100 条、需要翻页（`.../types.ts:489-511`）。

### 3.3 改写能力：`edit()` 支持显式 sessionId + CAS

`$DSH/node_modules/@deepseek-ai/dsh-schedule/src/index.ts:555-592`
```ts
async edit(request: ScheduleEditRequest, actorSessionId?: SessionId, signal?: AbortSignal): Promise<ScheduleEditResult> {
  ...
  const target = request.action === 'update' && request.patch.target !== undefined
    ? await this.resolveTarget(request.patch.target, signal)
    : undefined
  ...
  const effectiveTarget = target ?? current.target
  if (target !== undefined || request.patch.timing !== undefined || request.patch.active === true) {
    await this.validateTarget(effectiveTarget, signal)
    ...
  }
  const task = revisedTask(current, request.patch, target, actorSessionId, Date.now())
  await tasks.put(request.id, task)
```

- `SchedulePatch.target` 类型是 `ScheduleTargetRequest`，`session` 分支带显式 `sessionId`：`$DSH/node_modules/@deepseek-ai/dsh-schedule/src/types.ts:531-542、376-394`。
- `expectedUpdatedAt` 做乐观并发控制：`.../types.ts:544-563`；服务端比较逻辑 `.../index.ts:571-573`。
- 返回成功是 `ScheduleCatalogEntry`；失败是 `{id, code:'schedule_not_found'|'schedule_conflict'}`：`.../types.ts:565-578`。
- `edit()` 只校验**新 target** 是否存在/非归档（`.../index.ts:648-673`），不要求旧 target 仍存在。因此即使旧会话已被删/归档，只要任务行还在，仍可把 target 救到新会话。

**状态保持**：`revisedTask` 只在 `patch.active` 显式 true/false 或规则变化时改状态；只改 target 时：
- `paused` 仍 `paused`；
- `ended` 仍 `ended`；
- `active` 仍 `active`；
- 会清掉 `pendingDelivery`（`.../index.ts:196-214`）。

依据：`$DSH/node_modules/@deepseek-ai/dsh-schedule/src/index.ts:196-214`
```ts
let status = current.status
if (patch.active === false) status = 'paused'
else if (patch.active === true || changedRule && current.status === 'ended') status = 'active'
...
...(pendingDelivery === undefined || changedRule || retargeted ? {} : { pendingDelivery }),
```

### 3.4 权限与归属

- `edit()` 是 Host 服务公开方法，没有「只有创建者才能改」的检查；按 `id` 直接读写（`.../index.ts:555-592`）。
- model tool `schedule_edit` 也走同一个 `ctx.schedule.edit`（`$DSH/node_modules/@deepseek-ai/dsh-tool-schedule/src/index.ts:460-484`），但它的 `target` 参数只允许 `this_session|new_once|new`（`...:448-450`），**不能直接指定另一个 sessionId**。所以插件必须直接调服务，不能借 model tool。
- `ScheduleCatalogEntry` 没有 creator/owner 字段：`.../types.ts:451-475`；`ScheduleRecord` 也只有 title/prompt/rule/timing（`.../types.ts:17-60、322-332`）。因此「只迁移本插件创建的任务」**没有可靠数据来源**，除非另建登记表/包装创建入口（见 §5 方案 B/C，均不推荐）。

### 3.5 rc.3 与 rc.2 差异

本轮逐段对照了与迁移直接相关的 API：

| 段落 | rc.3（当前安装） | rc.2（全局安装） | 结论 |
|---|---|---|---|
| `constructor → super(ctx,'schedule')` | `$DSH/.../index.ts:247-248` | `$DSH_GLOBAL/.../index.ts` 同段 | 一致 |
| `list()` | `$DSH/.../index.ts:414-420` | `$DSH_GLOBAL/.../index.ts:414-420` | 行号/内容一致 |
| `catalog()` | `$DSH/.../index.ts:440-443` | `$DSH_GLOBAL/.../index.ts:440-443` | 一致 |
| `edit()` | `$DSH/.../index.ts:555-592` | `$DSH_GLOBAL/.../index.ts:555-592` | 一致 |
| `involved()` / `revisedTask()` | `$DSH/.../index.ts:175-214` | `$DSH_GLOBAL/.../index.ts:175-214` | 一致 |
| `ScheduleTarget` / `SchedulePatch` / `ScheduleEditResult` | `$DSH/.../types.ts:353-394、531-578` | `$DSH_GLOBAL/.../types.ts:353-394、531-578` | 行号/内容一致 |

**限制**：只比对了上述 API 相关段落，没有对两个包做逐行全量 diff。因此结论是「迁移所需 API 在 rc.2/rc.3 一致」，不是「两个版本完全相同」。

### 3.6 风险等级与备选

| 风险 | 等级 | 缓解 |
|---|---|---|
| 服务形状随 DSH 版本漂移 | **中低** | 插件不 import 类型；运行时检查 `catalog/edit/view` 是否为函数；返回结构做 `'code' in result` 判定；`engines.dsh` 已限定 `<0.3.0` |
| `schedule` 服务未安装/未启用 | 低 | `ctx.get('schedule')` 为空 → 返回 `unavailable`，换代照常成功，只记 warn |
| 直接调服务绕过 model tool 授权 | 低 | 这是 Host 内部管理写，不涉及模型工具权限；只改 target，不创建/删除任务 |
| 服务实现变更导致 CAS 语义变化 | 低 | 传 `expectedUpdatedAt`，冲突时重读一次；仍冲突则记 failed |

**备选路径**（均不推荐，见 §5）：

- 通过 DSH 的 Remote HTTP 端点调 `schedule/edit`：需要猜内部路由/鉴权，比公开服务更脆。
- 借 model tool `schedule_edit`：target 枚举不允许指定 sessionId，无法完成。
- 修改 DSH 源码：违反「不改 DSH」边界。

---

## 4. 接入点与时序

### 4.1 插入位置：`commitRotation()` 之后

现有提交顺序（`$REPO/packages/dsh-commander/src/host/rotation/service.ts:295-399`）：

```text
create 新会话 → 选模型 → waitForAgent → 工具审计 → inject 交接简报 → rename 标题
→ commitRotation（写 config + 旧 link retired + 新 link）
→ [新增] migrateSchedules(from=旧 sessionId, to=新 sessionId)
→ return / emit rotation.updated
```

代码位置：

- `rotate()` 里 `await deps.binding.commitRotation({...})` 之后、`return` 之前插入：
  `$REPO/packages/dsh-commander/src/host/rotation/service.ts:365-387`
- 迁移结果放进 `RotationResult`，并随 `rotation.updated` 的 `finally` 发出：
  `.../rotation/service.ts:379-398`

### 4.2 为什么不在 commit 之前

- 迁移成功但 `commitRotation` 失败 → 任务被指到一个「还不是指挥官」的新会话，旧绑定仍在旧会话，语义更糟。
- 迁移失败若放在 commit 前并被当作硬失败 → 会阻止一次本来可以成功的换代，违反「换代不被附属能力阻塞」的既有原则。
- 因此：**commit 是唯一提交点；迁移是提交后的补偿**。代价是存在一个毫秒级窗口，旧任务仍可能投给旧会话（见 §6.5）。

### 4.3 手动绑定的接入

`$REPO/packages/dsh-commander/src/host/api/routes/handlers.ts:487-501`
```ts
export async function handleBindingPost(deps: ApiDeps, body: unknown): Promise<JsonResult> {
  const parsed = validateBindingBody(body)
  const view = parsed.mode === 'new' ? await deps.binding.bindNew(...) : await deps.binding.bindSelect(...)
  deps.sse.broadcast('binding.updated', ...)
```

接入方式：

1. 调用前用 `deps.binding.getConfig().commander.sessionId` 取 `from`（`.../session/binding.ts:394`）。
2. 绑定成功后，若 `from !== '' && from !== view.binding.sessionId`，调用同一个迁移模块。
3. 迁移结果放进 HTTP 响应（`binding.scheduleMigration`）与 `binding.updated` SSE 可选字段。
4. 迁移失败**不回滚绑定**，只告警。

### 4.4 幂等、失败重试、并发安全

**幂等**：

- 匹配谓词只看「当前 target 是否等于 from」。第一次迁移后 target 变为 to，第二次自然 no-op。
- 部分失败后重跑，只处理剩余仍指向 from 的任务。
- 同一个 `from → to` 重复执行不会重复写成功项。

**失败重试**：

- 单任务：`schedule_conflict` → 重新 `view()` 读最新 `updatedAt`；若 target 仍为 from，用新 revision 重试 **1 次**；否则 skip。
- 单任务：`schedule_not_found` → 视为并发删除/归档，skip，不算 failed。
- 整体：`catalog()` 失败 → 整体 `failed`，不逐条重试。
- 不做后台守护/定时重试（会引入 scheduler，违反冻结边界）。下一次换代/手动绑定会幂等重试。

**与用户归档旧会话并发**：

DSH 的 `stopSessionTasks()` 在**同一个串行队列槽**里完成「枚举 + 删除」（`$DSH/node_modules/@deepseek-ai/dsh-schedule/src/index.ts:743-762`），而插件的 `edit()` 也进入同一个 `serialize()` 队列（`.../index.ts:795-799`）。因此只有两种顺序：

1. 归档 stop 先执行 → 任务被删 → 插件 `edit()` 得到 `schedule_not_found` → skip；
2. 插件 `edit()` 先执行 → target 已变为新会话 → 归档 stop 再枚举时 `activeSessionTasks()` 只匹配旧 sessionId（`.../index.ts:154-159`），不会删除已迁移任务。

**不会出现「先枚举旧行、再删除已迁移行」的中间态**，因为枚举和删除在同一个槽内。这个结论是代码推理，未做并发压测（见 §10-U4）。

**与用户编辑同一任务并发**：

- 传 `expectedUpdatedAt`；冲突时重读一次。
- 若用户已把 target 改走 → skip，不覆盖用户选择。
- 若用户只改了 prompt/时间 → 重读后用新 revision 只改 target，保留用户改动。

**与另一次换代/绑定并发**：

- 轮换自身有 `rotating` 标志（`.../rotation/service.ts:348、354、396`），不会并发换任。
- 绑定与轮换之间没有互斥锁；迁移前要**再次确认当前 `config.commander.sessionId === to`**，否则 skip 并 warn，避免把任务迁到一个已经不是当前指挥官的会话。

### 4.5 迁移一半失败怎么办

- 不整体回滚已成功的 target 改写：target-only 改写是幂等的，回滚反而制造第二次写与新的竞态。
- 结果里记录 `migrated / skipped / failed`；失败的保持原 target（默认不 pause，见 §9-D2）。
- 下一次换代/绑定重跑即可补齐。
- 若用户想立刻回滚：反向迁移 `to → from`（旧会话仍存在时）即可；不涉及删除，数据风险低。

---

## 5. 方案对比

| 方案 | 做法 | 侵入性 | 可靠性 | 可回滚 | 与设计稿契合 | 成本 |
|---|---|---|---|---|---|---|
| **A. 提交后直接改 target**（推荐） | `ctx.schedule.catalog()` + `edit({patch.target})` | 低（只加一个模块 + 两处调用） | 高（公开服务、CAS、串行队列） | 高（target-only，可反向改回） | 高（正是 `schedule-module-design.md` §5.6-5 的调用） | 低 |
| B. 插件维护「跟随映射」+ 懒解析 | 记录 A→B，投递时解析/改写 | 高（需要 hook 或轮询） | 低（DSH 没有投递前插件 hook；轮询=自建 scheduler） | 中 | 低 | 中高 |
| C. 包装创建入口 | 拦截 `schedule_create`，创建时写入标记/绑定 | 中高（要覆盖 DSH 工具/服务） | 低（只影响新任务，旧任务不修） | 中 | 低 | 中 |
| D. 镜像重建 | 在新会话新建一条，再删旧任务 | 中（写两次 + 删除） | 低（部分失败会产生重复/丢失；id/history 变） | 低（删除不可逆） | 中 | 中 |

**推荐 A**：

- 与 DSH 的公开服务面完全对齐，不需要 DSH 改动。
- 与既有设计稿的调用形式一致（`ctx.schedule.edit({id, action:'update', patch:{target:{kind:'session', sessionId:newCommander}}, expectedUpdatedAt})`，见 `$REPO/docs/architecture/schedule-module-design.md:306`）。
- 保留任务 id、规则、状态、投递历史；失败可见、可重跑、可反向。
- 不引入 scheduler，不违反 `docs/NEXT-PHASE.md:20` 的冻结边界。

**1–5 打分（设计判断，非实测）**：

| 方案 | 侵入性 25% | 可靠性 30% | 可回滚 15% | 设计稿契合 15% | 成本 15% | 加权 |
|---|---:|---:|---:|---:|---:|---:|
| **A. 提交后直接改 target** | 5 | 5 | 4 | 5 | 4 | **4.70** |
| B. 跟随映射 + 懒解析 | 2 | 2 | 3 | 3 | 2 | 2.30 |
| C. 包装创建入口 | 3 | 2 | 3 | 2 | 3 | 2.55 |
| D. 镜像重建 | 3 | 2 | 2 | 3 | 2 | 2.40 |

> 打分口径：5 = 最优。A 的「成本 4」是因为仍需做 CAS/失败/并发处理，不是零成本；B 的「可靠性 2」是因为没有投递前 hook、只能自建轮询。

**B 不可行的核心原因**：DSH runtime 在 `resolveTarget()` 内直接解析并激活目标会话，没有暴露插件 hook（`$DSH/node_modules/@deepseek-ai/dsh-schedule/src/runtime.ts:425-433`）；`schedule/changed` 只在管理写后触发，不覆盖到期投递。要实现懒解析只能自建轮询/定时器，直接违反「没有 scheduler」的冻结决策。

**C 不可行的核心原因**：只覆盖新任务；旧任务在换代会话时已经存在，仍然要改 target。且覆盖 DSH 服务/工具属于高侵入。

**D 不推荐的原因**：删除旧任务会丢 id、投递历史与审计；部分失败会重复投递或漏投；与「任务记录是唯一真相」的取向不符。

---

## 6. 详细设计

### 6.1 模块与数据结构

新增模块（不写实现，仅约定）：

```text
$REPO/packages/dsh-commander/src/host/schedule/migration.ts
```

职责：给定 `ctx`、`fromSessionId`、`toSessionId`，枚举、筛选、逐个 `edit`、汇总结果；不依赖 rotation/binding，便于单测与复用。

类型（放在 `dsh-types.ts` 的结构化最小面，或 migration 模块内部）：

```ts
interface ScheduleCatalogEntryLike {
  id: string
  status: 'active' | 'paused' | 'ended'
  updatedAt?: string
  target:
    | { kind: 'session'; sessionId: string }
    | { kind: 'new_once'; sessionId: string }
    | { kind: 'new' }
}

interface ScheduleServiceLike {
  catalog(): Promise<ScheduleCatalogEntryLike[]>
  view(request: { id: string }): Promise<ScheduleCatalogEntryLike | { id: string; code: string }>
  edit(request: {
    id: string
    action: 'update'
    patch: { target: { kind: 'session'; sessionId: string } }
    expectedUpdatedAt?: string | null
  }, actorSessionId?: string): Promise<ScheduleCatalogEntryLike | { id: string; code: string }>
}
```

**不新增持久结构**：

- 不加 `schedules` 表。
- 不加 `config.commander.rotation` 字段（推荐 v1）。
- 迁移结果只存在于本次调用的返回值 / 日志 / SSE / HTTP 响应。

### 6.2 迁移算法（伪代码，不是实现）

```text
migrate(from, to):
  if from == '' or to == '' or from == to: return skipped
  svc = ctx.get('schedule')
  if !svc || typeof svc.catalog != 'function' || typeof svc.edit != 'function':
      return unavailable

  entries = await svc.catalog()                  // 失败 → failed（整体）
  matched = entries.filter(e =>
      e.target.kind === 'session' && e.target.sessionId === from)

  for e of matched:
      if e.status === 'ended' && !includeEnded: skip('ended'); continue
      attempt(e, retry=1)

  return counts

attempt(e, retry):
  req = { id: e.id, action:'update', patch:{ target:{kind:'session', sessionId:to} },
          expectedUpdatedAt: e.updatedAt ?? null }
  try:
      r = await svc.edit(req, actorSessionId = to)
      if r.code == 'schedule_not_found': skip('gone'); return
      if r.code == 'schedule_conflict':
          if retry == 0: failed(e, 'conflict'); return
          latest = await svc.view({ id: e.id })
          if latest.code: skip('gone'); return
          if latest.target.kind != 'session' || latest.target.sessionId != from:
              skip('changed_by_user'); return
          attempt(latest, retry=0); return
      migrated += 1
  catch err:
      failed(e, code(err))
```

细节：

- `catalog()` 一次全量；不建议用 `list()` 翻页（`list` 默认 100 条且需要处理 offset）。
- 按 `catalog()` 的排序处理（active 优先），不额外排序。
- 单任务最多 2 次 `edit`（首次 + CAS 冲突重试 1 次）。
- `expectedUpdatedAt` 始终传：`entry.updatedAt ?? null`。旧记录没有 `updatedAt` 时传 `null` 仍会参与 CAS（服务端比较 `current.updatedAt ?? null`，见 `$DSH/node_modules/@deepseek-ai/dsh-schedule/src/index.ts:571-573`），比省略更安全。
- 整体超时建议 `SCHEDULE_MIGRATION_TIMEOUT_MS = 3_000`（本地存储写，正常远低于此）；超时返回 `timeout`，已发出的写可能继续，依赖幂等重跑。
- 如果 `from` 或 `to` 为空、相等，直接 skipped，不调用服务。
- 迁移前/后校验 `config.commander.sessionId === to`；不等则 skip（并发绑定）。

### 6.3 失败处理

| 情况 | 处理 | 是否阻断换代 |
|---|---|---|
| `schedule` 服务不存在 | `unavailable` + warn | 否 |
| `catalog()` 抛错 | `failed` + warn | 否 |
| `edit()` 抛错（未知） | 该条 failed，继续下一条 | 否 |
| `schedule_conflict` | 重读 + 重试 1 次；仍冲突 failed | 否 |
| `schedule_not_found` | skip（并发删除/归档） | 否 |
| 新会话已被归档/删除 | `edit` 抛 `target-archived` 或 `session/not-found` → failed | 否 |
| 整体超时 | `timeout` + warn；下次幂等重跑 | 否 |

**默认不自动 pause**（推荐）：

- 失败后任务仍 active，会继续在旧会话投递；用户至少不会「完全收不到提醒」。
- 若自动 pause，失败的任务会静默停掉，风险更高。
- 设计稿 §5.6-5 的 `paused + target_lost` 依赖未实现的 `schedules` 表/health 字段，本方案没有该持久面，因此不照搬。
- 如果用户选择「失败即 pause」，实现上就是对失败项追加一次 `edit({active:false})`；但它也可能失败，只能尽力。见 §9-D2。

**重试上限**：

- 单任务 CAS 重试 1 次；整体不做后台重试。
- 下一次换代/绑定会重新扫描，天然补齐。
- 不新增「pending migration」持久标记；如果后续要求「重启后也必须自动补齐」，需要额外设计（可选字段或表），不在 v1。

### 6.4 审计与可观测

- 日志：
  - 成功：`[commander] schedule migration { from, to, scanned, matched, migrated, skipped, failed, durationMs }`
  - 单条失败：`[commander] schedule migration failed { id, code, message }`
  - 服务缺失：`[commander] schedule migration skipped: schedule service unavailable`
- SSE：
  - 复用 `rotation.updated`，payload 增加可选 `scheduleMigration`：
    `{ rotation, formerCommanders, scheduleMigration?, rev }`
  - 手动绑定复用 `binding.updated`，payload 增加可选 `scheduleMigration`。
- HTTP：
  - `POST /commander/rotation` 响应增加 `scheduleMigration`。
  - `POST /commander/binding` 响应增加 `scheduleMigration`。
- 客户端：
  - 自动换代：`src/client/store.ts` 现有 `已在换任到第 N 任` 的 notice 逻辑（`.../store.ts:219-230`），在 `scheduleMigration.failed > 0` 时追加一条 warn：「有 K 条定时任务未能跟随，请到自动化任务页处理」。
  - 设置页手动换任：`SettingsSection.tsx:372-383` 的 ResultLine 增加「N 条定时任务已跟随 / M 条失败」。
  - 不新增看板列/卡片。

**不记录任务标题/prompt**：日志只记 id/code/count，避免把提醒正文写进日志。UI 只显示计数，不列标题。

### 6.5 边界

| 边界 | 行为 |
|---|---|
| 旧会话已归档 | `catalog()` 仍可能看到 paused 任务；active 任务可能已被宿主删除。能看到的就迁；删掉的无法迁（已丢失）。迁移不要求旧会话存在 |
| 旧会话已删除（无 DSH API，指日志被手工移除） | 任务行若还在，`edit` 只校验新 target，仍可救到新会话 |
| 任务已 `ended` | 推荐一起迁（状态保持 ended，不会复活）；避免未来恢复时回到旧会话。若选择跳过，需在文档写清「恢复前手动改 target」 |
| `paused` | 迁 target，保持 `paused`，不自动恢复 |
| 多工作区 | schedule 是 Host 全局，不按工作区过滤；只按 target sessionId 匹配 |
| 换代回退/重新绑回旧会话 | 若覆盖所有绑定路径，绑回 A 时会从 B 迁回 A；若只覆盖自动换代，则需要手动处理 |
| 旧会话与新会话在同一工作区/不同工作区 | 不影响；target 是 session id |
| 迁移期间用户归档旧会话 | 由服务串行队列保证：要么任务已被删（skip），要么已迁走（归档 stop 不会再删） |
| 迁移期间用户编辑同一任务 | CAS 冲突重读；用户改走 target 则 skip |
| 迁移期间又发生一次绑定 | 迁移前校验当前绑定仍为 `to`，否则 skip；避免迁错 |
| 迁移快照后才创建的任务 | 本轮不追补；若用户是在旧会话里新建，仍会指向旧会话。可在下次绑定时处理；极端情况需手动改 |
| 旧任务处于 `executionActive` | `edit` 只改 target，不清 `executing` 内存槽；已排队/运行中的投递仍按旧 target 完成。这是可接受的：迁移不打断在途投递 |
| 迁移后旧会话收到 `[SCHEDULE CHANGE]` | `edit` 的 `involvedSessionIds` 会包含旧会话；若旧会话 live，可能收到上下文通知（`inject`，不唤醒）。建议 `actorSessionId = to`，让通知落到旧会话而不是新指挥官，保持新上下文干净 |

### 6.6 与交接简报/看板的关系

- **简报不变**：brief 在 commit 前生成并注入，迁移在 commit 后；不把 schedule 列表塞进简报，避免改变 §4 契约与 4096 字预算。
- **看板不变**：不新增「定时任务」列/卡片；迁移结果只在换任提示/设置页出现。
- **不新增工具**：不新增 `commander_schedule_*` 工具；迁移是 Host 内部行为。

---

## 7. 与 `schedule-module-design.md` 的关系

**结论：另起轻量方案（本文件），但复用其核心调用形式；不实现整份设计稿。**

| 维度 | `schedule-module-design.md`（未实现） | 本方案 |
|---|---|---|
| 范围 | 完整定时任务模块：第 8 张 `schedules` 表、run 账本、看板条、watchdog、confirm/authorize 模式 | 只做「换代时 target 跟随」 |
| 迁移对象 | `dispatchMode='confirm'` / 未完成首轮授权的 `authorize_then_direct` 的 schedule | 所有 `target.kind='session' && sessionId=旧任` 的任务（含用户手动创建） |
| 调用形式 | `ctx.schedule.edit({id, action:'update', patch:{target:{kind:'session', sessionId:newCommander}}, expectedUpdatedAt})`（`:306`） | **相同** |
| 失败处理 | `paused + health='target_lost'` + 告警（依赖 `schedules` 表/health 字段，`:306`、`:466-471`） | 默认保持 active + 告警 + 下次幂等重试；无 health 字段 |
| 触发 | 换代成功后 | 相同（commit 后） |
| 持久化 | 新增 `schedules` 表、`schedule.updated` SSE、run 历史 | 不新增表/字段；只在内存/响应/SSE 中返回结果 |
| 手动绑定 | §7.7 提到 confirm 模式要重指 | 覆盖 bindNew + bindSelect（推荐） |
| 实施顺序 | P0–P6，约 7.5–8.5 人日 | 轻量 v1，约 1–1.5 人日 |

**对齐策略**：

- 现在实现本方案；调用点放在 rotation/binding 的提交后，逻辑独立成 `schedule/migration.ts`。
- 将来完整模块落地时，把这个函数移动到 `schedules` 服务里，保留同样的调用点与结果字段；不要在两处重复实现。
- 实现轮建议在 `schedule-module-design.md` §5.6-5 / §7.7 加一行交叉引用：「v1 已由 `rotation-schedule-migration.md` 以轻量方式覆盖；完整模块落地时合并」。本轮不改该文件。

---

## 8. 落地清单与测试

### 8.1 文件级改动点（实现轮）

| 文件 | 改动 |
|---|---|
| `$REPO/packages/dsh-commander/src/host/dsh-types.ts` | 增加 `ScheduleServiceLike` / `ScheduleCatalogEntryLike` 结构化最小类型（不 import DSH 包） |
| `$REPO/packages/dsh-commander/src/host/schedule/migration.ts`（新增） | 迁移模块：`migrateCommanderSchedules()` |
| `$REPO/packages/dsh-commander/src/host/rotation/service.ts` | `RotationServiceDeps` 增加可选 `migrateSchedules`；`rotate()` 在 `commitRotation` 后调用；`RotationResult.scheduleMigration` |
| `$REPO/packages/dsh-commander/src/host/index.ts` | 把迁移函数注入 rotation；ApiDeps 增加 `migrateSchedules` |
| `$REPO/packages/dsh-commander/src/host/api/server.ts` | `ApiDeps.migrateSchedules?` |
| `$REPO/packages/dsh-commander/src/host/api/routes/handlers.ts` | `handleBindingPost` 捕获 from、绑定后迁移、响应加字段 |
| `$REPO/packages/dsh-commander/src/client/types.ts` | `RotationResult` / binding 响应加可选 `scheduleMigration` |
| `$REPO/packages/dsh-commander/src/client/store.ts` | `rotation.updated` 失败计数 → warn notice |
| `$REPO/packages/dsh-commander/src/client/SettingsSection.tsx` | 手动换任/绑定结果行显示迁移计数 |
| `$REPO/packages/dsh-commander/src/client/locales.ts` | zh/en 各 2–3 个 key |
| `$REPO/packages/dsh-commander/tests/unit/schedule-migration.test.ts`（新增） | 纯逻辑 + fake schedule service |
| `$REPO/packages/dsh-commander/tests/integration/rotation.test.ts` | 换代迁移、失败不阻断、幂等、ended/paused |
| `$REPO/packages/dsh-commander/tests/integration/m1-routes.test.ts` 或新增 | bindNew/bindSelect 迁移 |
| `$REPO/docs/architecture/rotation-contract-patch.md` | 实现轮补 §3.3/§7.5/§8.1 |
| `$REPO/docs/architecture/implementation-plan.md` | 实现轮补 §5.6、§8.4 SSE 字段 |
| `$REPO/docs/HANDOVER.md` | 实现轮补一行现状 |
| `$REPO/docs/validation/rotation-schedule-migration.md`（新增） | 实现后证据 |

**不改**：`package.json` 依赖、`cordis.patch.yml`、`dsh-schedule`、`dsh-tool-schedule`、任何存储 schema（v1 推荐不加配置字段）。

### 8.2 测试

**单测（fake schedule service）**：

1. `from === to` / 空 id → skipped，不调用服务。
2. `schedule` 服务缺失 → unavailable，不抛。
3. 只匹配 `target.kind='session' && sessionId=from`；`new` / `new_once` / 其它 session 不动。
4. active → 迁移；paused → 迁移且状态不变；ended → 按策略（推荐迁移，状态不变）。
5. `edit` 成功 → 计数；`edit` 抛错 → failed，后续继续。
6. `schedule_conflict` → 重新 view，target 仍为 from 时重试一次成功；用户已改走 → skip。
7. `schedule_not_found` → skip。
8. `catalog()` 抛错 → failed。
9. 重复执行 → 第二次 0 次 edit（幂等）。
10. 迁移前/后 `config.commander.sessionId !== to` → skip（并发保护）。

**集成（rotation）**：

1. force 换任，fake schedule 有 old-active / old-paused / other-session / new-target / new_once 各一条：断言只有 old-active/old-paused 被 edit，target 改为新 id，旧 link retired，返回 `scheduleMigration.migrated=2`。
2. `edit` 抛错：`rotated=true`（换代成功）、`scheduleMigration.failed=1`、config 仍指向新会话、旧任务仍在旧 target。
3. 自动 `turn/end` 触发：同样迁移；SSE `rotation.updated` 带 `scheduleMigration`。
4. 投递前兜底 `POST /commander/message`：迁移后再投递，消息落新会话。
5. 迁移超时/服务缺失：换代成功，`unavailable`/`timeout`。

**集成（binding）**：

1. `bindNew` 从 A→B：A 的任务迁移到 B；响应带 counts。
2. `bindSelect` 从 B→A：B 的任务迁回 A；验证「绑回旧任」。
3. 绑定失败：不迁移；绑定成功但迁移失败：绑定仍 200，返回 failed counts。

**客户端**：

- `rotation.updated` 带 `failed>0` → 产生 warn notice（若已有 client harness，用 harness 断言；否则单测 store 纯函数）。
- locale 两份字典同改（`locales.test.ts` 守护）。

**手动验收（隔离 profile，用户执行）**：

1. 开启 rotation（周期 1 天）。
2. 在指挥官会话里创建一条 `this_session` 提醒（如「每天 09:00 提醒我 X」），`schedule_list` 记下 id 与 target sessionId。
3. 再创建一条 `new_once` 与一条指向工作会话的提醒作为对照组。
4. 设置页「立即换任」。
5. `schedule_list` 断言：原提醒 target = 新指挥官；`new_once`/工作会话提醒 target 不变；任务 id、状态、规则不变。
6. 再换任一次，断言无重复写/无报错（幂等）。
7. 归档旧指挥官（若可），断言已迁移任务不被删除。
8. 造一条失败（例如禁用 schedule 服务）验证换代仍成功、告警可见。

### 8.3 分批实施

| 批次 | 内容 | 可独立验收 |
|---|---|---|
| P1 | `schedule/migration.ts` + 结构化类型 + 单测 | 是（不接线，纯模块） |
| P2 | rotation 接线 + `RotationResult` + SSE + 集成测试 | 是（自动换代） |
| P3 | bindNew/bindSelect 接线 + 客户端提示 + locale | 是（手动绑定） |
| P4 | 文档合入 + 隔离 profile 手动验收 + validation 文档 | 是 |

建议 P1+P2 一个 PR，P3 一个 PR；P4 随 P3 或单独。

### 8.4 验收标准

实现结果（2026-11-27）：**A1–A9 已由单测/集成测试覆盖；A10 已实现（typecheck/build 通过，未加 EventSource 客户端交互测试）；A11 通过；A12 未执行**（隔离 profile 手动验收需要真实 `schedule` 服务，本轮未碰 live）。

- [x] A1：active 旧任务全部改为新 target；id/规则/状态不变。
- [x] A2：paused 迁移且仍 paused；ended 按拍板策略处理且不复活。
- [x] A3：`new` / `new_once` / 其它 session 零改动。
- [x] A4：重复执行幂等（第二次 0 次 edit）。
- [x] A5：迁移失败不导致 `rotated=false`；`scheduleMigration.failed` 可见。
- [x] A6：`schedule` 服务缺失/超时，换代仍成功。
- [x] A7：CAS 冲突重试 1 次；用户改走 target 时 skip。
- [x] A8：并发归档导致的 not_found 只 skip，不抛。
- [x] A9：bindNew/bindSelect 均迁移（若拍板覆盖）。
- [x] A10：客户端能看到失败计数（已实现 + typecheck/build；未加 EventSource 客户端交互测试）。
- [x] A11：typecheck + 全量单测/集成测试全绿；build 通过。
- [ ] A12：隔离 profile 手动验收通过。

### 8.5 风险与回滚

| 风险 | 影响 | 缓解/回滚 |
|---|---|---|
| 服务 API 漂移 | 迁移失败 | 运行时形状检查 + 失败不阻断 + 版本范围；必要时回退到「提示用户手动改」 |
| 误迁用户手动任务 | 用户意图被改变 | 迁移前日志/告警；可反向迁移；若担心，加 kill switch（§9-D4） |
| 提交后窗口内旧任务投递 | 旧会话收到一次提醒 | 窗口毫秒级；不引入两阶段暂停（复杂度/残留风险更高）；文档说明 |
| 迁移耗时长 | 手动换任响应变慢 | 3s 总超时；post-commit 不影响绑定 |
| 无持久重试 | 失败任务停留旧会话 | 告警 + 下次绑定重试；如需强保证，后续加 pending 标记 |
| 旧会话收到 `[SCHEDULE CHANGE]` | 旧会话上下文多一条通知 | `actorSessionId=to`，通知落旧会话；不唤醒；可接受 |
| 绑定/轮换并发 | 迁错会话 | 迁移前校验当前绑定 = to，否则 skip |
| 状态被意外改活 | paused/ended 复活 | 只改 target，不传 `active`；`revisedTask` 已验证状态保持（`:196-214`） |

**回滚**：

- 代码回滚：移除调用即可；已迁移任务留在新会话（当前指挥官），语义仍正确。
- 数据回滚：若需回到旧会话，执行反向 `to → from`；旧会话存在时可行。不涉及删除，风险低。
- 若加 kill switch：关闭后不再自动迁移，已迁移的不回滚。

---

## 9. 需要拍板的决策（≤5）

### D1. 迁移范围与创建者

- **推荐**：迁移**所有** `target.kind='session' && sessionId=旧任` 的任务；`active + paused + ended` 都迁（ended 只改 target，不复活）；**不区分创建者**。
- 理由：DSH 没有 creator 字段，无法可靠区分；按 target 语义迁移最一致；ended 一起迁可避免未来恢复时回到旧会话。
- 备选：只迁 active+paused，跳过 ended（少写历史，但恢复前需手动改 target）；只迁「本插件创建」（不可行，除非另建登记/包装入口）。

### D2. 失败策略

- **推荐**：失败**保持 active** + 告警 + 下次幂等重试；不自动 pause。
- 理由：pause 会让提醒静默停掉，丢提醒风险更高；设计稿的 `paused + target_lost` 依赖未实现的 health 字段。
- 备选：失败即 `edit({active:false})` + 告警（照搬设计稿语义；但 pause 也可能失败）。

### D3. 手动绑定覆盖范围

- **推荐**：自动换代 + `bindNew` + `bindSelect` 全覆盖。
- 理由：三者都改变「当前指挥官会话」；只覆盖自动换代会让手动切换后 target 仍旧。
- 备选：只覆盖自动换代（+ 可选 bindNew），`bindSelect` 留给用户手动处理（范围更小，但语义不一致）。

### D4. 是否加 kill switch

- **推荐**：v1 **不加新配置**；自动路径受 `rotation.enabled` 控制，手动绑定总是迁移。若用户反馈「不想让某条手动任务跟随」，再加快跟开关。
- 备选：加 `commander.rotation.migrateSchedules`（默认 true），需要 schema/validation/config view/client 表单/locale/测试的加法改动。

### D5. 失败可见性

- **推荐**：SSE `rotation.updated` / `binding.updated` 带 `scheduleMigration` + 面板 warn notice + 结构化日志；不新增表/看板列。
- 备选：仅日志（实现最小，但用户可能不知道提醒没跟过去）。

---

## 10. 未验证 / 查不到

| ID | 未验证项 | 说明 |
|---|---|---|
| U1 | 插件作用域内 `ctx.get('schedule')` 实际返回服务 | 已核对服务注册名与插件 `ctx.get` 机制，但未在 live 中从 commander 插件调用过 |
| U2 | 从 Host 插件直接 `edit()` 的运行时权限 | 源码未见创建者/权限检查（`:555-592`），但未 live 验证 |
| U3 | rc.3 与 rc.2 全量一致性 | 只逐段对照了 migration 相关 API；未做整包 diff |
| U4 | 与归档 stop 的并发时序 | 由 `stopSessionTasks` 的串行槽代码推理（`:754-762`），未做并发压测 |
| U5 | `[SCHEDULE CHANGE]` 通知对旧/新会话的实际影响 | 只读代码推断为 `inject` 上下文通知、不唤醒；未 live 观察 |
| U6 | 大量任务时的迁移耗时 | 依赖 `catalog()` 全量 + 逐条 edit；任务规模未知 |
| U7 | 用户本机现有 schedule 的 target 分布 | 未读取 `~/.dsh/storages/schedule.json`（只读任务，未触碰 live 数据） |
| U8 | `schedule` 服务被禁用/未安装时的真实行为 | 代码路径是 `ctx.get` 为空 → `unavailable`；未 live 验证 |
| U9 | `expectedUpdatedAt` 在时钟回拨/并发编辑下的所有边界 | 只核对了比较逻辑（`:571-573`）与 `revisedAt`（`:190-193`） |
| U10 | 迁移 ended 任务是否影响 DSH UI 的历史展示 | `target` 是「下一次投递目标」，理论上 ended 无投递；未 live 确认 |
| U11 | `catalog()` 是否包含所有工作区/所有状态 | `entries()` 全表读取（`:682-685`），从代码看是；未 live 对照 `schedule_list` |
| U12 | 插件与 DSH 的版本兼容矩阵 | 只核对 rc.2/rc.3；`engines.dsh` 上限 `<0.3.0`，未来版本需重核 |
| U13 | `bindSelect` 绑定到已归档/不可用会话 | 现有 `bindSelect` 校验未改；迁移会因新 target 无效而 failed，但绑定本身是否允许该会话未 live 验证 |

---

## 11. 证据索引（本轮核对）

**插件侧**

- 轮换提交顺序：`$REPO/packages/dsh-commander/src/host/rotation/service.ts:295-399`
- 提交点：`$REPO/packages/dsh-commander/src/host/rotation/service.ts:365-387`
- 退役写入：`$REPO/packages/dsh-commander/src/host/session/binding.ts:351-387`
- 手动绑定路由：`$REPO/packages/dsh-commander/src/host/api/routes/handlers.ts:487-501`
- 组合根装配：`$REPO/packages/dsh-commander/src/host/index.ts:365-380`
- 软依赖最小面：`$REPO/packages/dsh-commander/src/host/dsh-types.ts:1-10`
- fake ctx：`$REPO/packages/dsh-commander/tests/fakes/fakes.ts:18-30`
- 冻结边界：`$REPO/docs/NEXT-PHASE.md:20`；`$REPO/README.md:108`；`$REPO/docs/HANDOVER.md:333-334`
- 未实现设计稿：`$REPO/docs/architecture/schedule-module-design.md:2-4、306、466-471`

**DSH 侧（当前安装 rc.3）**

- 服务注册：`$DSH/node_modules/@deepseek-ai/dsh-schedule/src/index.ts:247-248`
- 全量枚举：`.../index.ts:440-443`
- 改写：`.../index.ts:555-592`
- 状态保持/清 pending：`.../index.ts:196-214`
- 目标校验：`.../index.ts:626-673`
- 归档 stop 串行删除：`.../index.ts:743-762、154-159`
- 服务队列：`.../index.ts:795-799`
- 类型：`.../types.ts:353-394、451-475、531-578`
- model tool target 限制：`$DSH/node_modules/@deepseek-ai/dsh-tool-schedule/src/index.ts:329-330、382、448-450`

**DSH 侧（全局 rc.2 对照）**

- 同段：`$DSH_GLOBAL/node_modules/@deepseek-ai/dsh-schedule/src/index.ts:175-214、414-443、555-592`
- 同段类型：`$DSH_GLOBAL/node_modules/@deepseek-ai/dsh-schedule/src/types.ts:353-394、451-475、531-578`

---

## 12. 本轮不修改声明

- 未改任何代码/配置/存储 schema。
- 未新建/编辑/删除任何真实定时任务。
- 未重启 DSH、未安装依赖。
- 未读取/写入 `~/.dsh` 的 live schedule 数据。
