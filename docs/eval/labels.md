# V5 案例集：选样与标签规则（可复核）

> 对应：`docs/eval/jev-dispatch-eval.md` §2、`docs/architecture/validation-protocol.md` §6.2（P1–P4）。
> 生成器：`tools/eval/build-cases.mjs`（唯一实现；改规则必须同步改本文档）。
> 逐条清单（自动生成，不含任务正文）：`docs/eval/labels.cases.md`。
> 校验器：`tools/eval/validate-cases.mjs`；评估 harness：`tools/jev-eval.mjs`。

## 0. 隐私与使用边界（先读）

- `docs/eval/cases.real.jsonl` 是**本地生成**的：任务文本是用户真实消息，快照含真实会话标题/工作区路径。
- **不提交到远端、不外发**；建议 gitignore（见 §8）。`labels.cases.md`、本文件、`report*.md` 不含任务正文。
- 本目录下的 `report-mock-*.md` 是 harness 自检（mock），**不是**模型能力结果；V5 门禁只看 `report-layered.md`（live）。
- 数据源 `~/.dsh` 全程**只读**；未读取/打印 `~/.dsh/.env`。

## 1. 数据源与池化（Fact）

| 项 | 实测 |
|---|---|
| 工作区清单 | `~/.dsh/storages/workspace.json`：28 个工作区（id/path/title/sessionIds），243 条归档会话 id |
| 会话日志（唯一真源） | `~/.dsh/sessions/<cwd 编码>/<sessionId>/session.v4.jsonl.zstd`，多帧 zstd + JSONL；扫描 976 个会话目录，974 可解析（2 个无规范日志跳过） |
| 会话标题/状态 | header + `session/title` 事件；`session_projcache.json` 的 125 条缓存**均无对应磁盘日志（stale cache）**，不可用于上下文水位 |
| 案例池 | 顶层（无 `parentSession`，排除 401 个 subagent 会话）∧ `header.cwd` 精确匹配某个 workspace.path ∧ 非归档 ∧ 有真实 `user/message`（`data.source.kind === "user"`）∧ 非活跃写入（最后事件 >10 分钟前）→ **252 个会话 / 247 个含 ≥12 字任务的会话** |
| 快照会话数 | 每案例 251–252 条（顶层非归档且 workspaceId 可判定的全部会话） |

说明：未匹配工作区的 cwd（`/tmp`、harness 安装目录、远端临时目录等）无法给 `workspaceId`，整会话不进入候选池；这不是“挑选”，是 schema 要求（`sessions[].workspaceId` 必填）。

## 2. 标签规则（工作区 / 模式）

### 2.1 工作区标签（Fact，非先验）

- 规则：`expected.workspaceId = workspace.json` 中 `path` 与 `session.header.cwd` **精确字符串相等**的那个工作区 id。
- **不使用**“最近会话”“标题词面匹配”“用户习惯”等先验；路径映射是数据字段本身。
- 证据：`labels.cases.md` 每条含 `源会话 + 规则`；`cases.real.jsonl` 每条 `expected.workspaceId` 必在 `workspaces` 快照内（`validate-cases.mjs` 校验）。

### 2.2 模式标签（回放语义）

- 场景时间：**dispatchTime = 生成时刻**（案例生成是“此刻派发这条真实历史任务”）。快照就是此刻的真实工作区/会话。
- 规则：
  - 该用户消息是该会话的**首条真实用户消息** → `mode = new`，`sessionId` 缺省；
  - **非首条** → `mode = attach`，`expected.sessionId = 该会话`。
- 依据：用户当时选择在该会话内继续，等价于“这条任务附着到该会话”；首条消息则说明会话是被这条任务新建的。
- 标注：**Inference**（不是绝对真值）。对话历史里没有“如果此刻派发会选哪个会话”的信息；该规则只能保证“不依赖最近会话/词面匹配”，无法保证与用户此刻真实意图一致。所有 attach/new 案例都因此需人工抽检（§6）。

## 3. 六层选样规则（只用结构字段，确定性）

选样顺序（先稀缺层，避免覆盖层吃光候选）：`should-ask → old-session → new-session → capability → ambiguous → obvious`；每层内部按 `sha1(seed + sessionId)` 排序，保证**同 seed 可复现**；一个会话最多一条案例。

| 层 | 数量 | 选样规则（可复核） | 期望标签 | 候选池 / 置信度 |
|---|---|---|---|---|
| 明显工作区 `obvious` | 12 | 该会话**首条**真实用户消息 ≥20 字，且文本点名本工作区名称（工作区 path basename / title 的小写 token，长度≥4；排除 test/workspace/project/agent/github/documents/app/dev/probe 等通用词） | new（按 §2.2），工作区 cwd 映射 | 16 / high |
| 跨工作区歧义 `ambiguous` | 12 | 任务文本“可能落在”≥2 个工作区：工作区名命中 **或** 与该工作区已有非归档会话标题有词交集（同一工作区需 ≥2 条标题命中，避免单词噪声） | 按 §2.2；工作区仍取 cwd（Fact，不是从文本推出） | 119 / medium |
| 旧会话相关 `old-session` | 10 | 相关会话（源会话）最后活动在 **7–30 天前**（相对 dispatchTime），且该会话非首条消息（attach 回放语义），且存在更新、工作区不同的其它会话（“最近会话先验”会选错的陷阱） | attach 到该旧会话 | 113 / medium |
| 应新建 `new-session` | 6 | 首条用户消息、且同工作区存在**标题词相似**的已有会话（即“没有合适已有会话”的近似：有诱惑 attach 目标但仍应新建），且文本未点名本工作区 | new | 175 / low |
| 能力驱动 `capability` | 5 | 任务文本显式点名能力/工具关键词（playwright / figma / 浏览器 / mcp / skill / 插件 / ollama / tts / 语音 / 重排 / ssh / desktop …）。**capabilityDigest 不可得 → 降级为“无能力签名近似层”**（§4） | 按 §2.2 | 92 / low |
| 应询问 `should-ask` | 5 | 低信息量真实用户消息：trim 后 ≤30 字、命中泛化表达（继续/好/可以/开始/修/看看/跑一下…）、未点名任何工作区 | `needs_confirmation`（见 §5.2） | 5 / low |

