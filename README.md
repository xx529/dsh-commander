# DSH Commander · 指挥官

> 跑在 DSH（DeepSeek Harness）里的指挥官调度插件：一个悬浮球/面板，一句话下命令，指挥官澄清、判定派发目标、把任务交给合适的工作区会话、维护看板，并把工作会话的产出整理成验收内容；**只有派发确认和最终验收需要你拍板**。

---

## 当前状态（2026-11-22）

- **M0 / M1 / M1R / M2 / M3 已实现并通过验收**：M0 悬浮球+面板+绑定、M1 工具/全确认派发、M1R 自定义 attach、M2 看板（六列/详情抽屉/人工改动/取消/归档/恢复）、M3 闭环（turn/end 注入、`commander_task_report`、审批悬浮卡、accept/continue、播报）；**任务状态机定案 v1.0** 已实现：统一迁移入口、`commander_task_get`、`commander_task_update` action enum + expectedRevision、`dependsOn`/ready 依赖编排与 `[task-unblocked]`/`[task-dependency-blocked]` 提醒（契约 `docs/architecture/task-state-machine-final.md`）。
- **M5 多轮追加派发已实现**：review 任务可继续派发（round+1、上一轮验收进历史、默认原会话/可换工作区）；看板「返工」统一为「继续派发请求」→ 通知指挥官再派发；详情按轮展示用户原话与派发 brief 原文，看板卡显示「第 N 轮」。契约见 `docs/architecture/m5-continue-dispatch.md`。
- **报告材料（方案 A）已实现**：每轮「整理报告」的结论下新增「依据与材料」，支持外链、本地文档、本地/远程图片；`commander_task_report` 显式材料 + 工作会话 `present` 自动归并 + 最后回复中的 Markdown 链接/图片自动抓取，本地图片走签名资产路由。契约见 `docs/architecture/materials-contract-patch.md`。
- 测试：`pnpm --filter dsh-commander test` → **373/373 pass**；另有隔离真实 Host e2e（m1/m1r/m23）、client harness（smoke 51/51 + interact 182/182）。
- **V5 自动派发门禁未通过（FAIL）**：用户决策为**忽略 V5 门禁、降级为「每次派发人工确认」**（`autoDispatch=false`，全确认模式）。**不得表述为 V5 PASS**；V5 报告与重开门条件见 `docs/validation/V0-GATE.md`。
- **M4 P1 原生壳已实现**（macOS Tauri 2 壳：独立悬浮球 + 面板 + Option+Space + 位置持久化 + 看板/验收 + 条件审批 + 双球互斥，见 `docs/architecture/native-shell-contract.md`）；跨 Space/全屏、问答卡、Windows 与 V6–V8 尚未验证。
- 插件已可安装到 DSH profile，live 实机验证过球/面板/确认卡/绑定切换。

---

## 快速开始

```bash
# 1) 依赖 / 构建 / 类型检查 / 测试
pnpm install
pnpm --filter dsh-commander build
pnpm --filter dsh-commander typecheck
pnpm --filter dsh-commander test          # 373/373
pnpm --filter dsh-commander build:native  # 可选：macOS 原生壳（需要 Rust + Xcode CLT）
bash tools/dev/install-native-shell.sh    # 只读预检：产物/签名/profile + 打印安装命令

# 2) 校验 Client bundle（官方 ModuleLoader wrapper）
node tools/dev/verify-bundle.mjs packages/dsh-commander/lib/client.js dsh-commander
```

**安装到 DSH profile（用户操作；会重启/重载 DSH）**

```bash
# 首次安装（file: 本地包；路径按本机实际）
dsh plugin --profile desktop add /Users/lzx/Documents/GitHub/dsh-commander/packages/dsh-commander
```

重载规则（**重要**）：
- 仅 **Client 已存在文件** 的改动：构建后**硬刷新页面**即可（§安装副本是 hardlink）；
- **新增 lib 文件 / Host 代码 / `dsh.client.inject` 变更**：必须 **remove + add 重装**（或 `plugin_manager remove_bundle/install_bundle`）+ **重启 DSH**；只刷新/只重启不会带入新文件；
- 升级前可跑 `bash tools/dev/install-live-m0.sh` 做只读预检（lib 文件集一致性）。

**关键验证脚本（均不碰 live，使用一次性 `DSH_HOME`）**

```bash
node packages/dsh-commander/tests/e2e/m1-e2e.mjs        # M1 派发
node packages/dsh-commander/tests/e2e/m1r-e2e.mjs       # 自定义 attach
node packages/dsh-commander/tests/e2e/bind-select-e2e.mjs  # 设置页选择已有会话
node packages/dsh-commander/tests/e2e/m23-e2e.mjs       # M2/M3
bash tools/dev/check-m2m3.sh                            # M2/M3 隔离检查
bash tools/dev/client-repro.sh                          # 无头 Chrome 复现 client 加载/console
node tools/dev/verify-live-m0.mjs --url '<带 token 的页面 URL>'   # live 健检查
```

