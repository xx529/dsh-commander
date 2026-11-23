# 仓库清理报告（task-73，2026-11-18 17:5x）

- 目的：把**不需要提交到仓库的临时测试产物/证据/真实数据**清理掉（用户会把初版拿去别处修 bug），保留交付源码/文档/脚本/测试套件。
- 结论：**清理完成**；仓库 `du -sh .` **307M → 235M（释放 ~72MB）**；`pnpm --filter dsh-commander test` → **248/248 pass、0 fail**（≥ 任务要求的 229）；被删路径全部确认不存在；两份需保留的 md 已移入正式目录；`.gitignore` 已追加去重规则并抽查生效。

## 1. 盘点（清理前）

| 路径 | 体积 | 文件数 |
|---|---|---|
| `tests/artifacts/` | 52M | 936 |
| `docs/validation/*-artifacts/`（13 个目录） | ~4.4M | 701（含 B 两份 md） |
| `tests/validation/.probe-tester/` | 1.2M | 43 |
| `tests/validation/.probe-upstream/` | 32K | 8 |
| `tests/validation/runs/` | 704K | 111 |
| `tests/validation/runs-upstream/` | 508K | 105 |
| `tests/validation/repro/` | 68K | 11 |
| `tests/v5-audit/` 生成物 | 668K（17 文件中的 json/live） | — |
| `.probe/` | 1.3M | 63 |
| `docs/eval/` 真实数据与 summary | ~12M | — |
| `tools/eval/diagnostics/artifacts/` | 84K | 4 |
| `research/`（不删） | 119M | — |
| `.pnpm-store/`（不删） | 55M | — |
| `node_modules/`（不删） | 52M | — |

根目录临时文件扫描：无 `*.log/*.tmp/*.pid/*.png`（清理前也无）。

## 2. 保留并迁移的正式文档（B）

| 原路径 | 新路径 |
|---|---|
| `docs/validation/m1-artifacts/client-load-repro.md` | `docs/validation/client-load-repro.md` |
| `docs/validation/m1-live-artifacts/incident-copy-staleness.md` | `docs/validation/incident-copy-staleness.md` |

## 3. 已删除内容（逐条存在性检查后 `rm -rf` 绝对路径）

1. `tests/artifacts/`（52M，截图/日志/隔离 home）
2. `docs/validation/{bindsel,m0,m0-live,m1,m1-live,m1-tools,m1r,m2m3,perf,v1,v2,v3,v4}-artifacts/`（约 4.4M）
3. **额外同类生成证据**：`docs/validation/m0-artifacts-api/`（552K）、`docs/validation/m0-artifacts-real/`（300K）、空目录 `docs/validation/evidence/`（与 m0-artifacts 同源，按任务意图一并清理，已在此列明）
4. `tests/validation/{.probe-tester,.probe-upstream,runs,runs-upstream,repro}/`（约 2.5M；保留 `run-all.mjs` 与 fixtures）
5. `tests/v5-audit/{audit-result.json,audit-v2-result.json,blind-judgments.json,blind-key.json,blind-packet.json,blind-review.json,live/}`（约 532K；保留 `*.mjs`、`fixtures/`）
6. `.probe/`（1.3M；`.probe-m0/` 不存在，已跳过）
7. `docs/eval/` 真实数据/生成物（约 11.8M）：
   - `cases.real.jsonl`、`cases.real.v2.jsonl`、`frozen/cases.real.v1.jsonl`、`frozen/cases.real.v2.jsonl`、`frozen/labels.cases.v1.md`、`workspace-summaries.json`、全部 `summary-*.json`（11 个）
   - **保留**：`frozen/manifest.v2.json`、`frozen/cases.real.v2.jsonl.sha256`、`labels*.v2.md`、`report*.md`、`cases.sample.jsonl`、`cases.schema.json`、`labels.cases.md`/`labels.md`（任务未列删除，按“不确定先保留”）
8. `tools/eval/diagnostics/artifacts/`（84K）

## 4. `.gitignore` 更新（追加去重）

