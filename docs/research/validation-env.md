# 验证环境取证（V0 · A/B/C/D）—— 隔离 DSH 探针 Host 可复现配方

> 取证角色：scout（只读）。取证时间：2026-11-17 16:16–16:35（Asia/Shanghai）。
> 工作区：`/Users/lzx/Documents/GitHub/dsh-commander`。写作用域：`docs/research/**`。
> 标注约定：**【Fact】**= 源码/命令直接可证；**【Inference】**= 由多条实证推出、未在运行态逐项验证；**【Unverified】**= 需实测或需授权。
> 路径缩写：`CLI` = `/Users/lzx/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh`；`A` = `CLI/node_modules/@deepseek-ai`；`LIVE` = `/Users/lzx/.dsh`；`DESK` = `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`。

---

## 0. 一句话结论（给 devops 的起手式）

**可以完全隔离启动探针 Host，且不需要网络、不需要写 `~/.dsh`：** 用 `DSH_HOME` + `DSH_AGENTS_HOME` 指向 `/tmp` 一次性目录，profile 用 shipped 模板（`base`/`web`），能力面板用「符号链接 live desktop profile 的 node_modules」加入，探针插件用 `--patch` 里 `file://` 绝对路径插入。已实测 base（headless 式无 UI）与 web（有 HTTP/UI）两种启动，liveness 正常、`capabilityPanel` 可调用、`sessionController.create` 可用、`jev.apply` 真实写入并落盘。

```bash
# 完整 60 秒复现（详见 §E.1；退出码与输出见 docs/research/probes/evidence/）
export DSH_HOME=/tmp/dsh-commander-probe/home DSH_AGENTS_HOME=/tmp/dsh-commander-probe/agents
dsh plugin --profile scout version-exemptions                       # 建 profile（DEFAULT_PROFILE_BUNDLES = base）
ln -s ~/.dsh/profiles/desktop/node_modules/dsh-capability-settings \
      $DSH_HOME/profiles/scout/node_modules/dsh-capability-settings # 只读复用包
# 把 dsh-capability-settings 加进 profile 的 dsh.profile.bundles，再：
dsh --profile scout --patch /Users/lzx/Documents/GitHub/dsh-commander/docs/research/probes/probe.patch.yml
```

---

## 1. 事实底盘（版本 / 安装形态）

| 事实 | 证据 | 标注 |
|---|---|---|
| 全局 CLI = `0.2.2-rc.2`，由 `~/.local/bin/dsh` shim 固定用 node v24.19.0 运行 | `dsh --version` → `0.2.2-rc.2`；`cat ~/.local/bin/dsh` | **Fact** |
| 运行中的 Desktop = `0.2.2-rc.3`（`Info.plist CFBundleShortVersionString`） | `plutil -p "/Applications/DeepSeek Harness.app/Contents/Info.plist"` | **Fact** |
| 探针 Host 运行时是 node v24.19.0（不是 shell 里的 v22） | 探针插件证据 `plugin-boot.json.node = v24.19.0` | **Fact** |
| desktop profile 里装的是 `dsh-capability-settings@1.19.3`（GitHub 依赖 `github:xx529/dsh-capability-settings#v1.19.3`） | `LIVE/profiles/desktop/node_modules/dsh-capability-settings/package.json`；`LIVE/profiles/desktop/package.json` | **Fact** |
| 面板声明 `engines.dsh = ">=0.2.0-rc.2 <0.3.0"`，故 rc.2 CLI 可加载 rc.3 安装里的 v1.19.3 包 | 同上 `package.json` + 实测启动成功 | **Fact** |
| 探针全程无进程残留（每次启动都把 pid `kill -0` 验证为 no；`ps` 被沙箱禁止，未用 ps 复核） | `docs/research/probes/evidence/*.pid` 与启动日志 | **Fact**（就探针自身） |

**关键含义**：V0–V4 可以在 rc.2 CLI 上验证；rc.2/rc.3 的 API 差异对 `capabilityPanel` / `sessionController` 这几条链路为 0（面板代码是 profile 级 GitHub 包，与 CLI 版本解耦）。**【Inference】** 但 V7（Desktop 内 `dsh-app://` 反向代理）与 Desktop 壳相关，只能在 live Desktop 或 Electron 壳里验，不属于探针 Host 范围。

---

## 2. A. 探针环境（怎么起、能不能加载本地插件）

### A1. 结论

**能。** 隔离启动成功 3 次（base ×3、web ×3，含一次 30s 常驻 HTTP 探活），不触碰 live Desktop。

### A2. CLI 语义（全部源码级 Fact）

