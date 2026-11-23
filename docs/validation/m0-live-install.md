# M0-1 live 安装（desktop profile）—— 执行单 / 模板

- **状态：已安装 + 安装后健康检查已跑（Lead 于 2026-11-17 21:11 通过 plugin_manager 装入 desktop profile，运行中 Host 已激活；devops 未写 live profile、未重启 DSH）**。
- 安装方式：Lead 用 `plugin_manager action=install_bundle`（等价 CLI：`dsh plugin --profile desktop add <绝对包路径>`）；结果与隔离 profile 一致（profile dependency + bundles 追加）。
- 准备人：devops / 2026-11-17
- 前置：M0-0 构建 spike PASS（`docs/validation/m0-build-spike.md`）；M0-2 隔离 API 形状验证（`docs/validation/m0-api-shapes.md`）；H3a：client 唯一消息通道只走 Host `/commander/message`+SSE（`dsh.client.inject` 已移除 `@deepseek-ai/dsh-api-remotes`）。
- 相关脚本（绝对路径）：
  - 安装预检/执行：`/Users/lzx/Documents/GitHub/dsh-commander/tools/dev/install-live-m0.sh`
  - 安装后健康检查：`/Users/lzx/Documents/GitHub/dsh-commander/tools/dev/verify-live-m0.mjs`
  - 证据目录：`/Users/lzx/Documents/GitHub/dsh-commander/docs/validation/m0-live-artifacts/`

---

## 0. 需要 Lead / 用户执行的动作与审批

| # | 动作 | 为什么 agent 不能做 | 审批/前置 |
|---|---|---|---|
| L1 | 在**自己的终端**执行 `dsh plugin --profile desktop add <绝对包路径>` | 该命令写 `/Users/lzx/.dsh/profiles/desktop/**`（live profile），devops 的沙箱（workspace-write）禁止写 `~/.dsh`；且安装 = 让插件代码在 Host 执行 | 用户已批准 M0 继续；本条属于 live 写入动作，需在终端执行 |
| L2 | 安装后**重启 DSH**（退出并重开 DeepSeek Harness） | 重启会中断当前会话/agent 进程；只有用户/Lead 能决定时机 | 建议在无进行中任务时重启；重启后本会话的 agent 进程会被终止 |
| L3 | 若失败：`dsh plugin --profile desktop remove dsh-commander` + 再重启 | 同 L1 的 live 写入 | 同上 |
| L4 | 浏览器手测（见 §5 清单）与截图 | 需要真实页面交互 | 用户/Lead |

> 推荐顺序：**L1 安装 → `--dump-config` 校验 → L2 重启 → devops 侧跑 verify-live-m0.mjs → 用户按 §5 手测**。

---

## 1. 安装前预检（只读；devops 已跑，可复跑）

```bash
cd /Users/lzx/Documents/GitHub/dsh-commander
pnpm --filter dsh-commander build          # 确保 lib 产物最新（Host tsc + Client tsdown+wrap）
bash tools/dev/install-live-m0.sh          # 预检：产物/verify-bundle/desktop profile 现状/快速基线；不写 live
```

预检输出（2026-11-17 21:1x，`docs/validation/m0-live-artifacts/preflight.log`）：

- 构建产物：`lib/host/index.js` 存在；`lib/client.js` **85992 B**，`verify-bundle` PASS
- desktop profile：**未安装** `dsh-commander`（`installed=false`、`bundleListed=false`，bundles 41 条、快照见 `profile-before-package.json`）
- 快速基线：`live-baseline-before-fast.txt`（desktop `package.json`/`pnpm-lock` 的 sha、`.env` stat、node_modules 顶层数、bundles 列表）
- 退出码：**0**

> 说明：默认**不做全树 hash**——运行中的 Desktop 上 `live-state.sh` 扫树可能 >5 分钟；需要时加 `LIVE_FULL_BASELINE=1`（脚本内 180s 超时保护）。

---

## 2. 安装命令（Lead 在终端执行；含绝对路径）

