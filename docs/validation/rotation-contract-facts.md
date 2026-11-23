# R1 轮换契约 · 设计与事实核对（文档阶段）

> 日期：**2026-11-19（Asia/Shanghai）**　角色：lead（实现前的事实核对，不是验收）
> 对象：`docs/architecture/rotation-contract-patch.md`（R1 契约）及其对 `implementation-plan.md` / `ARCHITECTURE.md` 的增量
> 目的：在写任何代码前，逐条核对契约依赖的平台/代码事实，并把无法静态证明的项显式列为 UNVERIFIED。
> 约束：只读核对，不改代码、不碰 live DSH。

## 0. 结论

- 契约依赖的 **9 条平台事实、7 条仓库代码事实全部可静态核对**（下表 F*/C*）。
- 契约与**用户三点决策**逐条对应（§4），无冲突。
- 现有基线复跑：**typecheck PASS、单测 306/306 PASS**（§1）。
- 剩余 **5 项 UNVERIFIED**（§6），全部需要在实现后的 e2e / live 中证明；不影响现在定稿契约。

## 1. 环境与基线

| 项 | 值 |
|---|---|
| DSH | `@deepseek-ai/dsh 0.2.2-rc.3`（`$DSH_INSTALL_DIR/package.json`） |
| Node / pnpm | `v22.22.2` / `11.22.0` |
| 仓库 | `/Users/lzx/Documents/GitHub/dsh-commander`，分支 `master`（工作树含历史未提交改动） |
| 复跑 | `pnpm --filter dsh-commander typecheck` → exit 0；`pnpm --filter dsh-commander test` → `# tests 306 / # pass 306 / # fail 0`（2026-11-19 23:2x，耗时 ≈11.1s） |

基线意义：R1 是加法式契约；实现后必须仍以 **306 全绿**为回归下限（新增测试只增不减）。

## 2. 平台事实（DSH 0.2.2-rc.3）

| ID | 事实 | 证据 | 结论 |
|---|---|---|---|
| F1 | `Agent.inject(message)` 加面向模型的上下文、**不唤醒**驱动器 | `$DSH_INSTALL_DIR/node_modules/@deepseek-ai/dsh-agent/src/runtime-types.ts:263-271`；`.../dsh-agent/README.zh.md:58` | Fact |
| F2 | `inject` 的入参是完整 `UserMessage`（含 `source`），可自定义 kind | 同上 `runtime-types.ts:271`；插件现有 `buildContextMessage` 返回 `{id, role, content, source}` 已被 `followup` 用于 live（HANDOVER §5 第 20 条） | Fact |
| F3 | `sessionController.create` 返回前已创建并注册 Agent | `.../dsh-api-session-controller/src/commands.ts:120-159`（`await this.agents.createSession(...)`，取 `created.agent.id`） | Fact |
| F4 | `agents.get(sessionId)` 可取到该 Agent | `.../dsh-agent/src/index.ts:580` `get(id): Agent \| undefined` | Fact |
| F5 | 会话轮换的「不换上下文、只换会话」没有平台捷径：`fork` 复制前缀而非压缩 | `.../dsh-api-session-controller/README.zh.md:69`（Fork 将 `atSeq` 前缀复制到独立 Session）；`.../dsh/docs/subsystems/persistence.zh.md:230`（`ctx.agents.create({sessionId, seed})` 是回放/fork） | Fact（据此否决 fork 方案） |
| F6 | 压缩是摘要替换 surface，且摘要事件只记日志 | `.../dsh/docs/subsystems/compaction.zh.md:11-19` | Fact（据此把简报与压缩解耦） |
| F7 | `session.fork`/`session.create` 均属 Host 服务面，插件可通过 `sessionController`/`agents` 使用 | `commands.ts:120-159`、`agents.get` | Fact |
| F8 | 插件运行在 Host，可用 `ctx.on('session/event')` 观察 `turn/end` | 现有订阅：`packages/dsh-commander/src/host/index.ts:184` | Fact |
| F9 | 无 scheduler 是冻结决策 | `docs/NEXT-PHASE.md:20`（"没有 scheduler、没有结果轮询"） | Fact（据此选懒轮换） |

## 3. 仓库代码事实

