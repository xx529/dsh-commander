# T65/T66/T67 独立复核（tester，会话可读化绑定选择器 + sessions 性能）

> 范围：backend task-65（冷会话列表 title/createdAt + bindSelect 冷会话）、frontend task-66（设置页绑定选择器可读化）、backend task-67（`GET /commander/sessions` 性能回归修复）。
> 方法：独立复跑测试/harness + 自建隔离 e2e（bind-select-e2e）+ live Host 只读取证与计时；未改实现/配置；live 写仅走查所需。

## 0. 裁定
**T65/T66/T67 = PASS（自动化 + live Host + live UI 用户实机确认）。**
- **live UI PASS（用户实机确认）**：2026-11-18 ~11:36，用户在 live 页面实际完成「设置 → 指挥官 → 选择已有会话 → 确认绑定/切换」，口头确认「绑定和切换可以了」；Lead 随后完成最终 reload（部署 task-68 limit=20 与 backend 标题并发优化），实测绑定仍保持 `session-5e70318d…`、sessions `limit=20` 延迟 0.181s、4 行标题正常（"M1R attach 自定义派发验收"/"Greeting"/"指挥官"）。
- 证据边界（如实披露）：用户实机操作为主证据；**行级视觉细节（短 id/相对时间/上下文水位/创建时间格式）未逐项截图审计**（tester sandbox 无物理输入），但功能操作成功、Host 字段与标题实测正常。
- 严重级别：HIGH 0 / MEDIUM 0 / LOW 0；无开放待办。

## 1. 独立复跑证据
| 检查 | 结果 | 证据 |
|---|---|---|
| `pnpm --filter dsh-commander test` | **223/223 PASS** | `/tmp/t67-tests.txt`（本轮）；`tests/artifacts/m1/live/t65-bind/**` |
| perf 回归测试 `tests/integration/m1r-sessions-perf.test.ts` | **4/4 PASS** | 独立 `node --test` 复跑 |
| client harness | **smoke 43/43 + interact 126/126 PASS** | `/tmp/t66-harness.txt` |
| client 产物 | sha `6350e370…`、245,969B（与 frontend 一致） | `lib/client.js` |
| 自建 e2e `tests/e2e/bind-select-e2e.mjs` | **10/10 PASS** | `tests/artifacts/m1/live/t65-bind/run2.log`、`summary.json` |
| 隔离 sessions 延迟（limit=5，8 次） | p50 **3ms** / p95 **4ms**（<2s 目标） | `tests/artifacts/m1/live/t65-bind/isolated-latency.json` |
| 冷会话绑定 | reboot 后 fixture `createdAt` 数字；`POST binding mode=select` → **200**、state.binding 切换 | `binding-select.json`、`sessions-after-reboot.json` |
| 错误分支 | 跨 workspace → **409 workspace_conflict**；未知 → **404 not_found** | `binding-wrong-ws.json`、`binding-unknown.json` |

## 2. live Host（重载后）证据（自动化数值为 task-68 之前 checkpoint，最终基线见 §2.1）
- live `http://127.0.0.1:54132`：health 200；sessions 行含 `title`/`createdAt`/`lastActiveAt`（Example: title「调研 Llamaindex」createdAt=1794935135580）；50 行中 50 有 createdAt、44 有非空 title（`tests/artifacts/m1/live/t66/03-sessions-live.json`；Lead 证据 `tests/artifacts/m1/live/t65-bind/live-sessions-after-reload.json`）。
- 性能（task-67 修复后，Lead + tester 双测）：commander ws limit=5 **0.23–0.27s**（tester p50 171ms/p95 270ms）、agent ws **0.31–0.45s**（p95 448ms）；修复前同接口曾 **41.7–48.3s**（Lead 记录）/tester 修复前冷启动单测到 **63.8s**（重载后消失）。
- dispatch 全链路（真实模型，含思考/工具往返）：首次 needs_confirmation **13.2s**、确认到 dispatched **11.3s**（非路由延迟；仅记录供参考；task 最终 `running`，证据 `tests/artifacts/m2/live/t67-perf/perf.json`）。
- **注意**：以上 dispatch 计时为真实模型回合耗时，不是 task-67 优化目标；路由性能以 sessions 0.2–0.4s 为准。