```bash
# 2.1 安装到 desktop profile（绝对路径；不要手写 profile 文件、不要在 profile 目录跑 pnpm）
dsh plugin --profile desktop add /Users/lzx/Documents/GitHub/dsh-commander/packages/dsh-commander

# 2.2 校验 profile 合成（应出现 commander host 行；退出码 0）
dsh --profile desktop --dump-config | grep -n -A3 "name: 'dsh-commander'"

# （可选）2.3 由脚本执行上面两步（仍写 live，需要显式确认；在 Lead 的终端里）
cd /Users/lzx/Documents/GitHub/dsh-commander
CONFIRM_LIVE_WRITE=yes bash tools/dev/install-live-m0.sh --execute
```

期望：
- `dsh plugin add` 退出码 0；desktop profile `package.json` 的 `dependencies` 增加 `"dsh-commander": "file:…/packages/dsh-commander"`；`dsh.profile.bundles` 末尾追加 `dsh-commander`（与隔离 profile 行为一致，见 M0-0 证据）。
- `--dump-config` 中出现 `- id: commander` / `name: dsh-commander`。
- 脚本 `--execute` 会额外落盘：`profile-after-package.json`、`bundles-diff.json`、`dump-config-after.yml`、`dump-config-commander.txt`、`live-baseline-after-fast.txt`。

**退出码记录（执行后回填）**：

| 命令 | 退出码 | 证据 |
|---|---|---|
| `plugin_manager install_bundle`（Lead 执行；等价 `dsh plugin --profile desktop add /Users/…/packages/dsh-commander`） | 0（Lead 侧确认安装成功，Host 已激活） | 本机 profile 检查见下；`profile-after-package.json`（快照） |
| `dsh --profile desktop --dump-config` | 安装后 Host 已激活 commander 行（`/commander/health` 200 即证；隔离 profile 的 dump-config 证据见 M0-0） | `docs/validation/m0-build-spike.md` 隔离同流程 |

实际安装结果（只读核对 `/Users/lzx/.dsh/profiles/desktop/package.json`）：
- `dependencies["dsh-commander"] = "file:/Users/lzx/Documents/GitHub/dsh-commander/packages/dsh-commander"`
- `dsh.profile.bundles` 末尾追加 `dsh-commander`（`bundleCount: 41 → 42`，`bundles.slice(-3) = ["dsh-notify-me","dsh-remote","dsh-commander"]`）
- `profiles/desktop/node_modules/dsh-commander/` 已就位（21:11 安装）。**更正（frontend 复核 + devops 实测 2026-11-17 21:40）**：不是独立副本，而是 **hardlink**——live 包文件与 repo `packages/dsh-commander/` 是同一 inode：
  - `lib/client.js`：repo/live 均 `ino=193756017, links=12, 85992B, sha256=692ceede…`
  - `lib/host/index.js`：repo/live 均 `ino=193756014, sha256=fcdda0b5…`
  - 抽样 `lib/host/{api/server.js,domain.js,config.js}`、`package.json`、`cordis.patch.yml` 两侧 inode 全部相同 → **repo 构建会原地更新 live 包文件**（内容自动跟随）；但运行中的 Host 持有启动时的 JS 与 boot manifest，**Host 行为/`dsh.client.inject` 变更需重启 DSH 才生效**。

---

## 3. 安装前后 profile bundles 差异（执行后回填）

```bash
# 脚本已生成：m0-live-artifacts/bundles-diff.json
# 期望：added 只含 "dsh-commander"，removed 为空；bundleCount +1（41 → 42）
```

| 项 | 安装前 | 安装后 |
|---|---|---|
| bundles 数量 | 41 | **42** |
| added | — | `["dsh-commander"]` |
| removed | — | `[]`（既有插件未被改动，已逐项 diff） |
| `dependencies["dsh-commander"]` | 无 | `file:/Users/lzx/Documents/GitHub/dsh-commander/packages/dsh-commander` |

---

## 4. 重启后健康检查（devops 执行；不依赖浏览器交互）

重启 DSH 后：

