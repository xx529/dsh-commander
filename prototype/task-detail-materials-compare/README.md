# 方案 A/B 对比 · 材料归属

> 日期：2026-11-20
> 同一份多轮任务报告、同一组 7 份材料，只改变「材料挂在哪」。
> 打开：`index.html`（纯静态，图片来自两个原型目录）。

---

## 两版

| 版本 | 目录 | 材料位置 |
|---|---|---|
| **A · 报告级** | `prototype/task-detail-materials/` | 结论下一个「依据与材料」大块；验收项只挂 1–2 个 chips |
| **B · 逐项** | `prototype/task-detail-materials-per-item/` | 每条验收项自带可折叠的「材料 N」表；没有报告级材料块 |

对比图的左右两栏都从同一份报告的「整理报告」行开始，裁到验收结束，方便直接看同一段的差异。

---

## 结论

**建议采用 C：默认 A，逐项按需展开 B。**

- 默认保留报告级材料总览：结论第一眼有图、有来源；
- 每条验收项的 chips 点击后，在原地展开「本项材料」行内表；
- 存储只存一份 `ReportMaterial`，用 `acceptanceIds` 关联多条验收项；
- 这样既不重复存/重复展示，也不丢「没有归属到某条验收项」的背景来源。

如果只能二选一：

- **选 A**：结论审阅优先、材料跨多条验收、来源多、报告长；
- **选 B**：验收项与材料边界清晰、每条 1–3 个材料、用户逐条验收。

---

## 对比图

`shots/compare.png`（1100×2058）：

- 左：A 报告级材料；
- 右：B 逐项材料；
- 下表：结论支撑、验收映射、图片可读性、跨项复用、无归属来源、页面高度、数据模型、适合场景；
- 底部：方案 C 的信息架构小图。

---

## 数据模型建议

```ts
interface ReportMaterial {
  id: string
  kind: 'link' | 'file' | 'image'
  title: string
  url?: string
  path?: string
  source: 'presented' | 'commander' | 'session'
  acceptanceIds?: string[]   // B/C 的核心：一份材料可挂多条验收
  derivedFrom?: { sessionId: string; seq: number }
  state: 'ok' | 'missing' | 'too_large' | 'unsupported' | 'unverified'
  meta?: { mime?: string; bytes?: number }
}
```

- A：客户端只用 `reportMaterials[]` 平铺渲染；
- B：客户端按 `acceptanceIds` 分组，同一 id 可能在多个 item 下重复渲染；
- C：A 的总览 + B 的按需展开，共用同一 id，避免副本；
- 没有 `acceptanceIds` 的材料在 B 下没有位置，在 A/C 下落到「补充来源」。

---

## 文件

```
prototype/task-detail-materials-compare/
├── index.html      对比页面
├── styles.css      对比页面样式
├── shots/compare.png
└── README.md
```

重新截图（对比页需要先有 A/B 的 `panel-report-section.png`）：

```bash
node prototype/task-detail-materials/shot.mjs \
  --url "file://$PWD/prototype/task-detail-materials-compare/index.html" \
  --out prototype/task-detail-materials-compare/shots/compare.png \
  --width 1100 --full 1 --scale 1
```
