# 任务报告「依据与材料」· 实现验收（方案 A）

> 日期：2026-11-20
> 契约：`docs/architecture/materials-contract-patch.md`
> 范围：`organize_report.materials`、`present` 自动归并、任务详情材料投影、本地图片签名资产路由、看板抽屉报告级材料区。
> 结论：**Host/Client 构建与自动化验证通过；live 走查待用户重装 + 重启后执行。**

---

## 1. 代码落点

| 层 | 文件 |
|---|---|
| 类型/校验 | `packages/dsh-commander/src/host/schema.ts`、`src/host/config.ts` |
| 材料构建 | `src/host/report-materials.ts`、`src/host/materials.ts` |
| 工具 | `src/host/tools/index.ts` |
| 轮次归档 | `src/host/dispatch/service.ts` |
| 详情/资产 | `src/host/api/routes/handlers.ts`、`src/host/api/material-assets.ts`、`src/host/api/server.ts`、`src/host/index.ts` |
| Client | `src/client/types.ts`、`src/client/board.ts`、`src/client/Materials.tsx`、`src/client/BoardPage.tsx`、`src/client/locales.ts`、`src/client/styles.ts` |

---

## 2. 自动化验证

命令均在本仓库执行（2026-11-20）：

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm --filter dsh-commander typecheck` | PASS |
| 单测/集成 | `pnpm --filter dsh-commander test` | **354/354 PASS** |
| Client harness | `DSH_COMMANDER_HARNESS_MODULES=… node packages/dsh-commander/tests/client/harness/run-harness.mjs` | smoke **49/49**、interact **180/180** PASS |
| 构建 | `pnpm --filter dsh-commander build` | PASS（host/client/window） |
| e2e | `node packages/dsh-commander/tests/e2e/m23-e2e.mjs` | **26/26 PASS，3 INFO**（隔离 profile） |

### 新增覆盖

- `tests/unit/materials.test.ts`：链接/文档/本地图片、acceptanceIndex、present 自动归并、去重、非法 URL、假图片、跨工作区 present、签名资产读取。
- `tests/unit/report-tool.test.ts`：`organize_report` 写入 3 项材料、显式图片与 present 同 realpath 去重、timeline 材料数。
- `tests/integration/m1-routes.test.ts`：任务详情透出 `reportMaterials`，本地图片带签名 `imageUrl`。
- `tests/integration/m5-continue.test.ts`：续派时材料进 `acceptanceHistory[].materials`，当前轮清空。
- `tests/client/board.test.ts`：`buildTaskRounds` 按轮带材料。
- `tests/client/harness/interact.mjs`：材料区渲染、图片缩略图、链接/文档行、验收 chips、灯箱开关、文件动作单开关。

### e2e 摘要

```text
汇总：26/26 PASS，0 FAIL，3 INFO
```

e2e 覆盖 Host 启动、任务创建、派发、turn/end 注入、organize_report、accept/continue/archive/restore；材料相关路径由新增单测/集成与 harness 覆盖。

---

## 3. 手工验证（待用户执行）

1. 重装插件（安装是快照式，只重启不生效）：

   ```bash
   # 用户侧执行；不要在本会话改 live
   dsh plugin --profile desktop add file:/Users/lzx/Documents/GitHub/dsh-commander/packages/dsh-commander
   ```

2. 重启 DSH，硬刷新 Web 页面。
3. 在指挥官会话里让工作会话调用 `present` 或直接让 `organize_report` 带 `materials`。
> 2026-11-20 预检：`bash tools/dev/install-live-m0.sh` **PASS**；当前 `~/.dsh/profiles/desktop/node_modules/dsh-commander` 是指向仓库包的 symlink，repo/live 的 `lib` 已一致（57 个 .js）。因此本次最少只需**重启 DSH + 硬刷新页面**；若按快照式流程操作，重装后再重启同样可行。

4. 打开待验收任务 → 轮次「整理报告」→ 确认：
   - 结论卡下方出现「依据与材料」；
   - 图片缩略图可点开灯箱；
   - 链接可外开；
   - 本地文档动作单可复制路径；
   - 续派一轮后，历史轮仍能看到材料。

> 数据口径：用户已确认现有数据可删除；本次是**加法字段**，旧记录没有材料时按空处理，不主动清库。若想从干净看板开始，在 DSH 停止时删除 `~/.dsh/storages/commander`（域数据，不可恢复），再启动/重装。

---

## 4. 修复记录

- **2026-11-20 14:4x**：live 详情 API 已返回 `reportMaterials`，但看板抽屉不显示材料。根因是 Client 的 `normalizeTaskDetail()` 只透传白名单字段，漏了 `reportMaterials`，导致 `buildTaskRounds()` 拿到空数组。修复：归一化时透传 `reportMaterials`（以及 `acceptanceHistory[].materials` 原样保留），补 `tests/client/state.test.ts` 回归。仅 Client 产物变更，硬刷新即可。

## 5. 自动抓取会话回复（2026-11-20 追加）

- 初版只实现了「`present` 自动归并 + 指挥官显式 `materials`」，不会从工作会话回复文本里自动抓链接/图片；用户看到的任务只有 2 份 `present` 文档属于预期行为。
- 已补：报告窗口内**最后一条 assistant 文本**的 Markdown 图片、Markdown 链接、裸 URL 自动转为 `source:'session'` 材料；代码围栏/行内代码不抓；本地文件链接不抓（本地文档仍以 present/显式材料为准）；每次最多 12 条，图片优先；与显式/present 按 URL/realpath 去重。
- 该逻辑只在**下一次 `organize_report`** 时写库，已有任务不会回溯补材料。

## 6. 修复记录（续）

- **2026-11-20 16:5x**：自动抓取的裸 URL 末尾带中文句号/括号时，`new URL` 会把 `。` 编码成 `%E3%80%82`，产生 `...launch)%E3%80%82` 这类坏链接。修复：抓取前循环剥掉 `)。，、；：！？` 等末尾标点；补单测。已有任务需下一次 `organize_report` 才会重写材料，旧记录不会自动改。

## 7. 修复记录（续 2）

- **2026-11-20 17:0x**：Markdown 链接列表（`[A](url)、[B](url)、…`）中的 URL 被 **裸 URL 扫描** 二次抓取，产生 `...a2ui)、[10-29`、`...launch)%E3%80%82` 这类坏链接和重复项。修复：先记录并移除 Markdown 链接 span，再扫描裸 URL；裸 URL 字符集排除 `) ] ( [ 、，。；：！？` 等分隔/句读字符；保留末尾标点剥离。补单测覆盖用户截图中的 5 条链接列表。已有任务需下一次 `organize_report` 才会重写材料。

## 8. 已知限制

- 本地文档动作单当前只提供「复制路径」；系统应用打开/Sidebar 预览作为后续增强。
- 远程图片/链接只做 URL 语法校验，Host 不抓取；UI 标「外部链接，未校验」。
- 本地图片经 Host 签名路由读取，上限 8 MiB；超过上限按 `too_large` 只展示文件行。
- 未做 live 视觉走查（重装/重启由用户执行）。
