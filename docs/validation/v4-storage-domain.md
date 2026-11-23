# V4 存储（`storageDomain` 域 `commander`，per-record）

- **结论：PASS**（两段式：① 按冻结蓝图原名 `boardEdits` 实测 **C1 FAIL** → ② **Lead 裁定**把表名改为 `board_edits`（平台命名契约硬约束，键/字段/layout/version/语义不变）→ ③ 改后 **C1–C7 全 PASS**）
- 执行人 / 执行时间：devops / 2026-11-17 17:04–17:07（Asia/Shanghai）；Lead 裁定时间：2026-11-17 17:10 前后（task-11 同步冻结文档）
- 判据说明：这不是降低判据，而是**修 schema 缺陷**——V4 判的是 per-record 存储语义是否可用；阻塞点是表名的平台契约不符，属实现前置缺陷，修正后按原判据全部通过。
- 环境：隔离探针 Host（`DSH_HOME=<repo>/.probe/home`、profile=`probe`，web 模板）；live Desktop 未触碰（前后基线一致，见 §7）
- 协议依据：`/Users/lzx/Documents/GitHub/dsh-commander/docs/architecture/validation-protocol.md` §5；冻结 schema：`/Users/lzx/Documents/GitHub/dsh-commander/docs/ARCHITECTURE.md` §3.2/§3.3

---

## 0. 两段式结论（裁定前 FAIL → Lead 裁定 → 裁定后 PASS）

### 0.1 事实（裁定前，按冻结蓝图 §3.2 原名）

**冻结 schema 的第 6 张表名 `boardEdits`（驼峰）违反 DSH 存储层的命名契约 `/^[a-z][a-z0-9_]*$/`，域 `commander` 打不开——不是 per-record 不可用，而是表名校验失败。** 两处实测都拒绝：

1. `defineDomain({…boardEdits…})`（蓝图 §4.1 的写法）→ 抛 `domain 'commander' table name 'boardEdits' must match /^[a-z][a-z0-9_]*$/`；
2. 绕开 `defineDomain` 手工构 spec 直接 `ctx.storageDomain.open(spec)` → json 后端（`dsh-storage-json/src/index.ts:99`）抛 `StorageError('malformed-medium', "invalid table name 'boardEdits' in unit 'commander'")`。

→ 按冻结蓝图字面口径 **V4-C1 FAIL**，对应协议 §5.7 映射 **NEXT-PHASE §7.4**；且 §7.4 的 "SQLite 路由" 备选**本机不可用**（`backend.get('sqlite')` → `backend-not-found (registered: json)`）。证据：`v4-spec.json`、`v4-run-blueprint.json`、`v4-restart-check-blueprint.json`。

### 0.2 Lead 裁定（2026-11-17，task-11）

Lead **批准**把冻结表名 `boardEdits` → **`board_edits`**（依据：平台表名契约 `^[a-z][a-z0-9_]*$` 是 DSH 硬约束、非产品决策；NEXT-PHASE 十条冻结决策不涉及表名）。约束：**key `editId`、`BoardEditRecord` 字段、其余 6 表、layout=per-record、version=1 全部不变**；architect 负责同步 `ARCHITECTURE.md` §3.2/§3.3 与 `implementation-plan.md`（devops 不改冻结文档）。

### 0.3 裁定后实测（探索性改名 → 门禁口径）

仅把该表名改为 `board_edits` 后（`v4-run-renamed.json` / `v4-restart-check.json`），**V4-C1–C7 全部 PASS**：open、往返逐字节相等、`__` 复合 key、非法 key 被拒且域不脏、update version+1、并发 2 次 update version 精确 +2、抛错回调无半写、应用层 version 冲突检测+重试、重启持久、durable 边界 `invalid-record` 拒绝。→ **V4 最终结论 = PASS（按 Lead 批准的表名口径）**。

> 说明：`v4-run-renamed` 的 `renamed` 是探针参数名，指"按 Lead 批准的表名"；门禁证据是这一组，`blueprint` 组保留为**缺陷与裁定依据**的原始证据。

## 1. 环境与版本

