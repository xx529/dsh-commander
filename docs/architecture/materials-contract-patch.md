# 任务报告「依据与材料」· 实现契约（方案 A）

> 日期：2026-11-20
> 状态：**已实现**（2026-11-20；Host/Client 构建与自动化验证通过，live 走查待用户重启）。本文是 `implementation-plan.md` 的加法补丁；冲突以本文为准。
> 产品口径来源：用户 2026-11-20 需求——报告里除了证据文本，还要有**链接 / 文档 / 图片**，用来支撑或完善结论；选择方案 A（**报告级统一材料区**），不做逐项独立材料表。
> 数据口径：用户明确「现有数据可以删除，实现时不需要考虑兼容历史数据」；本文不做旧记录迁移，旧记录没有材料字段时按空处理。

---

## 0. 一句话方案

在每一轮的「整理报告」里增加 `reportMaterials[]`：由 `commander_task_report` 显式传入的链接/文档/图片，加上 Host 从工作会话 `deliverables/presented` 事件自动归并的交付文件；看板抽屉在**结论卡下方**渲染一个报告级「依据与材料」区（图片缩略图 + 链接/文档列表 + 图片灯箱），不改变「指挥官不评估」的边界。

**不新增表、不新增事件类型、不做逐项材料表、不做文件内容存储。**

---

## 1. 数据模型

### 1.1 `ReportMaterial`

```ts
type ReportMaterialKind = 'link' | 'file' | 'image'
type ReportMaterialSource = 'commander' | 'presented' | 'session'
type ReportMaterialState = 'ok' | 'missing' | 'too_large' | 'unsupported' | 'unverified'

interface ReportMaterial {
  id: string
  kind: ReportMaterialKind
  title: string                 // 1..200
  url?: string                  // link / remote image: http(s)
  path?: string                 // file / local image: absolute
  description?: string          // 0..500
  source: ReportMaterialSource
  acceptanceIds?: string[]      // 可选：关联验收项；方案 A 只用于 chips 标记
  derivedFrom?: { sessionId: string; seq: number }
  state: ReportMaterialState
  meta?: { mime?: string; bytes?: number }
}
```

- `kind` 与 `url/path` 的组合：
  - `link`：必须有 `url`（http/https），不能有 `path`；
  - `file`：必须有 `path`（绝对路径，Host 校验后存储），不能有 `url`；
  - `image`：`url` 或 `path` 二选一；本地图片必须是 PNG/JPEG/WebP/GIF。
- `state`：
  - `ok`：Host 写入时文件存在且类型/大小通过；
  - `too_large` / `unsupported`：文件存在但不满足展示条件，仍记录路径；
  - `missing`：不写入（明确拒绝的材料直接丢弃并返回 warning）；
  - `unverified`：远程链接/远程图片，Host 不抓取、不校验内容。
- 不存文件内容、不存 base64、不存缩略图字节。

### 1.2 记录字段

| 记录 | 字段 | 说明 |
|---|---|---|
| `TaskRecord` | `reportMaterials?: ReportMaterial[]` | **当前轮**最近一次 `commander_task_report` 的材料；空数组/缺省 = 无材料 |
| `AcceptanceRound` | `materials?: ReportMaterial[]` | 历史轮次归档时随 `items`/`reportSummary` 一起保存 |
| `AcceptanceItem` | 不变 | `evidence` 仍是每条验收的短文本；材料是报告级，不塞进 acceptance |

### 1.3 上限

| 常量 | 值 | 说明 |
|---|---|---|
| `REPORT_MATERIALS_MAX` | 24 | 当前轮最多材料数；超出截断并 warning |
| `REPORT_MATERIAL_TITLE_MAX` | 200 | 标题 |
| `REPORT_MATERIAL_DESCRIPTION_MAX` | 500 | 描述 |
| `REPORT_MATERIAL_URL_MAX` | 2048 | URL |
| `REPORT_MATERIAL_PATH_MAX` | 1024 | 路径 |
| `REPORT_IMAGE_MAX_BYTES` | 8 MiB | 本地图片读取/展示上限 |
| `REPORT_FILE_MAX_BYTES` | 50 MiB | 本地文档元数据上限（不读内容） |