| 问题 | 结论 | 证据 |
|---|---|---|
| `dsh <name>` 等价于 `dsh --profile <name>` | 是 | `CLI/src/args.ts:206-209` |
| profile 必须在 `$DSH_HOME/profiles/<name>` 下 | 是 | `A/dsh-app-boot/src/profile.ts:165-172`（`resolveProfileDir`） |
| profile 必须是 shipped 名或已初始化 | shipped 名（`acp/web/headless/sdk/sdk-minimal`）首次启动自动 `initProfile`；**自定义名不存在时抛错**，需 `--from-default-profile <shipped>` 或先 `dsh plugin --profile <name> …` 初始化 | `profile.ts:728-745`；`A/dsh-official-bundles/src/bundles.ts:10-26`；`profile.ts:198-217` |
| shipped 模板位置 | `A/dsh-official-bundles/src/bundles.ts:10-26`（`PROFILE_TEMPLATES`）；无模板名用 `DEFAULT_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base']`（`:45`） | **Fact** |
| `--patch <file>` 覆盖层 | 在 profile 层之后、telemetry 开关之前叠加；可重复；launcher flag 必须写在内层 app 参数之前 | `CLI/src/args.ts:168-173`、`CLI/src/profile-boot.ts:211-236` |
| 本地插件必须打成包吗 | **不必**。patch 行 `name:` 用 `file://` 绝对 URL 即可；也支持包名（从 profile 作用域 `import.meta.resolve` 解析） | 实测：`probe.patch.yml` 的 `name: 'file:///…/probe-plugin.mjs'` 正常挂载；解析机制 `A/cordis-plugin-loader/src/resolve.ts:66-75`、`profile.ts:678-713` |
| `--dump-config` | boot-free 打印合成后的 entry 列表，用于先验证 patch 是否生效（不挂载、不写状态） | `CLI/src/args.ts:111-135`；实测输出 `docs/research/probes/evidence/dump-config.yml:374-379` 可看到探针行 |
| home 级 patch | `$DSH_HOME/cordis.patch.yml` 会叠加到**每个** profile 之上（这台机器 `LIVE/cordis.patch.yml` 不存在，故无隐藏叠加） | `profile-boot.ts:213-217`、`homePatchPath()` `:73-75` |
| launcher 给内层 app 的事实 | `ctx.cmdlineArgs`（内层参数）、`ctx.appExit(code)`（有序退出）、`ctx.appReady` | `A/dsh-cmdline/src/index.ts:84-89`；探针实测 `typeof appExit === 'function'` |

**实操注意**：launcher 只解析到第一个它不认识的 token，之后全部交给内层 app。所以 `dsh --profile web --port 0 --patch x.yml` 会把 `--patch` 当成 web 的参数 → `error: unknown option '--patch'`（实测踩过，`docs/research/probes/evidence/` 外的 boot-web-stock.err 首轮日志）。**`--patch` 必须写在 `--port` 等内层参数之前**。

### A3. 能力面板如何进入探针 Host（不安装进 live profile）

三条路，实测选 ①：

| 方案 | 做法 | 结论 |
|---|---|---|
| ① 只读符号链接（推荐） | `ln -s ~/.dsh/profiles/desktop/node_modules/dsh-capability-settings $DSH_HOME/profiles/<p>/node_modules/dsh-capability-settings`，并把 `dsh-capability-settings` 加进 profile 的 `dsh.profile.bundles`（或直接用 `--patch` 插一行 `name: 'dsh-capability-settings'`） | ✅ 实测成功（base 与 web 都成功）。Node 以 realpath 解析依赖 → 面板的 4 个宿主依赖（`yaml`、`@modelcontextprotocol/client`、`@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-mcp-client`）全部从 live profile 的 hoisted `node_modules` 只读解析，**无需 pnpm、无需网络** |
| ② 复制包进探针 profile | `cp -R` 包目录后需自行补齐上述依赖 | 可行但更重（5.3MB + 依赖），未采用 |
| ③ github/npm 安装 | `dsh plugin --profile <p> add github:xx529/dsh-capability-settings#v1.19.3` | 需网络 + pnpm，未采用；**【Unverified】** 网络可用性（本轮未测） |

**包内依赖事实**（`package.json.dependencies`）：`@modelcontextprotocol/client@2.0.0`、`yaml@^2.4.2`、`@deepseek-ai/dsh-home-paths@^0.2.2-rc.1`、`@deepseek-ai/dsh-mcp-client@^0.2.2-rc.1`；host 半静态 import 只有前三个（`lib/mcp/manager.js:19 → probe.js:27-28`），`dsh-mcp-client` 是 `loader.import()` 动态解析（`lib/mcp/loader.js:160,169`），探针不建 MCP/agent 时不会触发。**【Fact】**

**探针看到的能力面板服务面**（`plugin-boot.json`，web/base 一致）：

```
capabilityPanel = function（工厂 thunk！见 §4）
service keys = jev, mcp, mcpTools, overrides, prompt, session, skills, tools
jev keys     = apply, dispose, getConfig, rank, setConfig, test
```

### A4. 实测启动清单