```bash
# 方式 A：从浏览器地址栏复制完整 URL（含 ?token=…）
cd /Users/lzx/Documents/GitHub/dsh-commander
node tools/dev/verify-live-m0.mjs --url 'http://127.0.0.1:<PORT>/?token=<TOKEN>'

# 方式 B：分参数
node tools/dev/verify-live-m0.mjs --origin http://127.0.0.1:<PORT> --token '<TOKEN>'

# 方式 C：环境变量（本会话已有 DSH_WEB_URL；token 需另给）
DSH_WEB_TOKEN='<TOKEN>' node tools/dev/verify-live-m0.mjs
```

脚本断言（退出码 0 = 全 PASS）：
1. 页面：无 token 401、带 token/cookie 200；
2. `GET /commander/health` 200 且 `ok:true`、`version:"0.1.0"`、**`panel:"present"`**（desktop 能力面板已装）、`binding` 字段存在；
3. `GET /commander/state` 200 且含 `rev/binding/commanderBusy/messages/workspaces`（binding 结构含 `sessionId`、messages 为数组）；
4. `GET /commander/config` 200（只读探测路由）；
5. 页面 `__DSH_BOOT__` 含 `dsh-commander` client 行：`inject=["@deepseek-ai/dsh-client-ui-layout","@deepseek-ai/dsh-client-ui-settings"]`（H3a 后两项）、`immediately:true`；Host 服务的 bundle 200 且为 `window.__ModuleLoader__.load({id:"dsh-commander",factory:…})`、require `react` external、**不 require `@deepseek-ai/dsh-api-remotes`**。

**健康检查结果（执行后回填）**：

实测（**`node tools/dev/verify-live-m0.mjs --origin http://127.0.0.1:51062` → exit 0，15 PASS / 1 SKIP / 0 FAIL**；原始输出 `m0-live-artifacts/verify-live-stdout.txt`）：

| 断言 | 结果 | 证据 |
|---|---|---|
| `/commander/health` 200 `panel:"present"` | **PASS**：`{"ok":true,"version":"0.1.0","panel":"present","binding":"bound"}` | `m0-live-artifacts/live-health.json` |
| `/commander/state` 字段齐全 | **PASS**：`rev`/`binding`/`commanderBusy`/`messages`/`workspaces` 全在；`rev:5`、`commanderStatus:"bound"`、`workspaces:28`、`messages:2`；binding = `{workspaceId:"425e43bd-…", workspacePath:"/Users/lzx/Documents/GitHub/dsh-commander", sessionId:"session-55f9f4dc-…"}` | `m0-live-artifacts/live-state.json` |
| `/commander/config` 200 | **PASS**（含 commander 绑定配置） | `verify-live-stdout.txt` |
| 页面 token fence | 无 token → 401（PASS）；浏览器页面 200 需带 token | 同上 |
| boot graph client 行（inject 两项/immediately） | **SKIP（N/A）**：无 token 页面 401，无法取页面 boot graph；需浏览器地址栏完整 URL（含 `?token=…`）复验 | 同上 |
| served bundle 官方包裹 + 无 api-remotes | **SKIP（N/A）**（同上；隔离环境已用同脚本逻辑验证 PASS，见 M0-0/M0-2） | — |
| `verify-live-m0.mjs` 退出码 | **0** | 同上 |

---

## 5. 浏览器手测清单（用户/Lead；截图存档）

- [ ] 刷新/重开 DSH 页面；右下或左下出现 **Commander 悬浮球**（`shell.overlay`）。
- [ ] 点击悬浮球 → 面板打开，**无“加载失败/崩溃”**提示（M0 空面板为预期）。
- [ ] 设置页出现 **Commander 设置分组**（M0 四组骨架）。
- [ ] 面板发一条消息 → 面板出现 **user echo**；若指挥官会话已绑定且模型可用，等待 assistant 回复出现（真实回合）。
- [ ] 插件管理页显示 **Commander** 名称/描述（locale 生效）；详情页可打开（DETAIL.md/icon 生效）。
- [ ] 截图：`docs/validation/m0-live-artifacts/screenshots/01-ball.png`、`02-panel.png`、`03-settings.png`、`04-roundtrip.png`（文件名可调整，放同目录）。
- [ ] 记录页面控制台是否有 `slot entry crashed` 等错误（有则截图 + 原文）。