---

## 2. 工具：`commander_task_report`

### 2.1 输入

新增可选参数：

```ts
materials?: Array<{
  kind: 'link' | 'file' | 'image'
  title: string
  url?: string
  path?: string
  description?: string
  acceptanceIndex?: number   // 0-based，关联本次 acceptance[]；越界忽略并 warning
  derivedFromSeq?: number    // 可选；缺省用 seqTo
}>
```

- `materials` 不是必填；不传时仍会自动归并 `present` 事件。
- `acceptanceIndex` 在生成 acceptance id 后映射为 `acceptanceIds`。
- `path` 支持绝对路径；相对路径按任务工作区根解析（仅限工作区内）。
- `url` 只允许 `http:`/`https:`；拒绝 `javascript:`/`data:`/`file:`/`blob:`。

### 2.2 自动归并 `present`

- 在 `seqFrom..seqTo` 窗口内读取会话事件（已有的 `readSessionEvents`），收集 `deliverables/presented` 的 `data.files[]`。
- 每个文件转成 `source:'presented'` 材料：
  - 扩展名属于 PNG/JPEG/WebP/GIF → `image`；
  - 其他 → `file`；
  - `title` 用文件名，`description` 用 present 的说明；
  - `path` 用 present 记录的绝对路径，重新 stat/realpath 校验；
  - `derivedFrom.seq` 用事件 seq。
- 与显式 `materials` 按 realpath 去重；显式材料的标题/描述优先，`source` 记为 `presented`（它仍然来自工作会话交付）。
- 工作会话没有 `present` 或窗口内没有事件时，静默跳过。

### 2.3 自动抓取会话最后回复（2026-11-20 追加）

- 读取报告窗口内**最后一条 `assistant/message`** 的文本（与 turn/end 注入同一口径）；
- 解析 Markdown 图片 `![alt](url)`、Markdown 链接 `[text](url)`、裸 URL `https://...`；
- 只抓 HTTP(S) 链接/图片；本地文件链接不自动抓（本地文档以 `present`/显式 `materials` 为准，避免把「产出与证据」里的一堆路径刷进材料区）；
- 代码围栏/行内代码中的 URL 不抓；
- 先抓 Markdown 链接并移除其 span，再扫描裸 URL；裸 URL 以空白和 `) ] ( [ 、，。；：！？` 等分隔符为边界，末尾标点会剥离；
- 本地图片只在工作区内且通过图片魔数校验时抓；
- `source:'session'`，链接/远程图片 `state:'unverified'`；
- 与显式材料、`present` 文件按 URL/realpath 去重；显式/`present` 优先；
- 每次报告最多自动抓 `REPORT_SESSION_MATERIALS_MAX=12` 条，图片优先。

### 2.4 输出

```ts
{
  taskId: string
  status: 'review' | 'running' | 'blocked'
  evidenceState: 'complete' | 'insufficient'
  insufficient?: string[]
  materials: number          // 实际落库数量
  materialWarnings?: string[] // 被丢弃/截断的原因，最多 10 条
}
```

- 工具 `output.schema` 必须与返回逐字段一致；`render` 增加 `materials=N`。
- 单条材料无效**不阻塞报告**：丢弃该条并写 warning；报告本身仍成功。

### 2.5 写入

`commander_task_report` 在同一个 `tasks.update` 里写：

- `acceptance`（不变）
- `reportSummary`（不变）
- `reportMaterials`：**替换**为本次结果（没有材料就写空数组/删除字段）
- timeline `report` 行的文本增加 `材料 N 项`

---

## 3. 轮次归档

`src/host/dispatch/service.ts` 的 `applyDispatch`：