| # | 场景 | 命令要点 | 结果 |
|---|---|---|---|
| 1 | base profile 隔离启动 | `DSH_HOME=/tmp/dsh-commander-probe/home dsh --profile scout --patch probes/probe.patch.yml` | exit 0；日志 `[scout-probe] capabilityPanel=present keys=[…]`；证据 `evidence/boot-base.out`、`plugin-boot.json` |
| 2 | base + `DSH_AGENTS_HOME` 隔离 | 追加 `DSH_AGENTS_HOME=/tmp/dsh-commander-probe/agents` | 枚举到的 skills 由 **176 → 1**，证明 `~/.agents` 是独立根（见 §3） |
| 3 | web profile（custom 副本 `webtest`） | `dsh --profile webtest --patch probes/probe.web.patch.yml --port 0 --no-open` | `dsh web: http://127.0.0.1:62983/?token=…`；`capabilityPanel=present`；`sessionController=object` |
| 4 | web profile（shipped 名，HTTP 探活） | `dsh --profile web --port 0 --no-open` + `curl -L -b/-c jar` | `GET /?token=…` → **HTTP 200, 41120 bytes, 15.8ms**，`<title>DeepSeek Harness</title>`；无 token → **401**；进程按需 kill |
| 5 | V3 链路（`sessionController.create` + 面板 apply） | `dsh --profile webtest --patch probes/probe.v3.patch.yml --port 0 --no-open` | create 返回 `{sessionId, agentPreset}`；`panel.jev.apply` 对真实会话返回 `{ok:true, applied:1, disabled:1, pending:false, elapsedMs:17}`，磁盘出现 `$DSH_HOME/dsh-capability-settings/session-capabilities.json`（见 §4.4） |

### A5. web 探针的一个已知坑（必须记录）

直接以 stock `web` 模板启动会有一条 **1 entry did not activate** 告警：

```
ui-chat (@deepseek-ai/dsh-client-ui-chat): failed to import:
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-client-ui-chat'
imported from /tmp/…/profiles/web/
```

- **原因**：`dsh-client-ui-chat` 不是 CLI 安装包（`@deepseek-ai/dsh`）的直接依赖，而是 `dsh-web-app` 的依赖；客户端模块行按 profile 作用域解析，运行态映射没覆盖它。**【Fact】**（`CLI/package.json` 无该依赖；`A/dsh-web-app/package.json:87` 有）
- **修复**：把该包从安装目录只读符号链接进探针 profile：
  `ln -s CLI/node_modules/@deepseek-ai/dsh-client-ui-chat $DSH_HOME/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-chat`
  修复后同一命令 stderr 空（`evidence/boot-web-after-chat-symlink.err` 为 0 字节）。
- **影响**：只影响浏览器侧的 chat UI 组件；**不影响 Host 侧 capabilityPanel / sessionController / HTTP / SSE**。若 devops 只需要 V1–V4，用 base profile 即可，无需理会。

---

## 3. B. 隔离与安全（哪些做到了，哪些是边界）

### 3.1 已实现的隔离

| 项 | 证据 |
|---|---|
| 全部 profile / 会话 / 存储 / 面板配置写在 `/tmp/dsh-commander-probe`（1.2MB） | `du -sh /tmp/dsh-commander-probe`；`find` 清单见 §E.2 |
| live desktop profile 文件清单 hash **前后完全一致** | `pre-state.txt` / `post-state.txt`：树 hash 均 `5d9f1717…8d9`；顶层 mtime hash 均 `4b17296c…130a`；`node_modules` 顶层条目数均 380 |
| `~/.dsh/.env` 未被读写 | stat 前后一致：`/Users/lzx/.dsh/.env|858|1791515016` |
| 未新增/修改 `~/.dsh` 下任何文件 | 探针前后 `~/.dsh` 顶层未见新目录（探针目录只在 /tmp）；全程未执行 `dsh plugin --profile <x>` 于 `DSH_HOME=LIVE` |
| 未重启/关闭 live Desktop | 未执行任何 app 级操作；live 会话仍是本会话 |
| 网络：**零出站请求**（探针未带有效 key，未触发 Jev/模型调用） | rank 在无 key 时提前 return `no-config`（`lib/jev/manager.js:144-148`），不会发请求 |

### 3.2 隔离必须同时设两个根（重要）

- `DSH_HOME` 只隔离 home 数据（sessions/storages/profiles/面板配置）。**【Fact】**
- `~/.agents`（`AGENTS_HOME`）是**独立根**：能力面板枚举 skills 时会读 `$DSH_AGENTS_HOME/skills`，未设置时读 live `~/.agents/skills` → 实测枚举从 176 条降到 1 条（剩下的 1 条来自 `~/.claude/skills`，该路径写死 homedir，不可隔离但只读）。**【Fact】**
  - 证据：`plugin-boot.json.panel.enumSurface.skillsListView.skills = 176`（未设）vs = 1（设了 `DSH_AGENTS_HOME`）；`panel.enumSurface.skillsList.sample=["ui-ux-pro-max"]`。
  - `lib/skills/manager.js:52` 三个 root：`user-dsh`（dshHome）、`user-agents`（agentsHome）、`user-claude`（homedir）。
