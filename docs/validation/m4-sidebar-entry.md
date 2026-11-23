# 侧栏「任务看板」入口（M4 用户追加，2026-11-19）

> 需求：用户提供 live 侧栏截图，要求在 `上下文洞察 / 能力面板 / 更多` 这一区域补一个「任务看板」入口。
> 契约补充：`docs/architecture/m2m3-contract-patch.md` §2.1（2026-11-19 补记）。
> 边界：只动 Client 半，不新增 Host 路由、不新增 `lib/` 文件、不改 `dsh.client.inject`。

## 0. 状态总览

| 验收项 | 结果 | 证据 |
|---|---|---|
| 侧栏出现「任务看板」行（图标 + 本地化 label） | **PASS（隔离真实 Web + 无头 Chrome）** | `docs/validation/m4-artifacts/sidebar-entry.png`、`sidebar-entry-crop.png` |
| 点击行 → 选中 `main` keyed 面板 `commander-board`（id 与 main key 严格同值，否则 `selectPanel` 抛错） | **PASS（注册契约单测 + harness 断言 id === main key）** | `tests/client/nav.test.ts`、harness `smoke.mjs` |
| 行位置：已发布行 0/10/20/30 之后、「更多」之前（`order: 40`） | **PASS（截图 + harness 断言）** | 同上 |
| label 走 i18n（`board.nav` = 任务看板 / Task board），两份字典齐全 | **PASS** | `tests/client/locales.test.ts`（源扫描）+ `nav.test.ts` |
| 图标为内联 SVG、零运行时依赖；`size` 由侧栏给（16/18px），颜色随 `currentColor` | **PASS** | `src/client/BoardNavIcon.tsx`、harness「sidebar row renders an svg glyph」 |
| 隔离页无 console 异常 / 无 client 加载失败 | **PASS**（exceptions=0、consoleErrors=0；`client apply ok`） | `/tmp/commander-nav-probe2/report/cdp/summary.txt`（一次性产物） |
| live 物理点击走查 | **UNVERIFIED**（需用户在 live 页面硬刷新后点击；见 §3） | — |

## 1. 改动

- `packages/dsh-commander/src/client/board-nav.ts`（新）：`BOARD_PANEL_ID`、`BOARD_NAV_ORDER=40`、`registerBoardNav()`。
  `ctx.slots.inject('sidebar.panellist', …)` 注册**图标组件本体**；按钮、`aria-label`、折叠 tooltip、选中态由 ui-sidebar 渲染。
- `packages/dsh-commander/src/client/BoardNavIcon.tsx`（新）：与大面板「看板」按钮同款的三栏边框图标（24 视图，按 `size` 渲染）。
- `packages/dsh-commander/src/client/index.tsx`：注册第四条槽位并在 `apply ok` 日志里带 `nav`；`BOARD_PANEL_ID` 单源自 `board-nav.ts`。
- `packages/dsh-commander/src/client/locales.ts`：新增 `board.nav`（zh/en）。
- 回归：`tests/client/nav.test.ts`（新）、`tests/client/harness/smoke.mjs`（4 条新断言，43→49）。

## 2. 自动化结果（2026-11-19 11:2x）

| 命令 | 结果 |
|---|---|
| `pnpm --filter dsh-commander typecheck` | PASS |
| `pnpm --filter dsh-commander test` | **284/284 PASS** |
| `pnpm --filter dsh-commander build` | PASS（`lib/client.js` 349,125B，sha256 `95819e32c42a72f…`） |
| `node packages/dsh-commander/tests/client/harness/run-harness.mjs` | **49/49 + 166/166 PASS** |
| `bash tools/dev/client-repro.sh`（隔离 profile + 无头 Chrome） | PASS：`exceptions=0`、`consoleErrors=0`、`[dsh-commander] slots registered / client apply ok` |

隔离截图里侧栏顺序：插件 → 自动化任务 → **任务看板** → 更多（隔离 profile 未装「上下文洞察/能力面板」，故这两行不出现；live 上 40 排在 30 之后）。

## 3. 生效方式与限制

- live 的 `~/.dsh/profiles/desktop/node_modules/dsh-commander` 是 `link:` **符号链接**指向仓库包，`lib/client.js` 已即时可读（仓库与 live 路径为同一文件，`diff` 一致）。
- 本次只重建已有文件、未新增 `lib/` 文件、未改 Host 与 `dsh.client` → **用户在 live 页面硬刷新（Cmd+Shift+R）即可看到入口，无需重装/重启**。
- **live 点击走查未做**：本任务不驱动用户 live 浏览器；刷新后点击「任务看板」应切到看板整页，「返回对话」可回到会话。若未出现，先看 console 是否有 `sidebar.panellist registration failed`。
- 入口位置如需调整，只改 `BOARD_NAV_ORDER`（例如 15 = 自动化任务与上下文洞察之间）。