---

## 6. 回滚（任一步失败或验收不通过）

```bash
# 6.1 从 desktop profile 移除
dsh plugin --profile desktop remove dsh-commander

# 6.2 重启 DSH（同 §0-L2，退出并重开）
# 6.3 回滚验证
node tools/dev/verify-live-m0.mjs --url 'http://127.0.0.1:<PORT>/?token=<TOKEN>'
#   期望：/commander/health 不可达（404/连接被拒由页面路由返回），脚本 exit 1 并提示“未加载 commander”
dsh --profile desktop --dump-config | grep -c "name: 'dsh-commander'"   # 期望 0
```

回滚后任务记录保留在 `commander` 存储域（域数据不随插件删除清空），重新安装即可读回。

**回滚验证结果**：未执行（当前验收通过，保留安装）；回滚命令见 §6，执行后回填：`/commander/health` 应不可达、`--dump-config | grep -c "name: 'dsh-commander'"` 应为 0、`bundleCount` 回到 41。

---

## 7. 注意事项 / 风险

1. **Host 半需要重启 DSH 才加载**；Client 半理论上可 HMR，但首次安装建议整体重启一次。
2. 重启会**中断当前会话/agent 进程**；请在无进行中任务时执行。
3. 若 `dsh plugin add` 报 pnpm 权限/`allowBuilds` 相关问题：按 CLI 提示把确切包键加入 profile 的 `pnpm-workspace.yaml`（`allowBuilds: { dsh-commander: true }`）——本包**没有** prepare/postinstall 脚本，正常情况下不需要。
4. 若 `--dump-config` 有 commander 行但重启后 `/commander/health` 404：优先查 ① 是否真的重启了（Host 半需重启）；② `dsh plugin --profile desktop why dsh-commander` 是否解析到本包；③ Host `apply` 是否因 `storageDomain`/`webServer` 注入失败（看 Desktop 日志/启动 stderr）。
5. 若 health 返回 `panel:"absent"`（desktop 期望 present）：确认 `dsh-capability-settings` 在 desktop profile 启用（它是 live 已装插件）。
6. 安装后**不要**在 profile 目录跑 `pnpm install/build`，升级走 `remove` + `add`（或重装新路径）。

---

## 7.5 M1 之前的注意项（live 现状）

1. **live 包文件是 hardlink（同一 inode），但仅限“安装时已存在”的文件**：`lib/**`、`package.json`、`cordis.patch.yml` 中安装当时存在的文件与 repo 同 inode（实测 client.js ino=193756017/sha 692ceede…；host/index.js ino=193756014/sha fcdda0b5…）。因此：
   - **已存在文件的改动**（改代码重建同名文件）会通过 hardlink 原地更新 → client 刷新/强刷即可，**不需 remove+add**。
   - **新增文件不会被自动带进已装副本**（M1 事故根因，见 §7.7）：`dsh plugin add file:` / `plugin_manager install_bundle` 是**安装时快照式复制/hardlink**；之后 build 新出现的 `lib/**/*.js`（如 `dispatch/capability.js`）不在 profile 里 → 运行时报 `ERR_MODULE_NOT_FOUND`。
   - **凡新增源文件/lib 模块，必须重新安装**：`plugin_manager remove_bundle` + `install_bundle file:<绝对包路径>`（或 `dsh plugin --profile desktop remove dsh-commander` + `add <绝对包路径>`），然后**重启 DSH**；单纯重启/刷新**不会**同步新文件。
   - **Host 半改动（含 `dsh.client.inject`）仍需重启 DSH**（boot 期 manifest 在启动时固定）。
