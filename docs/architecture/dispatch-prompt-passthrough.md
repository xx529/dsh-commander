# 派发消息·原样透传 实现契约（取消 brief 模板）

> 日期：2026-11-26
> 状态：**已实现**（Host/Client 构建与自动化验证通过；live 待用户重装 + 重启）。
> 本文是 `implementation-plan.md` §9.5 / `m5-continue-dispatch.md` §6 的**取代性补丁**：冲突以本文为准。
> 需求来源：用户 2026-11-26 明确要求——
> 1) 派发时不再由程序拼接任何内容；
> 2) 指挥官给什么，工作会话就收到什么，不加东西、不自动截断；
> 3) 任务标题 / 目标 / 验收提示 / 约束 / 上轮结论 / 上轮验收 **统统不由程序添加**。

---

## 0. 一句话方案

`commander_task_dispatch` 新增必填参数 `prompt`：这是**指挥官自己写好的、工作会话第一条消息的全文**。Host 只做一件事——把它原样交给 `sessionController.prompt({content:[{type:'text', text: prompt}]})`。模板、裁剪、截断、兜底句全部删除（`src/host/dispatch/brief.ts` 整文件删除）。

`round/kind/round+1/acceptanceHistory/autoDispatch/确认卡/依赖守卫` 等既有语义**不变**。

---

## 1. 为什么改

原实现（plan §9.5）由 Host 拼模板：

```
任务：<title>
目标：<goal>
验收提示：<acceptance ≤5 条>
约束：<固定句>
```

问题（用户口径）：派发内容因此永远是"程序想说的"，指挥官真正想交代的内容只能塞进 `instruction` 的窄缝里；续派的「上一轮结论/上一轮验收项」也是程序选的（且会 clip）。用户要求**由指挥官全权组织**这段文本。

新增的能力前提：指挥官要自己写，就必须能读到任务定义与上一轮结论 → `commander_task_get` 扩字段（§4）。

---

## 2. 工具契约变更

### 2.1 `commander_task_dispatch`

```ts
commander_task_dispatch({
  taskId: string,
  requestId: string,
  prompt?: string,          // 新增：工作会话首条消息全文（原样投递）
  candidate?: {...},        // 不变
  decisionId?: string,      // 不变
  confirmTarget?: {...},    // 不变
  capabilityNeeds?: string[], // 不变（只用于能力面板，不进 prompt）
  userRequest?: string,     // 不变：用户原话，仅展示/审计（≤2000）
})
```

- `prompt` **首次调用（生成确认卡 / 自动派发 / 歧义工作区）必填**；确认调用可省略，此时复用确认卡里保存的同一份 `prompt`（避免模型重抄长文本、也避免两轮文本漂移）。确认调用若传了 `prompt`，以新传入的为准。
- 校验口径：`typeof prompt === 'string' && prompt.trim() !== ''`；**只校验空串，不做 trim、不做 clip、不设长度上限**。
- 缺少 `prompt` 且确认卡里也没有 → `rejected(code='invalid_prompt', message='prompt is required: ...')`，不建卡、不派发。
- `instruction` 参数**删除**。看板批注（`pendingInstruction`）不再由 Host 合并进任何文本：指挥官必须把批注原文写进自己的 `prompt`（`[task-continue]` 注入里带原文）。

### 2.2 `commander_task_get`（扩字段）

为让指挥官能自己写全，只读接口补充（其余字段不变）：

| 字段 | 用途 |
|---|---|
| `goal` | 写「目标」 |
| `acceptance[]` | 写「验收提示」（当前轮验收项，含 `state`） |
| `reportSummary?` | 写「上一轮结论」 |
| `acceptanceHistory[]` | 往轮验收/结论（需要时引用，不再由 Host 自动挑） |
| `pendingInstruction?` | 看板批注原文（必须写进 prompt） |

`commander_task_list` 不变（列表仍不返回这些大字段）。

---

## 3. Host 实现变更

