# 事故记录：live 安装副本陈旧（M1 新增文件缺失）→ 无球 / fiberPhase=null

- 记录人：devops（据 Lead 现场定位 + devops 只读核查）；时间：2026-11-17 22:2x–22:5x
- 结论：**非代码缺陷**，是安装副本快照语义导致 M1 新增 lib 文件缺失；已由 Lead 重装修复。

## 1. 现象

- 重启后 live 页面**无 Commander 悬浮球**。
- `plugin_manager list_plugins`：`include:commander` → `fiberPhase=null`（Host 行未激活）。
- 重新 enable 时错误原文（Lead 提供）：
  ```
  ERR_MODULE_NOT_FOUND .../profiles/desktop/node_modules/dsh-commander/lib/host/dispatch/capability.js
  ```

## 2. 根因

- `dsh plugin add file:` / `plugin_manager install_bundle` 对 `file:` 目录的安装是**安装时快照式的复制/hardlink**；
- hardlink 只对**安装当时已存在**的文件成立（同 inode）；**安装之后新增的 lib 模块不会自动出现在 profile 副本中**；
- live 包是 M0 时期安装的；M1 新增 `lib/host/dispatch/*.js`、`lib/host/jev/*.js` 等文件 → Host fiber 加载 `dispatch/capability.js` 失败。
- 之前“hardlink 已最新，只需重启”的判断只对**同名旧文件**成立，对**新增文件不成立**，已在本证据中更正。

## 3. 修复（Lead 执行）

1. `plugin_manager remove_bundle`（移除旧安装副本）
2. `plugin_manager install_bundle file:/Users/lzx/Documents/GitHub/dsh-commander/packages/dsh-commander`
3. 重启 DSH

## 4. 修复后验证（devops 只读）

```bash
# lib 文件集一致性：repo 39 = live 39；关键新文件均在
find /Users/lzx/Documents/GitHub/dsh-commander/packages/dsh-commander/lib -name '*.js' | wc -l   # 39
find /Users/lzx/.dsh/profiles/desktop/node_modules/dsh-commander/lib -name '*.js' | wc -l          # 39
for f in dispatch/capability.js dispatch/service.js dispatch/candidates.js dispatch/gate.js dispatch/spawn.js jev/client.js tools/index.js; do
  test -f "/Users/lzx/.dsh/profiles/desktop/node_modules/dsh-commander/lib/host/$f" && echo "ok $f" || echo "MISSING $f"
done
```

实测结果（证据 `docs/validation/m1-live-artifacts/`）：

| 检查 | 结果 |
|---|---|
| repo vs live lib JS 文件数 | **39 / 39**（一致）；上述 7 个关键新文件均存在 |
| `GET /commander/health` | 200 `{"ok":true,"version":"0.1.0","panel":"present","binding":"bound"}`（`live-health.json`） |
| `GET /commander/state` | 200（`commanderStatus:"bound"`、`pendingDispatch:null`、workspaces=28、tasks=0、messages=0）（`live-state.json`） |
| `GET /commander/config` | 200（`live-config.json`） |
| `node tools/dev/verify-live-m0.mjs --origin http://127.0.0.1:59123` | **exit 0（15 PASS + 1 SKIP：页面 token）**（`verify-live-m1-stdout.txt`） |
| `POST /commander/jev/test` | 200，`hasApiKey:true`，本次 `code:"timeout", latencyMs:1502`（live `timeoutMs=1500`；网络/端点问题待观察，非崩溃）（`live-jev-test.json`） |

## 5. 预防措施（已落地）

1. `tools/dev/install-live-m0.sh` 预检新增 **repo vs live lib 文件集一致性检查**：文件数不等或 `comm -23` 差集非空 → FAIL 并提示“必须 remove+add 重装再重启”。
2. 文档固化升级规则：**任何新增源文件/lib 模块后，必须重装 + 重启**；单纯重启/刷新不同步新文件。
   - `docs/validation/m0-live-install.md` §7.5/§7.6/§7.7
   - `docs/validation/m1-boot.md` §6/§7.9