- 项目层 `.env`：launcher 会读 **cwd/.env**（本项目无 `.env`，已用 `ls` 确认）。若在别的目录启动，注意该文件会被当作 project 层。**【Fact】**（`A/dsh-app-boot/src/index.ts:263-264`）
- 安装锚：探针仍从 CLI 安装解析 bundle 包（`resolutionOptions.installAnchor`，`profile-boot.ts:232-235`），这是只读的。**【Fact】**

### 3.3 被安全策略挡住、需要授权的两件事

1. **在探针 `$DSH_HOME` 下创建 `.env`** 被 CC Safety Net 拦截（规则 `secret.basename.env`，任何 basename 为 `.env` 的写入都拒）。→ 因此「`$DSH_HOME/.env` 被 launcher 读进 process.env」这条**只有源码级 Fact + 继承 env 的运行时旁证**，缺一条 `$DSH_HOME/.env` 的运行时直证（见 §5 D 节）。**不建议绕过安全网**；替代方案见 §5。
2. **需要真 Jev key 的 rank 直连测试**（一次最小计费调用）：需要把 key 放进探针进程环境或探针 home 的 `dsh-capability-settings/jev.json`（该文件可写、无安全网限制，但 key 明文落盘）。需要 Lead/用户决定（最小写入面见 §5.3）。

---

## 4. C. V5 真实数据源盘点（能否构造 50 条真实派发案例）

### 4.1 数据在哪（全部只读、格式已实测解析）

| 数据 | 路径 | 格式 | 规模（本机实测） |
|---|---|---|---|
| 工作区清单 + 归档会话 | `~/.dsh/storages/workspace.json` | JSON：`{unit:{name,version}, global:{initialized, workspaceIds[28], archivedSessionIds[243], pinnedSessionIds, archivedMeta}, tables:{workspaces:{id:{path,title,sessionIds,createdAt,updatedAt}}}}` | **28 工作区 / 243 条已归档会话 id** |
| 会话列表（标题/上下文压力/水位） | `~/.dsh/storages/session_projcache.json` | JSON：`tables.sessions[sessionId] = {identity:{createdAt,cwd}, rows:{title.val, sessionStats{turns,steps,…}, tokenUsage{totals{…}}, contextPressure{pressureTokens,contextWindow}, sessionListMetadata{blank,lastPromptAt}, …}}` | **125 条**缓存（116 条有 title、125 条有 `contextPressure`、116 条有 `lastPromptAt`） |
| 会话日志（唯一真源） | `~/.dsh/sessions/<cwd 编码>/<sessionId>/session.vN.jsonl.zstd` | **多帧拼接 zstd** + JSONL；首行 header：`{type:"session", version:4, id, createdAt, cwd, parentSession, isSeeded, origin, delegationDepth, agentPreset}`；事件类型实测含 `turn/start|end`、`user/message`、`assistant/message`、`system/message`、`session/title`、`tool/*` 等 | **44 个 cwd 父目录 / 976 个会话目录 / 974 个成功解析**（0 失败，2 个无规范日志）；893 个有 user/message；401 个带 `parentSession`（子会话） |
| 会话 cwd → 工作区映射 | 上述两者组合 | header.cwd 与 `workspaces[].path` 精确比对 | 40 个 distinct cwd，其中 **28 个精确匹配工作区 path**，覆盖 878/976 会话；其余 12 个 cwd 为「工作区子目录（2 个）/ 其它 harness 安装（如 HtDot dev home）/ 临时目录（/tmp、TMPDIR）」，属噪声 |
| Jev 面板配置 | `~/.dsh/dsh-capability-settings/jev.json` | JSON，261B，**无明文 key**（只存 `apiKeyEnv`） | 见 §5 |

**读取工具已就绪**（本轮落盘，devops 直接用）：
- `docs/research/probes/read-session-log.mjs`：解析多帧 zstd 会话日志 → 事件数组/结构摘要（复刻 DSH 自己的 `scanZstdFrames + 逐帧解码` 策略，`A/dsh-session-persistence-jsonl/src/zstd.ts`、`zstd-public-decoder.ts`）。
- `docs/research/probes/inventory-v5-data.mjs`：一条命令产出全量结构统计（**只输出结构与计数，不输出标题/正文**）→ `docs/research/probes/data-inventory.json`（33KB）。
- 复现：`node docs/research/probes/inventory-v5-data.mjs --home ~/.dsh --out /tmp/inv.json`（只读，耗时约 23s）。

### 4.2 期望标签可推导性（逐项判定）