2. **Host 半改动需重启 DSH**；`/commander/health` 200 说明 host 行已激活（当前运行的是安装时 JS）。
3. **live 已存在绑定**：`state.binding` 指向工作区 `/Users/lzx/Documents/GitHub/dsh-commander`（`session-55f9f4dc-…`，`commanderStatus:"bound"`，`rev:5`，`messages:2`）——这是 Lead/用户的手测结果，M1 开始前确认是否清空/复用。
4. **M0-3 重启后绑定不丢**：已验证隔离 home 的持久化（`m0-api-shapes.md` case A2：config/workspaces/binding 二次 boot 读回一致）；live 侧需重启 DSH 后复查 `/commander/state.binding`。
5. 手测清单（§5）尚未全部打勾（浏览器穿 token 的页面级检查 SKIP）；建议 Lead/用户在浏览器按 §5 走一遍并截图。

## 7.6 hardlink 快速核对命令（M0-1 验收/回归用）

```bash
# live 包与 repo 是否同一 inode（应输出相同 ino；client 内容一致）
stat -f '%N ino=%i links=%l size=%z' \
  packages/dsh-commander/lib/client.js \
  /Users/lzx/.dsh/profiles/desktop/node_modules/dsh-commander/lib/client.js
shasum -a 256 packages/dsh-commander/lib/client.js \
  /Users/lzx/.dsh/profiles/desktop/node_modules/dsh-commander/lib/client.js
```

> 注意：正因为 hardlink，**在 Desktop 运行期间跑 `pnpm build` 会改变已存在文件在 live profile 树里的 mtime/size**（内容即 repo 构建产物，非配置写入）；做 live 隔离基线时把这视为**预期副作用**，或以 `~/.dsh/profiles/desktop/package.json` + `pnpm-lock` 的 sha 作为 profile 配置是否被改的判据。

**升级/重装前后必须做「lib 文件集一致性」核对**（`install-live-m0.sh` 预检已内置）：

```bash
REPO=/Users/lzx/Documents/GitHub/dsh-commander
PKG="$REPO/packages/dsh-commander"
LIVE="$HOME/.dsh/profiles/desktop/node_modules/dsh-commander"
echo "repo js=$(find "$PKG/lib" -name '*.js' | wc -l)  live js=$(find "$LIVE/lib" -name '*.js' | wc -l)"
# 列出 repo 有、live 缺的新文件（应为空；非空 → 必须 remove+add 重装再重启）
comm -23 <(cd "$PKG/lib" && find . -name '*.js' | sort) <(cd "$LIVE/lib" && find . -name '*.js' | sort)
# 关键新文件存在性抽检（M1 示例）
for f in dispatch/capability.js dispatch/service.js dispatch/candidates.js jev/client.js tools/index.js; do
  test -f "$LIVE/lib/host/$f" && echo "ok $f" || echo "MISSING $f → 重装"
done
```

## 7.7 事故记录：安装副本陈旧导致 live 无球（2026-11-17，已修复）

- **现象**：重启后 live 无 Commander 悬浮球；`plugin_manager list_plugins` 显示 `include:commander` `fiberPhase=null`；重新 enable 报错原文：
  ```
  ERR_MODULE_NOT_FOUND .../profiles/desktop/node_modules/dsh-commander/lib/host/dispatch/capability.js
  ```
- **根因**：live 包是 **M0 时期安装的副本**（`plugin_manager install_bundle`/`dsh plugin add file:` 为安装时快照/硬链）；M1 构建新增了 `lib/host/dispatch/*.js`、`lib/host/jev/*.js` 等**新文件**，它们不在已装副本中；hardlink 只覆盖“安装时已存在”的文件，新文件不会自动出现 → Host fiber 加载失败。
- **修复**（Lead 执行）：`plugin_manager remove_bundle` → `install_bundle file:/Users/lzx/Documents/GitHub/dsh-commander/packages/dsh-commander` → 重启 DSH。
- **修复后实测**（devops 只读核查）：
  - repo 与 live 的 `lib/**/*.js` **均 39 个**（一致）；`dispatch/capability.js`、`dispatch/service.js`、`dispatch/candidates.js`、`dispatch/gate.js`、`dispatch/spawn.js`、`jev/client.js`、`tools/index.js` live 侧全部存在；
  - `GET /commander/health` → **200** `{"ok":true,"version":"0.1.0","panel":"present","binding":"bound"}`
  - `GET /commander/state` → **200**（`commanderStatus:"bound"`、`pendingDispatch:null`、workspaces=28）
  - `node tools/dev/verify-live-m0.mjs --origin http://127.0.0.1:<PORT>` → **exit 0（15 PASS + 1 SKIP 页面 token）**
  - `POST /commander/jev/test` → 200，`hasApiKey:true`，但本次返回 `code:"timeout", latencyMs:1502`（live Jev 配置的 timeoutMs=1500 内未返回；网络/端点问题待观察，非插件崩溃）