- 续派时，上一轮 `reportMaterials` 与非空 `acceptance`/`reportSummary` 一起进入 `acceptanceHistory` 的 `materials`；
- 当前轮 `reportMaterials` 清空（与 `reportSummary` 一样）；
- 首次派发不归档、不清空；
- 历史最多 5 轮（沿用 `HISTORY_MAX`）。

---

## 4. API

### 4.1 `GET /commander/tasks/:id`

- 返回 `reportMaterials`（当前轮，若存在）；
- `acceptanceHistory[].materials`（历史轮，若存在）；
- 本地图片材料额外返回 `imageUrl`：由 Host 生成的签名 URL，客户端直接用于 `<img>`；
- 远程图片/链接不生成 `imageUrl`，由客户端用 `url`。

`imageUrl` 形式：

```
{origin}/commander/tasks/{taskId}/materials/{materialId}?sig={hmac}
```

- `origin` 取 `webServer.getOrigin()` / `DSH_WEB_URL`；不可用时返回相对路径。
- HMAC key 为 Host 进程级随机 32 字节；重启后旧 URL 失效，详情接口重新生成。
- 签名 payload：`taskId:materialId`；密钥为 Host 进程级随机 32 字节，重启即失效，不另设过期。

### 4.2 `GET /commander/tasks/:id/materials/:materialId?sig=...`

- 只服务 `kind='image'` 且 `path` 存在的本地图片；
- 校验签名（常量时间比较）；
- 校验 material 属于该 task；
- 重新 `realpath` + `stat`：必须是普通文件，大小 ≤ `REPORT_IMAGE_MAX_BYTES`；
- 按扩展名/魔数确认 MIME，只允许 PNG/JPEG/WebP/GIF；
- 响应：
  - `Content-Type` 正确；
  - `Cache-Control: private, max-age=3600`；
  - `X-Content-Type-Options: nosniff`；
  - `Content-Security-Policy: sandbox; default-src 'none'`；
  - `Content-Disposition: inline; filename="..."`；
  - `Content-Length`。
- 失败统一 404（不泄漏路径/原因）。

> 现有 `/commander/*` 路由没有应用层鉴权；资产路由必须靠签名 + 只读 materialId 访问，不能接受客户端传路径。

---

## 5. 写入校验与安全

### 5.1 URL

- 只允许 `http:`/`https:`；
- 拒绝带用户名/密码的 URL；
- 长度 ≤ 2048；
- 不在 Host 侧抓取/HEAD（避免 SSRF、超时、隐私）；
- UI 标「外部链接，未校验」。

### 5.2 本地文件

- 仅允许：
  - 任务工作区根内（`workspaces` 记录的 `path`）；
  - 或本报告窗口内 `present` 事件声明的绝对路径（present 已由 DSH 校验文件存在）。
- `realpath` 后必须仍在允许根内（presented 路径按自身允许）；
- 必须是普通文件，不能是目录/设备/FIFO；
- 本地图片额外：大小 ≤ 8 MiB，MIME 属于图片白名单，读首 16 字节校验魔数；
- 本地文档：只 stat 取大小/扩展名，不读内容；超过 50 MiB 仍可记录为 `too_large`，不阻塞。
- 不跟随最终符号链接到允许根之外；无法确认时丢弃并 warning。

### 5.3 材料去重

- `link`：按规范化 URL 去重；
- `file`/本地 `image`：按 `realpath` 去重；
- 远程 `image`：按 URL 去重；
- 同一 `present` 文件与显式材料重复时保留显式标题/描述。

---

## 6. 客户端（方案 A）

### 6.1 位置

每个轮次的整理报告内：

```
结论卡
依据与材料（仅当前轮与展开的历史轮展示）
验收列表
```