| 标签 | 可否从真实数据推导 | 方法与风险 | 标注 |
|---|---|---|---|
| **workspaceId** | ✅ 可以 | `session.header.cwd` 与 `workspace.json.tables.workspaces[].path` 精确匹配（或子目录归属）；本机覆盖率 878/976=90%，且 28 个工作区全部有会话、可直接取真实快照。风险：12 个 cwd（98 会话）属于其它 harness/临时目录，需按 path 白名单过滤；工作区 `path` 存在但目录可能已删除 → 需 realpath 存在性检查 | **Fact**（字段+覆盖率实测） |
| **mode=attach（复用旧会话）** | ⚠️ 部分可推导 | 「有候选附件会话」可由 `session_projcache`（title/contextPressure/lastPromptAt）+ 会话日志的 user/message 抽取得到；但**「这条任务是否应该 attach 到某旧会话」是语义判断**，无法从结构字段自动得出，必须人工标注或用 LLM 标注再人工复核（否则评估自我实现）。可用 `parentSession` 区分「子会话」但不是 attach 语义 | **Inference** |
| **mode=new** | ⚠️ 部分可推导 | 当候选集为空、或上下文水位 ≥85%（`contextPressure.pressureTokens/contextWindow`）时可**规则化**判「应新建」，属结构启发式而非真值；需人工抽检 | **Inference** |
| **明显工作区 / 跨工作区歧义 / 旧会话相关 / 应新建 / 能力驱动 / 应询问**（六层） | ⚠️ 可分层选样，不可自动定标 | 选样规则可全部基于真实字段：<br>· 明显：cwd→工作区唯一且 title 关键词命中该工作区领域的会话（关键词表人工建）<br>· 歧义：同一任务文本能匹配 ≥2 个工作区（需构造跨区任务）<br>· 旧会话：`lastPromptAt` 距今 7–30 天的会话<br>· 应新建：`contextPressure` ≥85% 的会话<br>· 能力驱动：`panel.skills/tools` 枚举（隔离 Host 里可跑，见 §4.4）+ 工作区 `capabilityDigest`（**当前数据里没有该字段，需另算**）<br>· 应询问：低信息量任务文本（人工构造） | **Inference** |
| **期望 sessionId（attach 真值）** | ❌ 不能 | 真实历史上「用户当时确实发了这条任务」才有唯一真值；从历史回放无法知道「假如现在派发会选哪个会话」。建议：把 attach 类案例的期望标签**人工双人标注 + 一致性检查**，或明确降级为「评测只用于校准阈值，不作为自动上线唯一依据」 | **Unverified** |

### 4.3 关键障碍（必须让 Lead 知道）

1. **能力摘要 `capabilityDigest` 不在现有数据源里**：`docs/eval/jev-dispatch-eval.md:34` 要求快照含每个工作区的 `capabilityDigest`，但 `workspace.json` 只有 `{path,title,sessionIds,createdAt,updatedAt}`。能力摘要要么现场用隔离 Host 的能力面板枚举（能跑，见 §4.4），要么由 commander 自己维护映射。**评估脚本的入参结构需要按实际可得字段改**。
2. **会话标题/上下文水位有两套来源且不一致**：`session_projcache.json` 只有 125 条（缓存是后加的/部分），`sessions/**` 有 976 个目录。建议**以会话日志为唯一真源**（header + `session/title` 事件 + `contextPressure` 事件若有），缓存只做加速。**【Inference】**
3. **`session_projcache.json` 的 `contextPressure.contextWindow` 是采样值**（还有 `sampledSurfaceTokens`），跨模型不可比；分层选样要用 `pressureTokens/contextWindow` 比值并记录模型。**【Inference】**
4. **隐私**：会话日志含完整用户消息与工具输出。V5 报告只应落案例文本（派发任务本就是人写的），**不要把历史会话正文导出到仓库**；`data-inventory.json` 已按此原则只留结构。

### 4.4 能力面板在探针里能否提供「能力摘要」：能

隔离 web 探针里对真实新会话实测（证据 `evidence/v3.json`）：
- `panel.skills.sessionListView(cwd, sessionId)` → `{skills: 6, hiddenCount: 0}`（隔离 `DSH_AGENTS_HOME` 下）
- `panel.tools.list()` → 15 个 tool unit（base+web 组合）
- `panel.mcp.runtime({cwd})` → `{servers: 0}`（探针 home 无 MCP 配置）
- `panel.jev.apply({sessionId, plan: []})` → `{ok:true, applied:1, enabled:0, disabled:1, pending:false, elapsedMs:17}`，落盘见 §5.4

**结论**：V5 的「工作区能力摘要」可以由一个**离线的能力面板探针**批量生成（`enumerate` 不需要 Jev key，只有 `rank` 需要），不必依赖 live Desktop。

---

## 5. D. Jev 凭据与 .env 加载

### 5.1 `.env` 是否进插件 process.env —— 机制（Fact）

`@deepseek-ai/dsh-app-boot` 的 `loadLayeredEnv('dsh')`（`A/dsh-app-boot/src/index.ts:256-277`）：

1. 层顺序（信任度从高到低）：**inherited `process.env`** → **`cwd/.env`** → **`$DSH_HOME/.env`**；
2. 两个文件都先解析校验，再统一 materialize：`if (process.env[name] === undefined) process.env[name] = value`（`:266-271`）——**被加载的值确实复制进 `process.env`**，插件进程能直接读到；
3. 但禁止 `bootstrap-only` 名字（`DSH_*`、`XDG_*`、`DYLD_*`、`BASH_FUNC_*` 前缀 + `PATH/NODE_OPTIONS/HTTP_PROXY/…` 白名单，`:134-158`）；`HOME_PROXY`/`DEEPSEEK_BASE_URL` 等仅允许出现在 home 层；
4. 若 `cwd === $DSH_HOME`，home 层不重复加载（`:264`）。