- **预防**：`tools/dev/install-live-m0.sh` 预检已内置「repo vs live lib 文件集一致性」检查（缺文件直接 FAIL 并提示重装）；**任何新增源文件后的安装/升级流程固定为：build → remove+add（或 remove_bundle+install_bundle）→ 重启 DSH**。
- **后续同类事故（客户端无球）已在 `docs/validation/m1-boot.md` §7.10 记录**：根因是 client `inject` 缺 `locale`（Cordis 未注入属性读取即 throw），修复为 inject 加 locale + 槽位前移 + apply 诊断日志 + `dsh.client.inject` 加 `@deepseek-ai/dsh-client-locale`；隔离无头 Chrome + live 硬刷新双验证 PASS；预防（严格 Proxy harness 回归 + `tools/dev/client-repro.sh`/`cdp-probe.mjs` 复现脚本）已落地。

## 7.8 M1 live 全链路验收 PASS 与「重装/重载」经验（2026-11-18 00:04）

- 真实模型全链路已在 live 跑通：`board_query → task_create → dispatch_task → needs_confirmation`（确认卡 `tests/artifacts/m1/live/33-confirm-card.png`）→ 采纳建议 → **dispatched，task running**，`primarySessionId` 已建；auto 策略 capability applied（enabled 5 / durationMs 982），`session-capabilities.json` 已写新会话（cwd=`/Users/lzx/Documents/sunteng/Htdot-OrderCenter`）；final state `pendingDispatch:null`、counts `{draft:1,running:2}`、health 200。证据：`tests/artifacts/m1/live/{37-final-state.json,38-final-health.json,39-session-capabilities-excerpt.json,34-dispatch-success.png,36-auto-success.png}`。
- **live 重载方式（无需整机重启）**：`plugin_manager remove_bundle` + `install_bundle file:<repo>/packages/dsh-commander`，再 `set_plugin` 重载插件；Host 新代码即生效（用户不必退出 DSH）。
- **升级经验（重要，补充 §7.7）**：`dsh plugin add file:` / `install_bundle` 是**安装时快照**；`tsc` 以原子写替换文件会**断开 hardlink**，repo 与 live 副本不再同 inode，磁盘不会自动跟随。因此 **Host 变更（新增 lib 文件或 tsc 重写后）必须重装/重载安装副本**，单纯刷新页面或重启 Host 不够。校验：repo 与 profile 的 `find lib -name '*.js' | wc -l` 相等、`comm -23` 差集为空、关键新文件存在（`tools/dev/install-live-m0.sh` 预检已内置）。
- devops 最终复查：`node tools/dev/verify-live-m0.mjs --origin http://127.0.0.1:49921` → **exit 0（15 PASS + 1 SKIP 页面 token）**；证据 `docs/validation/m1-artifacts/live-acceptance/`。

## 8. 参考

- 隔离环境同流程已验证：`docs/validation/m0-build-spike.md`（`dsh plugin add file:` → bundles 自动追加 → dump-config 有 commander 行 → boot 0 失败条目 → health/state/页面/bundle 全 PASS）
- Client 产物契约：`tools/dev/verify-bundle.mjs`（头/尾/module init/external/apply/inject）
- 消息通道/H3a：client 不 import 任何 `@deepseek-ai/*` 运行时包；SSE 与 `/commander/message` 全走 Host。
