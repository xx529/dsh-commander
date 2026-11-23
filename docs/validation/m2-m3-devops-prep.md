# M1R / M2 / M3 DevOps 准备（构建、live 重载、验收清单）

- 结论：**准备就绪**（verify-live 口径已修正、live 重载脚本就绪、install 预检覆盖新阶段、当前 build + 只读复查 PASS）
- 执行人 / 时间：devops / 2026-11-18 09:23–09:45
- 环境：`live origin=http://127.0.0.1:64918`（当前 `$DSH_WEB_URL`）；仓库 `/Users/lzx/Documents/GitHub/dsh-commander`；**本轮未写 live profile、未重启 DSH、未改实现**
- 证据：`docs/validation/m1r-artifacts/`（运行脚本产生；本次预检/复查输出见下）

## 1. 交付与变更

| 文件 | 变更 |
|---|---|
| `tools/dev/verify-live-m0.mjs` | **`EXPECTED_INJECT` 修正为三项** `[ui-layout, ui-settings, @deepseek-ai/dsh-client-locale]`（HANDOVER §3.4 指出的误报）；补断言「commander entry 存在且 `immediately:true`」；用法注释同步 |
| `tools/dev/m1r-live-reload.sh` | **新增** M1R/M2/M3 live 重载流程脚本：默认 dry-run（预检 + 打印 plugin_manager 三动作与 CLI 等价命令）；`--post-verify` 只读复查（health/state/config/jev + verify-live）；`CONFIRM_LIVE=yes ALLOW_CLI_RELOAD=yes` 仅限用户终端执行 CLI remove+add（agent 沙箱禁止写 `~/.dsh`，会 REFUSE 并给指引） |
| `tools/dev/install-live-m0.sh` | 复核 + 小修：profile 快照 summary 不再混入 node 警告（修 `installed=unknown`）；其余覆盖保持（build 产物、verify-bundle、repo/live `lib` 文件集一致性、bundles/package.json dependency、快速基线、回滚/安装命令打印） |

## 2. 当前构建与产物（prep 快照；M1R/M2/M3 代码仍在开发中）

```bash
cd /Users/lzx/Documents/GitHub/dsh-commander
pnpm --filter dsh-commander build         # exit 0
node tools/dev/verify-bundle.mjs packages/dsh-commander/lib/client.js dsh-commander   # exit 0
```
- `lib/client.js` **140,130B**、sha256 `4538ed2e4a65f6377502308b2a64d303e32e5afe73d1d52bdf681ed2ca824a75`；verify-bundle 9 项 PASS（host 产物同 build 生成）
- 说明：此构建是当前工作区源码快照（含队友进行中的 M1R/M2/M3 改动）；**阶段验收时必须用最终代码重跑 build**（见 §6 清单）。

## 3. verify-live 修正前后对比

| 项 | 修正前 | 修正后 |
|---|---|---|
| `EXPECTED_INJECT` | 2 项（ui-layout/ui-settings） | **3 项**（+`@deepseek-ai/dsh-client-locale`） |
| boot graph 断言 | `client inject = H3a 两项`（client 修 TOP1 后必误报 FAIL → 脚本 exit 1） | `client inject = 三项` + **`client entry exists + immediately:true`** 独立断言 |
| 注释 | 旧口径 | 用法注释同步（三项 + token URL 说明） |

修正后实测（`--origin http://127.0.0.1:64918`，无 token）：**exit 0，15 PASS + 1 SKIP**（页面 boot graph/client bundle 需带 token URL；有 token 时应连 inject 三项与 `immediately:true` 一起 PASS）；health `{ok:true,version:"0.1.0",panel:"present",binding:"bound"}`、state 200、config 200。
> 待办：拿到含 token 的浏览器 URL 后跑 `--url '<origin>/?token=…'`，把页面 boot graph/client bundle 两项补成 PASS 作为阶段验收证据。

## 4. live 重载流程（脚本化；上一阶段已实测）

上一阶段 live 实测（`docs/validation/m1-boot.md` §6、§7.9/§7.10；`docs/HANDOVER.md` §3.3）：
- **重载方式**：`plugin_manager remove_bundle` → `install_bundle file:<绝对包路径>` → `set_plugin` 重载；**无需整机重启 DSH**。
- **快照语义**：安装是“安装时快照”；**新增 lib 文件或 `tsc` 原子重写断开 hardlink 后，单纯刷新/重启不会同步** → 必须重装/重载（`m0-live-install.md` §7.7/§7.8、`m1-boot.md` §7.9）。
- **沙箱限制**：devops agent 不能写 `~/.dsh`（workspace-write）→ 脚本默认 dry-run，只打印给 Lead 执行；user 终端可用 CLI 等价路径。