### 5.2 运行时实测

| 测试 | 结果 | 标注 |
|---|---|---|
| inherited env 能否被插件看到 | `JEV_API_KEY=…` 在命令前导出 → 插件内 `!!process.env.JEV_API_KEY = true` | **Fact**（`plugin-boot.json.envBools`） |
| 未导出的 key | `TYPESAFE_API_KEY = false` | **Fact** |
| launcher 自带变量 | 插件进程可见 `DSH_HOME/DSH_INSTALL_DIR/DSH_NODE_EXECUTABLE/DSH_PROFILE/DSH_PROFILE_DIR/DSH_SESSION_ID/DSH_SHELL/DSH_USER_AGENT_SUFFIX/DSH_WEB_URL` | **Fact** |
| `$DSH_HOME/.env` 直证 | **被安全网拦截**（`secret.basename.env`，禁止创建任何 `.env`），未做 | **Unverified**（机制有源码 Fact，运行时缺直证） |

### 5.3 想用真 key，最小可行路径（需 Lead 选一）

| 方案 | 需要的授权/动作 | 写入面 | 评价 |
|---|---|---|---|
| **① 操作者导出环境变量**（推荐） | 由用户/Lead 在终端里 `export TYPESAFE_API_KEY=…`（或 `set -a; . ~/.dsh/.env; set +a`，shell 自己读文件，agent 不读）后跑探针命令 | **0 写入** | 最干净；不落盘、不进仓库 |
| ② 写探针 home 的 `jev.json.apiKey` | 无安全网限制，但 **key 明文落盘 /tmp** | `/tmp/dsh-commander-probe/home/dsh-capability-settings/jev.json` | 仅当用户同意临时落盘；用完 `rm` |
| ③ `DSH_HOME=~/.dsh` 复用 live `.env` | **需要写 `~/.dsh`**：`dsh plugin --profile <probe> version-exemptions` 会在 `~/.dsh/profiles/<probe>/` 建 3 个文件；且每次 boot 会写 `cordis.yml`。**必须 Lead/用户明确授权** | `~/.dsh/profiles/<probe>/{package.json,cordis.patch.yml,pnpm-workspace.yaml,cordis.yml,node_modules/**}` | 最省事但污染 live home；**不推荐**，且 live `.env` 含其他敏感 key |

> 方案 ③ 的替代：`DSH_HOME=~/.dsh` + 已存在的 shipped profile（如 `headless`/`web`）仍会写 `~/.dsh/profiles/headless/cordis.yml`，同样算写入 live home，故也需授权。

### 5.4 Jev 实际配置（可读，无明文 key）

`~/.dsh/dsh-capability-settings/jev.json`（261B，**【Fact】**）：

```json
{ "baseURL": "https://api.typesafe.ai", "model": "jev-latest", "apiKeyEnv": "TYPESAFE_API_KEY",
  "autoTrigger": {"enabled": true, "pauseMs": 1000, "minChars": 10, "minEditChars": 4},
  "decisionThreshold": 0.7, "timeoutMs": 30000 }
```

- **没有** `apiKey` 字段 → key 只可能在 env（`TYPESAFE_API_KEY`）里。**【Fact】**
- 探针 home 无此文件时用默认值：`decisionThreshold 0.5`、`autoTrigger.enabled false`，其余相同（`lib/jev/types.js:defaultJevConfig`；运行时见 `plugin-boot.json.panel.jevGetConfig`）。
- 未发起任何真实计费调用。网络连通性**未测**（V5 需要时再测，属计费动作）。

---

## 6. A5. live 未受影响的证据（原始文件）

- `docs/research/probes/pre-state.txt` / `post-state.txt`：`git status`、git rev、desktop profile 树 hash、顶层 mtime hash、`.env` stat、node_modules 条目数。
- 比对结果：**除本次新增的 `docs/research/`（我的产出）与 `docs/architecture/`（其他 teammate 产出）外，hash 全等**；`.env` stat 全等。
- 未执行：重启/关闭 Desktop、写 `~/.dsh`、`dsh plugin --profile desktop …`、任何 live profile 文件操作。

---

## 7. V1–V4 可行性判定（给 Lead）

