# Commander

Commander 是 DeepSeek Harness 的派发插件：用户在一个**指挥官会话**里描述任务，
插件把任务派发到目标工作区/会话的 agent，并在 agent 停止后把最后一条回复回传给指挥官。

## 功能

- 任务板：任务记录（状态、优先级、验收项、有界时间线）持久化在 `commander` 存储域。
- 派发：根据真实工作区/会话快照做候选构造与门控；**所有自动派发都要求按当前策略确认**（M0 阶段每次人工确认）。
- 能力适配：目标会话创建后按能力面板（`capabilityPanel`）显式 rank/apply；面板不可用或失败时回退 `inherit` 并继续派发。
- 回传：订阅 `turn/end`，把最后一条 assistant 回复（8KB 头尾截断）注入指挥官会话；审批/提问等待中不注入，按 `<sessionId>:<turnId>:<lastSeq>` 去重。

## 用法

1. 在插件管理页启用 **Commander**（安装到 profile）。
2. 打开 Commander 面板（`shell.overlay` 悬浮球 / 面板），按引导创建或绑定指挥官会话。
3. 在指挥官会话里描述任务；派发需要确认时点击确认，任务与会话绑定关系显示在看板。
4. agent 停止后，指挥官会收到 `[session-reply] …` 形式的消息，可继续追问或更新任务状态。

## 限制

- M0 阶段：每次派发都需要人工确认，**不提供无人确认的自动派发**。
- 自动派发在 V5 50 案例门禁未达标（precision ≥95% 等）时不启用。
- 审批/提问等待期间不注入，恢复后以该回合的 `turn/end` 为准；空回合默认注入占位文案。
- 任务记录只写本插件自己的 `commander` 存储域，不改宿主会话日志与既有 UI 结构。

## 构建（开发者）

```bash
pnpm install
pnpm --filter dsh-commander build        # Host: tsc → lib/host；Client: tsdown + 包裹 → lib/client.js
pnpm --filter dsh-commander typecheck
```