## 2.1 最终基线（Lead 复跑，task-68 之后）

> 说明：§1/§2 中的 **223/223 tests、client `6350e370…`（245,969B）、harness 43/43+126/126** 是 **task-68 之前 checkpoint**；task-68（sessions `BINDING_SESSION_LIMIT=20` + backend 标题快照分块并行优化）合入后的最终基线如下（tester 独立复跑与 Lead 数值一致）：

| 项 | 最终基线（task-68 之后） |
|---|---|
| `pnpm --filter dsh-commander test` | **229/229 PASS**（含 task-68 sessions 测试与 backend 标题快照分块并行护栏） |
| client `lib/client.js` | sha256 **`07d9af06a984e58388531bc47574abd6376204dcffa833b6e746c97e6c3dd8cf`**、**246,540 B**（含 `BINDING_SESSION_LIMIT=20` + truncated 提示；verify-bundle PASS） |
| client harness | **smoke 43/43 + interact 129/129 PASS** |

- 上述最终基线由 tester 独立复跑确认（`229/229`、`43/43+129/129`、sha/size 与 live 安装副本一致）；结论不变：**T65/T66/T67 = PASS**，证据边界披露与 live UI 用户实机确认不变。
- 差异说明：229 较 223 多 task-68 新增会话/标题护栏测试；client 产物较 checkpoint 增 571B（limit=20/truncated 提示）。§1/§2 历史数值保留为 checkpoint，不覆盖。

## 3. Live UI 走查：PASS（用户实机确认，2026-11-18 11:36）
- **用户实机操作**：在 live 页面（origin `http://127.0.0.1:54132`）完成「设置 → 指挥官 → 选择已有会话 → 确认绑定/切换」，确认**绑定与切换可用**（Lead 转述用户原话「绑定和切换可以了」）。
- **tester 独立 API 复核**（Lead 最终 reload 后）：`GET /commander/health` → 200 `panel:present/binding:bound`；`GET /commander/state` → `binding.sessionId=session-5e70318d-7148-4b58-9ce7-80905d5f4e53`（用户切换后保持，未被 reload 重置）、workspaceId=`c83dde64…`；`GET /commander/sessions?workspaceId=…&limit=20` → 200、4 行、`title` 正常（"M1R attach 自定义派发验收"/"Greeting"/"指挥官"/"Greeting"）、`createdAt` 均为数字；tester 计时 0.915s/1.057s/1.200s，Lead 单测 0.181s，均 **<2s 目标**（p95 目标达成）。
- **证据边界**：功能链路（打开选择器→选会话→绑定/切换）由用户实机确认；行级视觉细节（短 id、未命名 muted 样式、相对时间/上下文/创建时间格式）未逐项截图审计（tester sandbox 无法物理点击，Lead 未提供该轮截图）。按「用户实机确认 + API 复核」记 PASS，并保留此边界披露。
- 404/409 错误文案的 live 触发未单独构造（隔离 harness 已覆盖错误码映射；live 未伪造）。

## 4. 结论
- T65（冷会话列表/绑定）、T66（选择器可读化）、T67（sessions 性能）**自动化 + live Host + live UI 用户实机 = PASS**；无 HIGH/MEDIUM/LOW。
- 证据索引：`tests/artifacts/m1/live/t65-bind/**`（隔离 e2e/延迟/Lead live 证据）、`tests/artifacts/m1/live/t66/**`（live sessions/state）、`tests/artifacts/m2/live/t67-perf/**`（live 计时）；用户实机确认由 Lead 转述（11:36）。
- **无开放待办**（仅保留「行级视觉细节未逐项截图」证据边界披露；如需补图，Lead 后续提供即可追加，不影响 PASS）。