| 门禁 | 判定 | 依据 / 前置 |
|---|---|---|
| **V1 能力面板服务** | ✅ **探针侧可通过**（`capabilityPanel` 可用、`jev.rank/apply` 存在且可调用、apply 对新建会话真实写入） | `evidence/plugin-boot.json`、`evidence/v3.json`、磁盘 `session-capabilities.json`。**缺一条**：带真 key 的 `rank` 成功返回（需 §5.3 授权）；冷会话排队重放（`agent/created` 后）**未实测**，因为 `sessionController.create` 会立刻建 agent（见 `agentsList.count=1`），冷会话主要出现在「先 apply 后建 agent」的场景 |
| **V2 会话停止与最后回复** | ✅ 数据面可验 | `turn/end`、`assistant/message` 事件在会话日志中实测存在（§C.1 事件类型表）；探针 Host 里可订阅 `session/event` 复现 |
| **V3 会话创建与 prompt** | ✅ create 已验证；prompt **未验** | `sessionController.create({cwd})` 在隔离 web Host 成功返回 `{sessionId, agentPreset}`。prompt 需要可用模型：探针 home 无凭据 → `modelCatalog.groups = []`（`evidence/v3.json`），要么给探针配 provider（patch 里写 `llm-pi-ai` 配置 + 操作者导出 key），要么先不验 prompt |
| **V4 存储** | ✅ 可验 | 探针 home 里 `storageDomain` 存在（`typeof object`）；未写 domain 测试（属实现工作） |
| **V5 50 案例** | ⚠️ 数据可得，标签需人工 | 见 §4.2；`capabilityDigest` 需另算；建议评估脚本按实际字段调整 |
| **V7 SSE/HTTP** | ✅ Host 侧可达 | 隔离 web Host `GET /?token` 200、`GET /api` 401（token fence 生效）；Desktop `dsh-app://` 反代需 live/Electron 验（探针不覆盖） |

---

## 8. E. 证据与命令附录

### E.1 完整可复现步骤（devops 照抄）

```bash
# 0) 变量
PROBE=/tmp/dsh-commander-probe
REPO=/Users/lzx/Documents/GitHub/dsh-commander
export DSH_HOME=$PROBE/home DSH_AGENTS_HOME=$PROBE/agents
mkdir -p $DSH_HOME $DSH_AGENTS_HOME

# 1) 建 profile（base 模板 = 无 UI 最小 Host；可选 --from-default-profile web 得 web 模板）
dsh plugin --profile scout version-exemptions          # 退出码 0，输出 {}

# 2) 只读复用 live 的能力面板包（不复制、不安装、不联网）
mkdir -p $DSH_HOME/profiles/scout/node_modules
ln -sfn ~/.dsh/profiles/desktop/node_modules/dsh-capability-settings \
        $DSH_HOME/profiles/scout/node_modules/dsh-capability-settings
# 把 "dsh-capability-settings" 追加进 $DSH_HOME/profiles/scout/package.json 的 dsh.profile.bundles

# 3) 先验证 patch 合成（boot-free，不挂载）
dsh --profile scout --patch $REPO/docs/research/probes/probe.patch.yml --dump-config | grep -A4 scout-probe

# 4) 启动探针 Host（~2s 后自行 appExit(0)）
dsh --profile scout --patch $REPO/docs/research/probes/probe.patch.yml
cat $PROBE/evidence/plugin-boot.json | head -40

# 5) web 变体（带 UI，随机端口；需补一个 client 包符号链接，见 A5）
CLI=/Users/lzx/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh
dsh --profile webtest --from-default-profile web --dump-default-config   # 只初始化不启动；退出码 0，202 行 entry
mkdir -p $DSH_HOME/profiles/webtest/node_modules/@deepseek-ai
ln -sfn $CLI/node_modules/@deepseek-ai/dsh-client-ui-chat \
        $DSH_HOME/profiles/webtest/node_modules/@deepseek-ai/dsh-client-ui-chat
dsh --profile webtest --patch $REPO/docs/research/probes/probe.web.patch.yml --port 0 --no-open

# 6) 常驻 web 探活（不自动退出）
dsh --profile web --port 0 --no-open &        # 等到 stdout 出现 dsh web: http://127.0.0.1:PORT/?token=…
curl -sL -c /tmp/jar -b /tmp/jar -o /tmp/idx.html -w '%{http_code} %{size_download}\n' "http://127.0.0.1:PORT/?token=…"
# 清理：kill %1

# 7) V5 数据盘点（只读，不打印正文）
node $REPO/docs/research/probes/inventory-v5-data.mjs --home ~/.dsh --out /tmp/inv.json
node $REPO/docs/research/probes/read-session-log.mjs \
  "/Users/lzx/.dsh/sessions/--Users-lzx-.dsh--/0ad76f8d-…/session.v4.jsonl.zstd" --events
```

### E.2 探针目录结构（证据快照）

```
/tmp/dsh-commander-probe/                      1.2MB
├── agents/                                    # 隔离的 AGENTS_HOME（空）
├── evidence/                                  # 全部日志/JSON/URL（详见下）
└── home/                                      # 隔离的 DSH_HOME
    ├── dsh-capability-settings/               # 面板自身状态（session-capabilities.json、tool-attribution.json）
    └── profiles/
        ├── scout/{package.json, cordis.patch.yml, cordis.yml, node_modules/dsh-capability-settings -> live}
        ├── web/…                              # shipped web 模板 auto-init
        └── webtest/…                          # --from-default-profile web 副本
```