| 项 | 值 | 采集 |
|---|---|---|
| dsh CLI / Desktop | `0.2.2-rc.2` / `0.2.2-rc.3` | `dsh --version`；`plutil -extract CFBundleShortVersionString raw …/Info.plist` |
| 探针 node | `v24.19.0` | `/probe/v4/meta` |
| 存储服务 | `storage`（object）、`storageDomain`（object，`open` 为 function） | `/probe/v4/meta` |
| 已注册后端 | **仅 `json`**（`backend.get('json')` → object，kv.open=function；`backend.get('sqlite')` → `backend-not-found (registered: json)`） | `/probe/v4/meta` |
| 存储根 | `<repo>/.probe/home/storages`（json 后端 `root: dshHomePath('storages')`） | `/probe/v4/meta`、`/probe/v4/tree` |
| zod（探针运行时解析） | CLI 自带 `zod`，入口 `<CLI>/node_modules/zod/index.cjs`（4.6.x） | `/probe/v4/meta.zodEntry` |
| git rev | `d8d1543` | `git rev-parse --short HEAD` |

---

## 2. 探针形态（P-A）与文件

| 文件（绝对路径） | 作用 |
|---|---|
| `/Users/lzx/Documents/GitHub/dsh-commander/tools/validation/probes/probe-v4.mjs` | 探针插件：惰性解析 zod（`createRequire(process.argv[1])`，探针零依赖），声明 7 表 zod schema（照搬 ARCHITECTURE §3.3 字段的探针版），提供 `/probe/v4/*` |
| `/Users/lzx/Documents/GitHub/dsh-commander/tools/validation/probes/probe-v4.patch.yml` | 覆盖层插入探针行 |
| `/Users/lzx/Documents/GitHub/dsh-commander/tools/validation/scripts/run-v4.sh` | 两次 Host 启动（写阶段/读阶段）驱动与落盘 |
| `/Users/lzx/Documents/GitHub/dsh-commander/tools/validation/scripts/live-state.sh` | live 基线前后一致 |

路由：`/probe/v4/{meta,spec,run,restart-check,schema-open,tree,quit}`（`run`/`restart-check` 支持 `?tables=blueprint|renamed`；`renamed` 仅作探索性最小改名对照，**不是**对冻结 schema 的改动）。

> 探针 schema 是「字段照搬」的探针实现，不是生产 `schema.ts`；V4 判的是存储语义（open/往返/key/version/并发/持久/schema 边界），schema 字段逐字保真由实现与 tester 另审。

---

## 3. 精确步骤与原始返回

完整命令 + http 状态 + curl 退出码：`/Users/lzx/Documents/GitHub/dsh-commander/docs/validation/v4-artifacts/commands.log`。两次 Host 启动（write/read）均正常打印 URL，`boot-*.err` **0 字节**，退出码 **0**；所有 `/probe/v4/*` 请求 **http=200, curl_exit=0**。

### 3.1 定义层核查（`GET /probe/v4/spec`）

```json
{
  "nameChecks": [
    {"table":"config","matchesUnitNameRe":true}, {"table":"workspaces","matchesUnitNameRe":true},
    {"table":"commands","matchesUnitNameRe":true}, {"table":"tasks","matchesUnitNameRe":true},
    {"table":"dispatches","matchesUnitNameRe":true}, {"table":"boardEdits","matchesUnitNameRe":false},
    {"table":"sessions","matchesUnitNameRe":true}
  ],
  "defineDomainResult": {
    "ok": false,
    "error": "domain 'commander' table name 'boardEdits' must match /^[a-z][a-z0-9_]*$/",
    "name": "Error"
  }
}
```

### 3.2 按冻结蓝图原名 open（`GET /probe/v4/run?tables=blueprint`，写阶段）

```json
{ "ok": false, "cases": { "C1_open": { "ok": false,
  "error": "invalid table name 'boardEdits' in unit 'commander'" } } }
```

重启后同一 spec 再 open（`GET /probe/v4/restart-check?tables=blueprint`，读阶段）：

```json
{ "ok": false, "error": "invalid table name 'boardEdits' in unit 'commander'" }
```

→ **V4-C1 字面判据 FAIL**（域不可 open，后续 C2–C7 均不可达）。错误来源（源码级定位）：`<CLI>/node_modules/@deepseek-ai/dsh-storage-json/src/index.ts:99`（`UNIT_NAME_RE` 校验，`/^[a-z][a-z0-9_]*$/`，见 `dsh-storage/src/backend.ts:10`）。

### 3.3 探索性最小改名（`boardEdits` → `board_edits`，其余不变）：8 步全通过

写阶段 `GET /probe/v4/run?tables=renamed`（Host 内一次 `open` 后连续执行）：