---

## 仓库结构

```
packages/dsh-commander/     # 唯一插件包（双半 bundle）
  src/host/                 # Host：domain/stores、/commander 路由+SSE、统一状态机、派发/依赖提醒、turn/end 注入、工具
  src/client/               # Client：shell.overlay 球+面板、main keyed 六列看板、设置页、审批悬浮卡
  tests/                    # unit / integration / client(harness) / e2e
  lib/                      # 构建产物（lib/host/**、lib/client.js）
tools/                      # 构建/校验/隔离复现/验收脚本（dev/、validation/、eval/）
docs/                       # 产品/架构/交接 + architecture/、validation/（验收/审计）、eval/、research/、tasks/
prototype/                  # v3 交互原型与截图（视觉参照）
research/                   # 调研笔记；第三方 clone（awesome/jarvis/stardeck/super-kanban 等）本地保留、不入库
```

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/PRODUCT-DESIGN.md`](docs/PRODUCT-DESIGN.md) | 产品设计 v1.8：职责边界、Jev 派发、看板、验收、设置页、数据模型 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 架构 v2.4：双半插件、记录模型、状态机、工具、注入 |
| [`docs/architecture/task-state-machine-final.md`](docs/architecture/task-state-machine-final.md) | **任务状态机定案 v1.0**：9 状态/迁移矩阵/工具/依赖/六列看板 |
| [`docs/NEXT-PHASE.md`](docs/NEXT-PHASE.md) | 阶段范围/验收/停止条件（含冻结决策） |
| [`docs/HANDOVER.md`](docs/HANDOVER.md) | **开发交接**：现状/快速上手/契约/坑/剩余项/开发约定 |
| [`docs/architecture/implementation-plan.md`](docs/architecture/implementation-plan.md) | 实现蓝图与 M0–M3 契约（含 m0/m1/m2m3 补丁） |
| [`docs/validation/`](docs/validation/) | V0 门禁、M0/M1/M1R/M2/M3 验收与审计、cleanup-report |
| [`docs/validation/cleanup-report.md`](docs/validation/cleanup-report.md) | 仓库清理记录（临时证据/真实数据已清理，源码/文档/测试保留） |
| [`docs/eval/`](docs/eval/) | V5 Jev 派发评测（方案/报告/冻结数据） |
| [`prototype/README.md`](prototype/README.md) | 原型 v3 说明与截图索引 |

---

## 已知限制（务必先读）

1. **全确认模式**：当前默认每次派发都需人工确认（`autoDispatch=false`）；V5 未通过，**不要擅自开启自动派发/放宽阈值**（重开门条件见 `docs/validation/V0-GATE.md`）。
2. **会话列表性能边界**：fresh 大工作区 `limit=50` 时 >2s（capability-settings 实测 3.85–5.30s）；**UI 已固定 `limit=20`**（0.18–1.2s）。后端分页/缓存为后续优化项，放大 limit 前先加分页。
3. **V6–V8 未做正式验证**：V6 审批双处渲染、V7 Host→Client 推送、V8 插件重载目前只有实现/事实证据，缺正式验证记录。
4. **M4 P1 已做、P2 未做**：macOS Tauri 壳可脱离 DSH 窗口运行；跨所有 Space/全屏、审批/问答接管、Windows 属 P2。壳未签名，仅限本机 `file:` 安装。
5. **工程收尾**：git 仍有未提交改动、未接 CI、缺 `docs/retro` 复盘；改动前先看 `docs/HANDOVER.md`。
6. **看板不再支持拖拽改状态**：人只保留 accept/archive/restore/cancel 按钮；`PATCH /board/tasks/:id` 仅 priority/title。
7. **live UI 部分项为环境性 UNVERIFIED**（物理点击/截图能力限制），替代证据为 harness/e2e/单测；详见 `docs/validation/m2-accept.md`、`m3-accept.md` 与 HANDOVER §5（含 UNVERIFIED 清单）。

---

## 不做什么

- 不改 DSH 冻结决策（见 `docs/NEXT-PHASE.md` §2）；
- 不自建能力目录/Resolver、不做 scheduler/投影/事件表；一期不实现原生壳（M4 P1 例外，见契约文档）；
- 不重复实现 DSH 已有能力（能力选择交给 DSH 能力面板；审批只在界面层）；
- 指挥官**不拆分工作、不评估结果**，只整理产出为验收内容；
- 不引入新概念/新事件类型/新表；只有 DSH 内形态。