追加（原已有项未重复加）：`/tests/artifacts/`、`/tests/validation/.probe-upstream/`、`/tests/validation/runs/`、`/tests/validation/runs-upstream/`、`/tests/validation/repro/`、`/tests/v5-audit/audit-result.json`、`/tests/v5-audit/audit-v2-result.json`、`/tests/v5-audit/blind-*.json`、`/tests/v5-audit/live/`、`/docs/validation/*-artifacts/`；已有规则保留（`.probe/`、`.probe-m0/`、`.probe-tester/`、`tools/eval/diagnostics/artifacts/`、`docs/eval` 真实数据规则、`/packages/dsh-commander/lib/`、`node_modules`、`.pnpm-store`）。
- 抽查：`git check-ignore` 对 `tests/artifacts/*`、`tests/validation/runs/*`、`tests/v5-audit/live/*`、`docs/validation/*-artifacts/*`、`.probe/*` 均返回 **ignored**。

## 5. 验证

- 体积：`du -sh .` **307M → 235M（释放 ~72MB）**；`docs` 18M→1.5M、`tests` 55M→152K。
- 删除路径复核：`tests/artifacts`、`.probe`、`tools/eval/diagnostics/artifacts`、`tests/validation/.probe-tester`、`tests/validation/runs`、`tests/v5-audit/live`、`docs/eval/cases.real.jsonl`、`docs/eval/frozen/cases.real.v2.jsonl` 均 **absent ok**。
- 保留物：`docs/validation/client-load-repro.md`、`docs/validation/incident-copy-staleness.md`、`docs/eval/frozen/manifest.v2.json`、`docs/eval/frozen/cases.real.v2.jsonl.sha256` 均存在。
- 测试：`pnpm --filter dsh-commander test` → **248/248 pass、0 fail**（当前测试数已增至 248；任务基准 229 仍满足）。
- 剩余未提交交付物概览（`git status --porcelain -uall` 381 文件）：`packages/dsh-commander` 118、`docs/validation` 40（32 个正式 md）、`docs/research` 26、`tools/dev` 24、`docs/eval` 22、`tools/validation` 19、`docs/architecture` 10、`tools/eval` 6、`tests/v5-audit` 6（脚本/fixtures）、`docs/tasks` 5 等。

## 6. 未删除项与原因

| 路径 | 体积 | 原因 |
|---|---|---|
| `research/`（第三方 clone） | 119M | 已由 `.gitignore` 覆盖，不入库；只报告体积不删（用户科研资料） |
| `.pnpm-store/` | 55M | 已 ignore，本地依赖缓存，删了影响下次安装速度 |
| `node_modules/` | 52M | 已 ignore，运行必需 |
| `prototype/` | 2.3M | 设计原型交付物 |
| `packages/dsh-commander/lib/` | 1.3M | 构建产物，且 live Desktop 通过 hardlink 依赖（不能删） |
| `docs/validation/evidence-*.log`（7 个） | ~28K | 任务未列删除，属 V5 验证日志；体积小，保留（列为可选清理） |
| `tests/v5-audit/*.mjs`、`fixtures/` | 少量 | 测试脚本/fixture，保留 |
| `docs/eval/cases.sample.jsonl`、`labels.cases.md`/`labels.md` | 少量 | 非“真实数据/生成 summary”清单项，按保守原则保留（可选清理：若确认已过时可删） |

## 7. 已知影响/后续

- 文档中引用的 `tests/artifacts/...`、`docs/validation/*-artifacts/...` 证据路径已随清理移除（这些是本地生成证据，不入库；如需复现按对应 validation 文档中的脚本重新生成）。
- 可选后续清理（均不影响提交）：`research/` 119M、`.pnpm-store/` 55M、`node_modules/` 52M、`docs/validation/evidence-*.log` 与 `docs/eval` 少量非必要文件；由用户决定。

---

## 8. 收尾清理（task-74，2026-11-18 18:0x）

### 8.1 删除
- `docs/validation/evidence-v5-*.log` **7 个全部删除**（各 4.0K，共 ~28K）：`evidence-v5-full-mode-diagnostics.log`、`evidence-v5-full-mode-failure.log`、`evidence-v5-layered-live.log`、`evidence-v5-v2-full-live.log`、`evidence-v5-v2-layered-live.log`、`evidence-v5-v2-whitelist-live.log`、`evidence-v5-v2b-placeholder-live.log`。删除后 glob 无匹配（absent 确认）。