| 文件 | 变更 |
|---|---|
| `src/host/dispatch/brief.ts` | **删除**（`buildDispatchBrief` 模板退役） |
| `src/host/config.ts` | 删除 `DISPATCH_BRIEF_MAX_CHARS`（不再有截断） |
| `src/host/dispatch/spawn.ts` | `SpawnInput.prompt: string`；删除 `round/instruction/previousSummary/previousAcceptance/sameSession`；`controller.prompt` 的 text 就是 `input.prompt` |
| `src/host/dispatch/service.ts` | `DispatchTaskArgs.prompt`；删除 `mergeInstruction`；`PendingDecision.prompt`；`finishDispatch` 记录 `DispatchRecord.brief = prompt 原文`；首派/自动/歧义三条建卡路径都要求并保存 `prompt`；确认路径 `args.prompt ?? decision.prompt` |
| `src/host/dispatch/decisions.ts` | `PendingDecision.instruction` → `prompt?: string`（内存，TTL 30m，重启即失效） |
| `src/host/schema.ts` | `DispatchRecord.instruction` 删除；`brief` 语义改为「实际发给工作会话的消息原文」 |
| `src/host/tools/index.ts` | 参数/schema/render/execute 调整；`commander_task_get` 扩字段 |
| `src/host/session/prompt.ts` | 指挥官 system prompt 改写（§5） |
| `src/host/tasks/{actions,notifications}.ts` | `[task-continue]` / `[task-unblocked]` 提示文案改为「自己写 prompt，含批注原文」 |

### 3.1 投递不变量

- 工作会话收到的第一条消息 == `prompt` 原文（逐字符相同：含前后空白、多行、>8KB 均不裁剪）。
- `DispatchRecord.brief` == 该原文（看板「派发内容」直接展示它）。
- 不追加 marker、不追加 `taskId/decisionId/sessionId` 元数据、不追加「约束」句。

---

## 4. 数据与兼容

- `DispatchRecord.instruction` 不再写入；旧记录里可能残留该字段，读取侧忽略（校验器不再声明它）。
- `DispatchRecord.brief` 沿用字段名（历史含义即「工作会话收到的原文」），旧记录照常展示。
- `pendingInstruction`（看板批注）仍然写库、仍然进 `[task-continue]` 注入、仍然以 `userRequest.source='board'` 记审计，只是**不再由 Host 拼进 prompt**。

---

## 5. 指挥官 system prompt 变更要点（`src/host/session/prompt.ts`）

1. 工作会话首条消息**完全由指挥官写**（`prompt`）：Host 不加模板、不加前缀、不截断、不追加约束；漏写等于没交代。
2. 写之前先 `commander_task_get` 取 `goal/acceptance/reportSummary/acceptanceHistory/pendingInstruction`。
3. 续派：本轮要求、上一轮结论、上一轮验收项（换会话时）、目标（换会话时）都由指挥官自己决定写不写、写多少。
4. 看板批注（`[task-continue]` 原文）必须出现在 `prompt` 里；用户原话同时可放 `userRequest` 供看板展示。
5. 确认卡二次调用：`decisionId + confirmTarget + requestId` 即可复用确认卡里的 `prompt`；要改文本就再传 `prompt`。

---

## 6. 验证

| 层 | 用例 |
|---|---|
| 单测（`tests/unit/dispatch-core.test.ts`） | 删除模板断言；断言无 `buildDispatchBrief` |
| 集成（`tests/integration/dispatch.test.ts`） | 原样投递（含前后空白/多行/超 8KB）；缺 `prompt` → `invalid_prompt`；确认不传 `prompt` 复用；`DispatchRecord.brief` 同原文；记录不含 `instruction` |
| 集成（`tests/integration/m5-continue.test.ts`） | 续派 `brief` == 本轮 `prompt`；不再出现「本轮要求/上一轮结论/上一轮验收项」程序段 |
| 集成（`tests/integration/task-update-tools.test.ts`） | `commander_task_get` 返回 `goal/acceptance/reportSummary/pendingInstruction` |
| 工具（`tests/unit/tools.test.ts`） | dispatch 参数表不再含 `instruction`，含 `prompt` |
| e2e（`tests/e2e/m1-e2e.mjs` + probe） | 探针首派带 `prompt`，工作会话收到原文，marker 检测改为探针自写文本 |

命令：`pnpm --filter dsh-commander typecheck` → `test` → `build`；`node packages/dsh-commander/tests/e2e/m1-e2e.mjs`。

---

## 7. 已知限制

- 指挥官漏写任务定义时，工作会话真的收不到——Host 不再兜底（这是本次明确取舍）。
- 看板批注靠指挥官转写进 `prompt`，不做「批注必须在 prompt 里」的强校验（避免 Host 再次介入文本）。
- 超长 `prompt` 无上限：单条会话消息的实际承载上限由 DSH `sessionController.prompt` 决定，失败按 `delivery_failed` 处理（任务 blocked，可重试）。