- 默认显示 2 张图片 + 前 3 行链接/文档；
- `查看全部 N 项` 展开剩余；`收起` 折叠整个材料区；
- 结论卡底部增加 `N 张截图 · N 个来源 · N 份文档` + `查看依据`（滚动到材料区）；
- 轮次报告标题 meta 增加 `N 材料` 徽标；折叠摘要可带材料数。

### 6.2 渲染

- 图片：2 列缩略图，点击打开灯箱；本地图用 `imageUrl`，远程图用 `url`；`loading="lazy"`、`referrerPolicy="no-referrer"`；
- 链接：图标 + 标题 + 域名/来源，点击 `window.open(url, '_blank', 'noopener,noreferrer')`；窗口页走 `getShellBridge().openExternal`；
- 文档：图标 + 文件名 + 类型/大小 + 来源；点击打开文件动作单（复制路径 / 在访达中显示 / 打开文件——生产先实现复制路径与打开提示，系统级打开后续接）；
- 来源标签：
  - `presented` → `工作会话交付`
  - `commander` → `指挥官整理`
  - `session` → `会话原文提及`
  - 远程链接 → `外部链接，未校验`
- 图片加载失败显示占位/文件名，不崩溃；
- 保持「不评估」：材料只表示来源，不出现“已验证/通过”。

### 6.3 窗口页

- `BoardPage` 同时用于 DSH 页内和原生壳窗口；材料区必须共享；
- 链接点击用 `getShellBridge().openExternal`（窗口页）或 `window.open`（页内）；
- 本地图片 URL 用 Host 返回的绝对签名 URL，避免 `file://` 相对路径问题。

### 6.4 i18n

新增 key（zh/en 两份同改）：

```
board.drawer.materials
board.drawer.materialsShort
board.drawer.materialsCount
board.drawer.materialsOpenAll
board.drawer.materialsCollapse
board.drawer.materialSourcePresented
board.drawer.materialSourceCommander
board.drawer.materialExternal
board.drawer.materialMissing
board.drawer.materialTooLarge
board.drawer.materialOpen
board.drawer.materialCopyPath
board.drawer.materialReveal
board.drawer.materialPreview
board.drawer.materialClose
board.drawer.materialPrev
board.drawer.materialNext
board.drawer.materialOpenOriginal
board.drawer.materialCopyImagePath
```

---

## 7. 测试

| 层 | 用例 |
|---|---|
| unit/schema | `ReportMaterial` 合法/非法（kind+url/path、URL scheme、长度、state） |
| unit/tools | `commander_task_report` 接收 materials、acceptanceIndex 映射、去重、上限、无效材料 warning、present 自动归并 |
| unit/dispatch | 续派时 materials 进 `acceptanceHistory`、当前轮清空 |
| integration | `GET /commander/tasks/:id` 返回 materials/imageUrl；asset route 签名/404/大小/MIME |
| client | `buildTaskRounds` 带 materials；材料区渲染、展开、灯箱、空态；i18n key 两份 |
| e2e | 隔离 profile：组织报告带 1 图 + 1 文档 + 1 链接 → 详情/图片 URL 200；续派后历史轮仍可见 |

---

## 8. 非目标

- 不做每条验收项独立材料表（方案 B）；
- 不做文件上传、文件内容复制、OCR、PDF 预览；
- 不做远程图片 Host 代理/抓取；
- 不做旧数据迁移；旧记录没有 `reportMaterials` 时按空处理；
- 不新增表、不新增事件类型、不改审批/提问路径。

---

## 9. 交付物

- Host：`schema.ts`、`config.ts`、`tools/index.ts`、`dispatch/service.ts`、`api/routes/handlers.ts`、`api/material-assets.ts`、`api/server.ts`、`index.ts`
- Client：`types.ts`、`board.ts`、`BoardPage.tsx`、`locales.ts`、`styles.ts`、`window-styles.ts`（如需）
- Tests：unit/integration/client
- 文档：本文 + `implementation-plan.md` 引用 + `docs/validation/` 验收记录（实现后）