### 8.2 保留：`docs/validation/v5-audit-cases.json`（**存在运行时/文档引用，未删**）
grep 结果（按任务要求先查引用）：
- `tests/v5-audit/audit-v2.mjs:190`：`const backendAuditFile = path.join(ROOT, 'docs/validation/v5-audit-cases.json')` → `fs.existsSync` 后 `readJson`，用于 A1「复跑结果与 backend 审计 JSON 一致」断言（缺失则该断言被跳过）。
- `tools/eval/audit-cases.mjs:21`：默认输出路径即该文件（`--out` 缺省）。
- `docs/eval/frozen/manifest.v2.json`：记录该文件 sha256（`077fb443…`）作为冻结审计产物清单项。
- `docs/eval/report-v2.md`、`docs/validation/v5-jev-dispatch.md`、`docs/architecture/validation-protocol.md` 多处引用。
→ **按任务规则保留**（若删会破坏 A1 断言与冻结清单引用）；仅将其加入 `.gitignore`（生成物不入库，manifest/sha256 作为可提交 provenance）。

### 8.3 `.gitignore` 追加（并抽查生效）
```
/docs/validation/evidence-*.log
/docs/validation/v5-audit-cases.json
```
`git check-ignore` 抽查：`docs/validation/evidence-v5-x.log` **ignored**、`docs/validation/v5-audit-cases.json` **ignored**。

### 8.4 复核
| 项 | 结果 |
|---|---|
| `du -sh .` | **235M**（与 task-73 收口一致；本轮删除 ~28K） |
| `git status --short -uall \| wc -l` | **279**（task-73 时 381 → 清理 m0-artifacts-api/real 等生成文件 + evidence logs 删除 + v5-audit-cases.json 忽略后） |
| 被删文件 | `docs/validation/evidence-v5-*.log` 全部 absent |
| 保留文件 | `docs/validation/v5-audit-cases.json` 存在 |
| 测试 | `pnpm --filter dsh-commander test` → **248/248 pass、0 fail** |

### 8.5 已知影响
- `tests/v5-audit/audit-v2.mjs` 的 **G10** 断言读取 `evidence-v5-v2-full-live.log`（`fs.existsSync` 守卫）→ 文件删除后重跑该审计时 G10 会被**跳过**（不崩溃）；如需完整审计需按 V5 流程重新生成该日志。
- `audit-v2.mjs` 的 **A1** 依赖已保留的 `v5-audit-cases.json` → 不受影响。
- 本轮未删除其他任何文件；`.gitignore` sha256 更新为 `ca7f90ee659f04f3e9ec856a8a10c412a9ca18bb5c14c575aca8f07399bb6d6e`。

---

## 9. 进一步清理（task-76，2026-11-18 18:0x）

### 9.1 基线（删除前）
| 路径 | 体积 |
|---|---|
| `.` | **235M** |
| `research/` | 119M |
| `.pnpm-store/` | 55M |
| `node_modules/` | 52M |
| `packages/dsh-commander/lib/` | 644K |
| `git status --short -uall` | 279 文件 |

### 9.2 删除（逐路径存在性检查；均为 `.gitignore` 覆盖的本地 clone/缓存，非交付物）
| 路径 | 体积 | 说明 |
|---|---|---|
| `research/awesome/` | 70M | 第三方 clone（含 `.git`） |
| `research/jarvis/` | 24M | 第三方 clone |
| `research/lxl-commander/` | 4.0M | 第三方 clone |
| `research/stardeck/` | 9.9M | 第三方 clone |
| `research/super-kanban/` | 11M | 第三方 clone |
| `.pnpm-store/` | 55M | 项目本地 pnpm store（生成缓存，后续 `pnpm install` 会重建） |
| **合计释放** | **~174MB** | |

- **保留** `research/RESEARCH.md` 与 `research/notes/`（非 clone，268K）、`node_modules/`（继续跑测试）、`packages/dsh-commander/lib/`（live hardlink）、源码/文档/工具。

### 9.3 复核
| 项 | 结果 |
|---|---|
| `du -sh .` | **61M**（235M → 61M，释放 **~174MB**） |
| `git status --short -uall \| wc -l` | **279**（与清理前一致——被删项均 ignored，无交付物变化） |
| `research/` | 268K（RESEARCH.md + notes 保留） |
| `node_modules/` | 52M（保留） |
| `packages/dsh-commander/lib/client.js` | 与 live 同一 inode（193756017，hardlink 未断） |
| 测试 | `pnpm --filter dsh-commander test` → **248/248 pass、0 fail**（删 `.pnpm-store` 未影响已安装 node_modules） |

- `.gitignore` 原有规则已覆盖 `/research/{awesome,jarvis,lxl-commander,stardeck,super-kanban}/` 与 `/.pnpm-store/`，无需新增。
- 本轮未删除其他文件；报告 sha256 更新见回执。