工作区内本案证据（可直接给审计/复核）：
- `docs/research/probes/evidence/plugin-boot.json`（base 探针全量观察）
- `docs/research/probes/evidence/v3.json`（web + sessionController + panel 对真实会话）
- `docs/research/probes/evidence/dump-config.yml`（合成后的 entry 列表，含探针行）
- `docs/research/probes/evidence/boot-base.out` / `boot-web.out` / `boot-v3.out`（stdout，含 URL 与面板键）
- `docs/research/probes/evidence/boot-v3.err`、`boot-web-after-chat-symlink.err`（stderr；后者 0 字节 = 告警已消除）
- `docs/research/probes/data-inventory.json`（V5 数据源结构统计）
- `docs/research/probes/pre-state.txt` / `post-state.txt`（live 未受影响）

### E.3 失败/坑清单（已验证）

| 现象 | 原因 | 修复 |
|---|---|---|
| `error: unknown option '--patch'` | launcher flag 写在内层 app 参数之后 | `--patch` 必须在 `--port/--no-open` 之前 |
| `profile "X" does not exist; create it with 'dsh plugin …'` | 自定义 profile 名未初始化 | 先 `dsh plugin --profile X version-exemptions`，或用 `--from-default-profile <shipped>` |
| `1 entry did not activate: ui-chat … ERR_MODULE_NOT_FOUND` | CLI 包未携带 `dsh-client-ui-chat` | 从 `CLI/node_modules/@deepseek-ai/` 符号链接到 profile（见 A5） |
| 技能枚举突然 176 条 | 未设 `DSH_AGENTS_HOME`，读了 live `~/.agents` | 设 `DSH_AGENTS_HOME=$PROBE/agents` |
| 写 `$DSH_HOME/.env` 被拒 | CC Safety Net 规则 `secret.basename.env` | 不改写安全网；改用操作者导出环境变量（§5.3 方案 ①） |
| `zstdDecompressSync` 只解出 header 270B | 会话日志是**多帧拼接**，Node 一次性 API 只解第一帧 | 用 `read-session-log.mjs`（按 magic 切帧逐帧解） |
| `panel` 看起来"空对象" | `ctx.provide("capabilityPanel", () => service)` 注册的是**工厂 thunk** | `const panel = ctx.get('capabilityPanel')()` 再取 `panel.jev`（详见 `capability-panel-api.md` §1） |

---

## 9. 结论分层汇总（Fact / Inference / Unverified）

**Fact**
1. 用 `DSH_HOME`+`DSH_AGENTS_HOME` 指向 /tmp，配合 shipped/副本 profile 与 `--patch`，可启动与 live 完全隔离的 DSH Host（base 与 web 两种均实测）；live desktop profile 文件 hash 前后全等。
2. 本地探针插件可由 `--patch` 的 `file://` 绝对路径挂载；`--dump-config` 可在不启动的情况下验证合成。
3. 能力面板 v1.19.3 可通过「只读符号链接 live profile 的 node_modules + bundle 一行」进入探针 Host，无需网络/pnpm；服务键与 jev 方法实测齐全。
4. `capabilityPanel` 注册值是**工厂 thunk**，`ctx.get(...)` 需调用一次才拿到 service。
5. `sessionController.create({cwd})` 在隔离 web Host 可用；`jev.apply` 对新建 live 会话真实写入（`applied:1, disabled:1`）并落盘到 `$DSH_HOME/dsh-capability-settings/session-capabilities.json`。
6. `rank` 在无 key 时返回 `{ok:false, code:"no-config"}`，不发网络请求；非法入参返回 `bad-request`。
7. `.env` 三层的加载与 `process.env` materialize 逻辑（源码）；inherited env 的可见性（运行时）。
8. V5 数据源齐全：28 工作区/243 归档/976 会话目录/974 可解析；会话日志为多帧 zstd，已提供解析脚本；cwd→工作区精确覆盖率 878/976。
9. `~/.dsh/dsh-capability-settings/jev.json` 无明文 key，仅 `apiKeyEnv=TYPESAFE_API_KEY`；`decisionThreshold=0.7`。

**Inference**
1. V2/V4 可以在探针 Host 内验证（所需服务/事件均已被观察到，但未逐条跑通验收脚本）。
2. 六层分层可以**从真实字段选样**，但「期望标签」本身需要人工/LLM 标注 + 复核，否则评估自我实现。
3. rc.2 CLI + rc.3 安装的面板 v1.19.3 行为一致（实测无版本相关报错）。
4. 用离线能力面板探针批量生成工作区 `capabilityDigest` 可行（enumerate 不需要 key）。

**Unverified（需要授权或额外动作）**
1. `$DSH_HOME/.env` 的运行时直证（被安全网阻断）。
2. 带真 key 的 `jev.rank` 成功返回（一次最小请求，需 §5.3 授权）。
3. 冷会话 `pendingPlans` 在 `agent/created` 后的**重放**（`sessionController.create` 会立即建 agent，需用「先 apply 再 prompt/建 agent」的路径专门构造）。
4. `sessionController.prompt` 走通一轮（需可用模型 provider；探针 home 无凭据）。
5. 网络可用性（pnpm/npm、Jev endpoint 连通性）。