| ID | 事实 | 证据 | 结论 |
|---|---|---|---|
| C1 | 上下文注入构造器可复用 | `packages/dsh-commander/src/host/session/deliver.ts:53-69`（`buildContextMessage`：`<system-reminder>` + `source.form='notice'`） | Fact |
| C2 | 换绑会把旧 commander link 标 `missing` | `packages/dsh-commander/src/host/session/binding.ts:139-140`（`markMissing`） | Fact（据此新增 `commitRotation` 绕开） |
| C3 | `sessions.status` 枚举无 `retired` | `packages/dsh-commander/src/host/schema.ts:221-231`、validator `:428-438`；`store/sessions.ts:36-42` | Fact（据此加枚值） |
| C4 | 工具 `when` 动态读当前指挥官会话 | `packages/dsh-commander/src/host/tools/index.ts:639-643` | Fact（换任自动跟随） |
| C5 | system prompt 动态判当前指挥官会话 | `packages/dsh-commander/src/host/session/prompt.ts:44-48` | Fact（自动跟随） |
| C6 | `turn/end` 注入目标动态取 `commanderSessionId()` | `packages/dsh-commander/src/host/index.ts:179` | Fact（自动跟随） |
| C7 | `PUT /commander/config` 严格拒绝未知字段 | `packages/dsh-commander/src/host/api/validation.ts:77-84`（`rejectUnknown`） | Fact（新增字段必须同步校验） |
| C8 | 现有会话只读正文接口可看前任 | `packages/dsh-commander/src/host/api/routes/handlers.ts:419-452`（`handleSessionTranscript`） | Fact |
| C9 | `commands` 表**没有写入点** | `grep -rn "stores.commands\|\.commands\." packages/dsh-commander/src/host` → **0 命中**（2026-11-19） | Fact（简报的用户原话必须从会话事件读，不能依赖该表） |
| C10 | 注入单条上限 8KB，是上下文膨胀主因之一 | `packages/dsh-commander/src/host/config.ts:135-141`、`trigger/injection.ts:60-80` | Fact（R1 的动机补强，不在本契约范围内改动） |

## 4. 与用户决策的映射

| 用户决策 | 契约落点 | 自检 |
|---|---|---|
| D1 默认关；关闭态只有手动「绑定新会话」，且**不做总结** | `rotation.enabled=false`；`POST /commander/binding` 不注入简报；A7 回归用例 | ✅ 无路径冲突 |
| D2 周期 1–7 天，默认 1 | `periodDays` 校验 1..7；纯时间差不依赖时区 | ✅ |
| D3 简报带用户最近原话 | `includeUserTail=true`，≤10 条 / ≤800 字，来源会话事件 `source.kind==='user'` | ✅（不依赖 C9） |
| D4 `turn/end` 触发 + 消息前兜底 | §3.3 A/B 两个触发点；失败不阻塞投递 | ✅ |
| D5 context 注入交付 | §5 `agent.inject` + `buildContextMessage` | ✅（F1/F2/C1） |
| D6 简报=任务罗列+未完成，不做模型总结 | §4 纯函数，无 LLM 调用 | ✅ |
| D7 中途压缩不干预 | 简报只读 `tasks`/会话日志，与压缩无耦合 | ✅（F6） |
| D8 旧会话退役不删除 | `status='retired'` + 不 archive + `mode:'select'` 可绑回 | ✅ |

## 5. 契约自检（一致性）

1. **不新增表**：只加 `config.commander.rotation`、`sessions.status='retired'`、`sessions.generation/retiredAt`（均为既有记录的可选字段）→ 符合 AGENTS「不新增表」。
2. **不新增工具 / 不新增 DSH 事件类型**：简报走 `inject`；`rotation.updated` 是插件自有 SSE 事件，不扩展 `SessionEventMap`。
3. **提交点唯一**：只有 `binding.commitRotation` 写 `config.commander.sessionId`；其余步骤失败不回滚配置（§8.2）。
4. **默认零差异**：`enabled=false` 时无新路由行为、无 SSE、无 UI 入口；`state` 只多只读字段。
5. **门控不会死锁**：失败退避 10min、`force` 手工可绕过退避；周期判定不写盘，跳过可重复。
6. **不接管用户 DSH 视野**：换任后不自动 `openSession`，只推 `rotation.updated` + 面板提示。

## 6. UNVERIFIED（实现后必须证明）

| ID | 待证 | 证明方式 |
|---|---|---|
| U1 | `create` 返回后立刻 `agents.get(newSessionId)` 一定非空 | e2e：stub 模型下 `POST /commander/rotation`，断言未走重试分支即 inject 成功 |
| U2 | 空闲会话 `inject` 的简报会在首个用户 turn 的请求体中可见 | e2e：捕获第二个会话首个 `agent/request` 的 messages，断言含 `[commander-handoff]` |
| U3 | `source.kind='commander-handoff'` 在 DSH 聊天渲染为上下文卡 | live 一次手动换任后查看聊天；不阻塞契约 |
| U4 | 用户在 DSH 里继续对旧（retired）会话说话的影响面 | live 只读观察：新绑定/注入不受影响；面板不展示旧会话 |
| U5 | 换任瞬间与工作会话 `turn/end` 注入的竞态 | e2e：并发触发 work `turn/end` + rotation，断言消息不丢且目标一致 |

## 7. 复跑命令

```bash
cd /Users/lzx/Documents/GitHub/dsh-commander
pnpm --filter dsh-commander typecheck
pnpm --filter dsh-commander test
# 契约文档
sed -n '1,60p' docs/architecture/rotation-contract-patch.md
grep -n "5.6 会话轮换" -A 20 docs/architecture/implementation-plan.md
```

## 8. 结论

**设计可落地，事实核对通过（静态）**。§6 的 5 项是唯一缺口，均为运行时行为，必须在实现后的 e2e/live 证明；在此之前契约中相关段落保持「语义支持 + 待实证」表述，不写成已经验证的结论。