合计 50；分层 12/12/10/6/5/5；模式 new=25 / attach=25；覆盖 15 个工作区（真实分布，未做均匀化）。
每条案例的 `expected.note` 与 `labels.cases.md` 都写明：规则、标注者（`build-cases.mjs` 确定性规则）、confidence、needsReview。

## 4. 能力驱动的降级（必须知道）

- 设计要求的 `capabilityDigest`（每个工作区的能力摘要）**在现有数据源里不存在**：`workspace.json` 只有 `{path,title,sessionIds,createdAt,updatedAt}`；`session_projcache` 无能力字段（且已确认是 stale cache）。
- 离线能力面板探针（`docs/research/capability-panel-api.md`：`panel.skills/tools/mcp` 枚举，不需 key）**本轮未执行**（时间盒内优先保证 live 门禁与报告）。
- 因此“能力驱动”层实际测的是：任务点名能力时，Jev 能否仍按任务文本选对工作区/会话。**没有能力签名参与判定**，故该层 5 条全部 `confidence=low`、`needsReview=true`、tag `capability-approx`；报告不把该层结果当作能力路由结论。

## 5. 已知风险与近似（如实记录）

1. **标题终态泄漏**：会话标题/水位只能取当前终态（数据源没有历史快照）。attach 案例的目标会话标题可能已包含这条任务之后的内容 → 有利于模型，但也可能误导；不影响“工作区=cwd”标签。→ 所有 attach 需人工抽检。
2. **上下文水位全缺**：`session_projcache` 125 条缓存均无对应日志（stale），所以 `sessions[].contextUsage` 在 cases 中**全部缺省**；“应新建”层无法按设计用“上下文 >85%”判定，降级为 §3 的结构启发式（low confidence）。
3. **快照=此刻，不是“用户当时”**：dispatchTime 统一取生成时刻，历史任务文本 + 此刻会话列表。对“旧会话”层这是有意为之（旧会话存在但期望仍 attach），对其它层会带来“现在更合适的会话”与历史回放语义的偏差。
4. **应询问的表示**：`cases.schema.json` 的 `expected.mode` 只有 `new|attach`，没有 `needs_confirmation`。本轮用 tag `should-ask` + `expected.note` 表达；harness 对 should-ask 案例**不计入 Top-1 分母**，被自动派发放行即计 precision 错误。
5. **工作区无 summary**：`workspace.json` 没有职责摘要，harness 只能给 Jev 名称/路径/最近 5 条会话标题（真实数据派生）。真实 Commander 会维护工作区摘要/能力，**这会显著影响 live 指标的可外推性**（报告 §7 分析）。
6. **归档会话不在快照**：243 条归档会话被排除（协议要求“全部非归档会话”）；历史任务若与归档会话相关，标签可能偏“new”。
7. **单一 seed 的确定性选样**：不是随机抽样；换 seed 会换案例（命令见 §7）。

## 6. 标注质量与人工复核清单

| 置信度 | 数量 | 层 |
|---|---:|---|
| high | 12 | obvious（12） |
| medium | 22 | old-session（10）+ ambiguous（12） |
| low | 16 | new-session（6）+ capability（5）+ should-ask（5） |

**需人工复核：38 条**（即除 obvious 外全部）。逐条 id/源会话/规则/置信度见 `docs/eval/labels.cases.md` 的表格（`需复核=是`）。

复核建议（由 lead 抽样仲裁 + tester 审计，本轮未完成）：

1. 用源会话 id 在本地打开 `~/.dsh/sessions/**/<sessionId>/` 的日志（只读）核对任务文本与上下文；
2. 逐条判定：工作区标签是否合理；new/attach 是否符合“此刻派发的真实意图”；should-ask 是否真的应询问；
3. 重点抽检：old-session（10，含 7–30 天窗口判定）、new-session（6，启发式）、should-ask（5）；
4. 复核结论写回 `labels.cases.md` 对应行或另建 `labels.review.md`（本轮未产出人工复核结果；**这不是 PASS 证据**）。

## 7. 复现与校验

```bash
# 生成 50 条案例（只读 ~/.dsh；--diagnose 只看候选可得性，不写盘）
node tools/eval/build-cases.mjs --home ~/.dsh \
  --out docs/eval/cases.real.jsonl --labels-out docs/eval/labels.cases.md
node tools/eval/build-cases.mjs --diagnose

# schema + 分层计数校验（退出码 0=通过）
node tools/eval/validate-cases.mjs docs/eval/cases.real.jsonl
```

实测（2026-11-17，seed=`v5`）：50 行全部通过 `cases.schema.json`；分层 12/12/10/6/5/5；attach 案例 `expected.sessionId` 均在快照内。

## 8. 隐私 / git

- `docs/eval/cases.real.jsonl`（约 3.1 MB）含真实任务文本与全部非归档会话标题 → **本地生成、不提交远端、不外发**。
- 建议在 repo 根 `.gitignore` 加一行 `/docs/eval/cases.real.jsonl`（本任务未改 `.gitignore`，交由 lead 统一处理，避免多人抢写）。
- `report*.md` / `labels*.md` 只保留指标、工作区名、规则与短摘要，不含任务正文；live 报告中所有概率/阈值均为真实运行结果（未伪造）。