| 步骤 | 判据 | 实测返回（关键字段） |
|---|---|---|
| 1 open | C1 | `{ok:true}`；`domain.name="commander"`；7 张表 handle 均为 function；`tables=["config","workspaces","commands","tasks","dispatches","sessions","board_edits"]` |
| 2 往返 | C2 | `put('task_test_0001',…)` → `get` 与写入对象 **逐字节相等**（`equal:true`）；`version:1`、`timelineLength:1`、`id/v/status/version` 全等 |
| 3 key 规则 | C3 | `sessions.put('ws_htdot__sess_8f31a2')` → `compoundKeyOk:true`；`sessions.put('bad/key:1')` → 抛 `unit 'commander': per-record key 'bad/key:1' is not path-safe (must match /^[a-zA-Z0-9_-]+$/)`；**拒绝后域仍可读写**（`afterRejectOk:true`、`subsequentWriteOk:true`）；应用层归一 `sanitizeKey('ws/htdot:1')`=`ws-htdot-1--e47e82b2`（匹配 `[a-zA-Z0-9_-]+`、写入成功） |
| 4 update+version | C4 | `update` 后 `version:2`、`status:"proposed"`、`timelineLength:2` |
| 5 并发 | C5 | 两次未 await 的 `update`（`Promise.all`）→ `r1Version:3, r2Version:4, finalVersion:4, versionDelta:2`；两次回调效果都在（`progressKept:true`、`blockKept:true`、`statusKept:true`） |
| 6 并发抛错 | C5 | `update` 回调 `throw` → reject（`thrown:"probe: update callback failed"`）；读回与抛错前 **完全一致**（`unchanged:true`，`version:4`） |
| 6b 应用层 version 重试 | C5 口径 | 拿旧快照 version=4 → 期间记录被推进 → 重试逻辑检测 `version` 落后、重读后第 2 次成功：`{ok:true, attempt:2, version:6, finalLabel:"retried"}` |
| 8 schema 前置校验 | C7 | 缺 `status` 的记录 `safeParse.success=false`（`status: invalid_value`）；非法枚举同样 false → 实现应在 put 前拒绝 |
| config singleton | C4 附带 | `config.put('singleton',…)` → 读回 `commander.sessionId="sess_commander_0001"`、`jev.model="jev-latest"` |
| close | — | `tasks:1, sessions:3, config:1`，`close` resolve |

读阶段（**换一个 Host 进程**，同一 `$DSH_HOME`）`GET /probe/v4/restart-check?tables=renamed`：

```json
{
  "ok": true, "mode": "renamed",
  "task": { "id":"task_test_0001","v":1,"status":"proposed","version":6,"timelineLength":2,
            "progress":"retried","block":"concurrent-b" },
  "sessionCompoundKey": { "sessionId":"sess_8f31a2","role":"work","status":"queued" },
  "sanitizedKeyPresent": true,
  "configSingleton": { "commanderSessionId":"sess_commander_0001","jevModel":"jev-latest" },
  "tableSizes": { "tasks":1,"sessions":3,"config":1 }
}
```

→ 重启后记录、`version`、`__` 复合 key、归一化 key、config singleton **全部保持**。

### 3.4 schema 的 durable 边界校验（`GET /probe/v4/schema-open`）

隔离域 `cmd_probe_invalid`（1 表，避免污染 `commander`）：

1. 绕过应用层校验写入非法记录 `{v:1,id:'task_bad_schema',title:'缺字段记录'}` → `writeAccepted:true`（domain 层按设计**写时不校验**，校验在 durable 读边界）；
2. `close` 后再次 `open` → **抛 `DomainError`，`code:"invalid-record"`**：
   `domain 'cmd_probe_invalid': stored record 'task_bad_schema' in table 'tasks' does not match its schema`。

→ 存储层不会静默接受非法记录（V4-C7 的 durable 边界口径成立）；实现仍应在 `put` 前用 zod 前置校验（§3.3 的 C8b），避免写入后重启才炸。

### 3.5 物理路径与文件格式（后端事实）

`/probe/v4/tree` 实测 `commander` 单元布局（绝对根 `/Users/lzx/Documents/GitHub/dsh-commander/.probe/home/storages`）：

```
storages/
└── commander/
    ├── config/singleton.json                    (820 B)
    ├── sessions/ws_htdot__sess_8f31a2.json      (239 B)
    ├── sessions/ws_htdot__sess_after_reject.json(245 B)
    ├── sessions/ws-htdot-1--e47e82b2.json       (242 B)   ← sanitizeKey 结果
    └── tasks/task_test_0001.json                (1192 B)
```

