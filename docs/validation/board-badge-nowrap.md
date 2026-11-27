# 看板卡片优先级徽章「普通」换行修复（2026-11-28）

> 触发：用户截图反馈——看板卡片 meta 行里的优先级徽章「普通」被拆成上下两行（「普」在上、「通」在下）。
> 版本：包版本 **0.2.4**，tag `v0.2.4`。

## 结论

- 不是 i18n 文案或数据问题：`board.priority.normal` = 「普通」正常渲染，是**徽章被 flex 压窄后中文逐字换行**。
- 根因：卡片 meta 行 `.dshc-board-card-meta` 是 `flex-wrap: nowrap`，里面四项（工作区名 / 轮次 / 优先级 / 下游）都参与收缩。`.dshc-board-round` 有 `white-space: nowrap`，而 `.dshc-board-priority` **没有**——中文的最小内容宽度只有一个字宽，于是 flex 把它压到 ~11px，中文在字间断行。英文 `Normal` 不会断，所以只有中文环境、只有窄列时暴露。
- 修复（纯 Client CSS，无行为变化）：`.dshc-board-priority` 加 `flex: none; white-space: nowrap;`。宽度不够时由左侧工作区名（本来就有 `text-overflow: ellipsis`）让位，而不是徽章内换行。
- 回归护栏：`tests/client/board-styles.test.ts` 新增 `board card meta badges never wrap their label`，锁住三个徽章 `nowrap`，并锁住「meta 行可收缩 + 工作区走省略号」这条让位规则。该用例在修复前的 CSS 上失败（已验证），修复后通过。

## 证据

### 1. 真实布局量测（Chromium，`file://` + 完整 `STYLES`，卡片宽 214 / 162 / 132px）

162px 卡片 = 看板最小列宽 `BOARD_COLUMN_MIN_PX=180` 对应的卡片内容宽度（180 − 列边框 2 − 列体 padding 16）。

| 卡片宽 | 修复前 徽章尺寸 | 修复前 行数 | 修复后 徽章尺寸 | 修复后 行数 |
|---|---|---|---|---|
| 214px | 35×17px | 1 | 35×17px | 1 |
| **162px** | **25×32px** | **2（复现用户截图）** | **35×17px** | **1** |
| 132px（低于最小列宽，仅压力测试） | 25×32px | 2 | 35×17px | 1（meta 行整体溢出，属超范围窄） |

量测方式：`getBoundingClientRect()` 取徽章宽高，按 `line-height: 16px` 折算行数；同一页面并排渲染三个宽度，修复前后只差 `.dshc-board-priority` 这一条规则。

### 2. 单测与构建

```
pnpm --filter dsh-commander typecheck   # PASS
pnpm --filter dsh-commander test        # 517/517 pass（含新增 1 条护栏）
pnpm --filter dsh-commander build       # PASS
node packages/dsh-commander/tests/client/harness/run-harness.mjs   # PASS（smoke + interact + bubble + quick）
```

### 3. 发布后 live 核对

见 HANDOVER §5 第 47 条：desktop profile 重装 0.2.4 后，`/commander/health` 的 `version` 与 profile 内 `node_modules/dsh-commander/package.json` 一致，且安装副本 `lib/client.js` 与仓库构建产物 sha256 相同（含本条 CSS）。

## 边界

- 只在最小列宽及以上验证；比最小列宽更窄时 meta 行会整体溢出（不是本次引入，且被 `BOARD_COLUMN_MIN_PX` 挡住）。
- `tests/client/board-styles.test.ts` 是字符串级护栏（不含真实布局引擎）；真实布局结论来自上面的 Chromium 量测。
