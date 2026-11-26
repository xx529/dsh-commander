# 原生壳气泡活动文案（2026-11-26）

## 结论

- 气泡 working 态不再固定写「正在思考」，而是展示**当前活动**：
  - `tool/call` 的参数 JSON 含非空 `description` → 展示该值；缺失/为空/解析失败 → **跳过**，保留上一条活动。
  - 工具调用之间的 `assistant/message` 文本 → 展示该文本（折叠换行/连续空白）。
  - 两者都没有时回退「正在思考」；`turn/start`、`turn/end` 清空活动。
- 文案单行显示。Host 侧截到 **200 字符**（补 `...`，防止 SSE 载荷过大）；Client 展示前再截到 **40 字符**（补 `...`）；`.dshcn-bubble-text` 另有 `overflow:hidden + text-overflow:ellipsis` 兜住像素宽度。成功态仍固定「已完成 · 点击球查看」。
- 数据面只做加法：`commander.status.activity` 与快照 `commanderActivity`；`commander.message` 通道、消息环、存储表均未改动。

## 改动

| 层 | 文件 | 内容 |
|---|---|---|
| Host | `src/host/session/commander-events.ts` | activity 状态；`tool/call` 解析 `arguments.description`；assistant 文本更新活动；turn 起止清空；`normalizeActivityText` / `extractToolDescription` |
| Host | `src/host/api/state.ts`、`src/host/api/routes/handlers.ts`、`src/host/index.ts` | 快照 `commanderActivity`；状态初始化带 `activity` |
| Client | `src/client/state.ts`、`src/client/types.ts` | `activity` 状态与 `commanderActivity` / `commander.status.activity` 归一化；旧 Host 缺字段时保留旧值 |
| Client | `src/client/bubble.ts`、`src/client/BubbleApp.tsx`、`src/client/window-styles.ts` | `bubbleActivityText`（40 字符 + `...`）；working 文案优先活动、空则回退；文本省略样式 |
| 契约 | `docs/architecture/native-shell-contract.md`、`docs/architecture/m0-contract-patch.md` | 契约 v0.5 / m0 v1.1 加法字段说明 |
| 测试 | `tests/unit/commander-activity.test.ts`、`tests/integration/host.test.ts`、`tests/client/bubble.test.ts`、`tests/client/state.test.ts`、`tests/client/window-styles.test.ts` | 描述解析/跳过、活动状态与 SSE、客户端归一化、截断与省略样式 |

## 验证

| 项 | 结果 |
|---|---|
| `pnpm --filter dsh-commander typecheck` | PASS（host + client） |
| `pnpm --filter dsh-commander test` | PASS，**459/459** |
| `pnpm --filter dsh-commander build` | PASS（host + client + window） |
| client/window harness | smoke **52/52**；interact **195/195**；新增 `bubble.mjs` **6/6**（jsdom 加载真实 `lib/window.js`，覆盖快照活动、SSE 替换、50→40+`...`、`null` 回退、turn/end 成功文案；`/tmp/dshc-harness-modules` 提供 jsdom） |
| `commander.status` SSE | 集成断言：`tool/call` 后帧内含 `"activity":{"text":"查看当前目录","at":450}` |
| 快照恢复 | 集成断言：turn/start 后活动随快照返回；无 description 的工具不改活动；assistant 文本覆盖活动；turn/end 后为 `null` |
| 展示截断 | 单测：41 字符 → 40 字符 + `...`；换行/多空格折叠为单行；CSS 单测锁定 ellipsis |
| 真实窗口 bundle | `bubble.mjs` PASS 6/6：`role=bubble` 页面在快照 busy+activity 下渲染「查看当前目录」；SSE 长文本截断；`null` 回退「正在思考」；turn/end 切「已完成 · 点击球查看」 |

## 已知限制

- 未新增真机截图：本轮只改了 `lib/window.js`（Client 窗口页 bundle），原生壳二进制未变；需要重装/重启后才能在新气泡里看到活动文案。`bubble.mjs` 用 jsdom 覆盖了同一 bundle 的渲染/更新，但没有真实窗口的像素/主题走查。
- 活动只存在 Host 进程内，不落库；Host 重启后的快照回到 `null`，下个 `tool/call`/assistant 文本重新填充。
- 只读取 `tool/call` arguments 的**顶层** `description`；嵌套字段或非字符串不展示。
- 工具没有 description 时按需求“跳过”，不会猜测工具名/参数生成文案。
- 活动文案使用纯文本（不渲染 Markdown）；超长时按字符截断，CJK/英文的实际像素宽度由 CSS ellipsis 再收口。