单记录文件格式（每个文件自带 version 戳；与 `dsh-storage-json/src/format.ts:serializeRecord` 一致）：

```json
{
  "version": 1,
  "record": { "v": 1, "id": "task_test_0001", "title": "历史遗留 HTTP 客户端迁移", "...": "..." }
}
```

非法记录文件同样落盘为 `cmd_probe_invalid/tasks/task_bad_schema.json`（110 B），随后 open 时被 `invalid-record` 拒绝。

---

## 4. 判据核对（二值）

### 4.1 裁定前：按冻结蓝图原名（`boardEdits`）

| ID | 判据 | 实测 | 结论 |
|---|---|---|---|
| **V4-C1** | 域可 open | `defineDomain` 抛 `table name 'boardEdits' must match…`；`storageDomain.open` 抛 `invalid table name 'boardEdits' in unit 'commander'`；`domain.name` 无从取得 | **FAIL** |
| V4-C2 | 往返一致 | 不可达（C1 失败） | N/A |
| V4-C3 | key 规则 | 不可达（C1 失败） | N/A |
| V4-C4 | update 与 version | 不可达 | N/A |
| V4-C5 | 并发不丢写 | 不可达 | N/A |
| V4-C6 | 重启持久 | 不可达 | N/A |
| V4-C7 | schema 生效 | 不可达 | N/A |

失败点唯一且明确：**表名 `boardEdits` 违反存储层命名契约**（不是 per-record 语义问题，也不是 key 规则问题）。此组证据保留，作为 Lead 裁定依据。

### 4.2 裁定后：表名 `board_edits`（Lead 批准口径，**门禁判据**）

| ID | 判据 | 实测（`board_edits`） | 结论 |
|---|---|---|---|
| C1 | 域可 open | `ok:true`，`domain.name="commander"`，7 表 handle 可取 | PASS |
| C2 | 往返一致 | put→get 逐字节相等，version=1、timeline 数组保留 | PASS |
| C3 | key 规则 | `ws_htdot__sess_8f31a2` 成功；`bad/key:1` 被拒且错误可读；拒绝后域可继续读写；归一化 key 可写 | PASS |
| C4 | update 与 version | 单次 update 后 version 精确 +1、`status` 按回调生效 | PASS |
| C5 | 并发不丢写 | 2 次并发 update 后 version 精确 +2、两效果都在；抛错回调无半写；应用层 version 冲突检测+重试成功 | PASS |
| C6 | 重启持久 | 换 Host 进程后记录/version/`__` key/归一化 key/config 全在 | PASS |
| C7 | schema 生效 | 应用层预校验拒绝非法记录；绕过后 durable 边界 open 抛 `invalid-record` | PASS |

**V4 总判据（Lead 裁定后口径）= C1∧C2∧C3∧C4∧C5∧C6∧C7 = PASS。**

---

## 5. 失败 → 停止条件映射

| 现象 | 结论 | 映射 | 处置 |
|---|---|---|---|
| `boardEdits` 表名被 `defineDomain` 与 json 后端双双拒绝，域不可 open（裁定前事实） | 触发 **NEXT-PHASE §7.4** 对应点 | §7.4（改结构须 lead 批准） | **Lead 已裁定批准改名 `board_edits`（2026-11-17，task-11）**；改名后 C1–C7 全 PASS，**停止条件未生效**，不阻塞 M0 |

§7.4 的两条备选在本环境的事实与最终处置：

- **SQLite 路由不可用**：本安装只注册了 `json` 后端（`backend.get('sqlite')` → `backend-not-found (registered: json)`），`storage-domain.routes` 没有第二个介质可切。
- **改结构（已采用）**：表名 `boardEdits` → `board_edits`（1 处声明 + 文档提法；键/字段/语义完全不变）。改名后实测 C1–C7 全通过。**Lead 已批准（2026-11-17，task-11），architect 同步冻结文档**；devops 未自行修改冻结文档。

> 结论：§7.4 停止条件**已由 Lead 裁定的 schema 缺陷修正解除**，不再阻塞 M0 存储实现。

---

## 6. tester 独立复跑步骤

> 第三方复跑：请用 `PROBE_ROOT=<tmp> bash tools/validation/scripts/setup-probe-env.sh` 建环境，并用 `OUTDIR=<tmp>/v4 bash tools/validation/scripts/run-v4.sh` 落盘；**默认路径会写 `docs/validation/v4-artifacts` 证据目录，请勿覆盖**。（M1/M2 已由 task-17 修复：setup 会幂等创建 `probe`(web) profile，run 脚本支持 OUTDIR 覆盖。）