本次 dry-run 输出（`OUTDIR=/tmp/m1r-prep`，节选）：

```bash
# 0) 构建最新（devops 已完成；如代码有更新先重跑）
cd /Users/lzx/Documents/GitHub/dsh-commander && pnpm --filter dsh-commander build
# 1) 卸载旧的安装快照
plugin_manager action=remove_bundle target=dsh-commander
# 2) 从最新构建的绝对路径安装
plugin_manager action=install_bundle target=/Users/lzx/Documents/GitHub/dsh-commander/packages/dsh-commander
# 3) 重载插件（不重启整机 DSH）
plugin_manager action=set_plugin target=dsh-commander enabled=true
#    等价 CLI（用户终端；会写 ~/.dsh）：
#    dsh plugin --profile desktop remove dsh-commander && dsh plugin --profile desktop add /Users/…/packages/dsh-commander
# 4) 重载后只读复查
bash /Users/lzx/Documents/GitHub/dsh-commander/tools/dev/m1r-live-reload.sh --post-verify
```

预检（dry-run）结果：lib 文件集一致 `repo=39 live=39`；profile dependency=`file:/Users/…/packages/dsh-commander`、bundleListed=true、bundleCount=42；`RESULT: PASS`。
post-verify 结果（当前 live，只读）：health 200、state 200（rev=5、bound、pendingDispatch=null、workspaces=29、tasks=4、messages=2）、config 200、`jev/test ok:true`（model `jev-1.14.0`、latencyMs 945、hasApiKey true）、`verify-live-m0 --origin` **exit 0**；`RESULT: PASS`。

## 5. 回滚

```bash
plugin_manager action=remove_bundle target=dsh-commander     # 卸载（域数据保留）
# 回滚到上一构建：checkout 目标 commit → pnpm --filter dsh-commander build
#                → plugin_manager install_bundle file:<包绝对路径> → set_plugin 重载
# 回滚验证：GET /commander/health 不可达 / dsh --profile desktop --dump-config | grep -c "name: 'dsh-commander'" = 0
```

## 6. 阶段验收前检查清单（M1R / M2 / M3 通用）

- [ ] `pnpm --filter dsh-commander build` exit 0；`node tools/dev/verify-bundle.mjs packages/dsh-commander/lib/client.js dsh-commander` exit 0
- [ ] `pnpm --filter dsh-commander typecheck` exit 0；`pnpm --filter dsh-commander test` 全绿（记录条数）
- [ ] `bash tools/dev/install-live-m0.sh` → PASS（repo/live lib 文件集一致、bundles/dependency 正确；**新增 lib 文件时必须重装**）
- [ ] 隔离验证先行：`tools/dev/check-m1-increment.sh` / `check-m1-tools.sh` /（后续阶段脚本）新 home exit 0；关键 API（health/state/tasks/dispatch）PASS
- [ ] Lead 执行重载：`plugin_manager remove_bundle` → `install_bundle file:<abs>` → `set_plugin`（或用户终端 CLI）；**不要只重启**
- [ ] 重载后：`bash tools/dev/m1r-live-reload.sh --post-verify` exit 0；`verify-live-m0.mjs --url '<含 token URL>'` 页面 boot graph/client bundle 断言（inject 三项 + immediately）PASS
- [ ] live 侧关键业务断言（本阶段定义）：确认卡/dispatched/queued/running、看板/设置页、SSE 推送等（由 tester/lead 走查）；证据落 `tests/artifacts/<phase>/live/`
- [ ] 回滚演练：remove_bundle 后 health 不可达；重装后恢复
- [ ] 全程不重启整机 DSH（除非用户要求）；不写 live profile（命令由 Lead/用户执行）

## 7. 后续

- task-54（M1R 构建/隔离验证，blocked_by task-47/48）与 task-55（M2/M3 构建/隔离验证/live 重载，blocked_by 49/50/51/52）解锁后按本清单执行；每阶段回执 lead。
- 拿到页面 token URL 后补一次页面级 verify（inject 三项断言）。