前置：仓库 `/Users/lzx/Documents/GitHub/dsh-commander`、`dsh` 在 PATH。**不需要 Jev key**。

```bash
cd /Users/lzx/Documents/GitHub/dsh-commander
# 1) 干净重建一次性探针环境（幂等）
rm -rf .probe
bash tools/validation/scripts/setup-probe-env.sh          # exit 0
# 2) 跑 V4（两次 Host 启动，约 20s）
bash tools/validation/scripts/run-v4.sh                    # exit 0
# 3) 核对关键返回
cd docs/validation/v4-artifacts
node -e 'const j=require("./v4-spec.json"); console.log(j.defineDomainResult)'        # ok:false, table name 'boardEdits'
node -e 'const j=require("./v4-run-blueprint.json"); console.log(j.cases.C1_open)'    # ok:false, invalid table name
node -e 'const j=require("./v4-run-renamed.json"); console.log(j.cases.C5_concurrent)' # finalVersion 4, versionDelta 2
node -e 'const j=require("./v4-restart-check.json"); console.log(j.task.version, j.sessionCompoundKey.sessionId)' # 6, sess_8f31a2
node -e 'const j=require("./v4-schema-open.json"); console.log(j.steps.reopen)'      # code invalid-record
diff <(grep -v '^#' live-pre.txt) <(grep -v '^#' live-post.txt) && echo live-identical
```

复跑注意：`v4-run-renamed` 是**探索性**对照（`?tables=renamed`），不是对冻结 schema 的变更；`v4-run-blueprint` 才对应门禁口径。两次 boot 之间探针会写 `.probe/home/storages/commander/**`（隔离 home，gitignored）。若 `rm -rf .probe` 后重跑，`cmd_probe_invalid` 的非法记录会重新生成并再次被 open 拒绝，属预期。

---

## 7. live 隔离基线

`live-pre.txt` vs `live-post.txt`：除时间戳头外**逐行一致**（desktop profile 树 hash、顶层 mtime hash、`~/.dsh/.env` stat `858|1791515016`、node_modules 380 条）。未重启/关闭 Desktop、未写 `~/.dsh`。

---

## 8. 证据文件（绝对路径，均在 `/Users/lzx/Documents/GitHub/dsh-commander/docs/validation/v4-artifacts/`）

| 文件 | 内容 |
|---|---|
| `commands.log` | 全部 curl 命令 + http 状态 + curl_exit + 两次 Host 退出码 |
| `boot-write.out/.err`、`boot-read.out/.err` | 两次启动 URL/stderr（err 均 0 字节） |
| `v4-meta.json` | 服务/后端（仅 json）/根路径/zod 入口 |
| `v4-spec.json` | `defineDomain` 失败原文 + 7 表名规则核查 |
| `v4-run-blueprint.json` | 门禁口径：open 失败 → C1 FAIL |
| `v4-run-renamed.json` | 探索性改名：8 步全通过明细 |
| `v4-restart-check-blueprint.json` / `v4-restart-check.json` | 重启后两种 spec 的结果（前者仍失败，后者持久读回） |
| `v4-schema-open.json` | 非法记录 durable 边界 `invalid-record` |
| `v4-tree-before-restart.json` / `v4-tree-after-restart.json` / `v4-tree-final.json` | 物理布局与文件大小 |
| `live-pre.txt` / `live-post.txt` / `live-state-diff.txt` | live 隔离基线 |

复跑脚本与探针源码见 §2。

---

## 9. 裁定与交接

1. **已裁定**：Lead 批准表名 `boardEdits` → `board_edits`（2026-11-17，task-11）；key `editId`、`BoardEditRecord` 字段、其余 6 表、layout、version 不变。architect 负责同步 `ARCHITECTURE.md` §3.2/§3.3 与 `implementation-plan.md`；**devops 未改冻结文档**。
2. **给实现（M0）**：`defineDomain` 的 7 表名都必须匹配 `/^[a-z][a-z0-9_]*$/`；表名用 `board_edits`，记录内 `id` 仍是 `editId`（如 `edit_…`）。其它实现口径以 §3.3 实测为准（`update` 是单写链原子读改写、应用层 `version` 重试、put 前 zod 前置校验）。
3. 本文件待 tester 独立复跑并追加审计签名；执行人未自审。
