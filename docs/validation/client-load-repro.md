# 无球问题：隔离 web + 无头 Chrome 复现与修复验证（client 半加载）

- **结论：修复后 PASS（隔离无头 + live 双验证）**。① 隔离 web Host（最新构建，client bundle sha256 `e82b4d16…`，131,141B）+ 无头 Chrome CDP：console 出现 `[dsh-commander] client apply begin / slots registered / client apply ok`，**0 exception / 0 console error**，DOM 有 ball 节点（`dshcNodes=2`、`ballNodes=4`），截图可见右下角悬浮球；② **live 验证 PASS**：Lead 替用户硬刷新后，页面出现**悬浮球与指挥官面板**（截图 `docs/validation/m1-artifacts/client-repro/live-hardrefresh.png`，1920×1080；面板标题“指挥官 已绑定”）。
- 修复前根因（architect 静态 + frontend 修复，devops 记录）：client 模块 `inject` 缺 `'locale'`，`apply` 里读 `ctx.locale` → Cordis 严格代理抛 `cannot get property "locale" without inject`（`cordis/src/reflect.ts:152`）→ apply 中断、槽位未注册、页面无球；jsdom/fake-loader 不复现（假 ctx 不抛）。
- 执行人 / 时间：devops / 2026-11-17 23:1x–23:3x
- 环境：`PROBE_ROOT=/tmp/client-repro`（一次性 `DSH_HOME`，web 模板 + 本地包安装，**未碰 live**）；无头 Chrome `Chrome/157.0.8103.79`（`--headless=new`，独立 `--user-data-dir=/tmp/client-repro/chrome`）。
- 证据：`docs/validation/m1-artifacts/client-repro/`（`screenshot.png`、`evaluate.json`、`cdp-events.json`、`network.json`、`summary.txt`、`commands.log`、`boot.err`）；复跑脚本 `tools/dev/client-repro.sh` + `tools/dev/cdp-probe.mjs`。

## 1. 复现命令与退出码

```bash
cd /Users/lzx/Documents/GitHub/dsh-commander
pnpm --filter dsh-commander build                      # exit 0；lib/client.js=131,141B sha e82b4d16…
node tools/dev/verify-bundle.mjs packages/dsh-commander/lib/client.js dsh-commander   # exit 0
PROBE_ROOT=/tmp/client-repro bash tools/dev/client-repro.sh                            # exit 0（CDP_EXIT=0）
```

`client-repro.sh` 做：隔离 profile（web 模板）→ `dsh plugin add file:<repo>/packages/dsh-commander` → boot web Host → curl 页面/`/commander/health`/client bundle → `cdp-probe.mjs` 启动无头 Chrome（`--remote-debugging-port=9333`）→ `/json/new` 建页 → 页面 WS 连 CDP → `Page/Runtime/Log/Network.enable` → 打开带 token 页面 → 等 12s → `Runtime.evaluate` + `Page.captureScreenshot` → 关闭 Chrome。

| 步骤 | 结果 |
|---|---|
| build / verify-bundle | exit 0；`lib/client.js` 131,141B、sha `e82b4d16d9ff3856123f8625f278b39068957bc0c03f45b08d753b9e57180bf4` |
| 隔离 Host boot | `04-boot.err` 仅 `[commander] host ready (version=0.1.0, domainVia=defineDomain, configInitialized=true, panel=absent)` |
| `/commander/health` | 200 `{"ok":true,"version":"0.1.0","panel":"absent","binding":"bound"}` |
| 页面（带 token） | 200（41KB HTML）；`__DSH_BOOT__` 含 commander entry |
| commander client bundle | 200，129,770B（组合 URL `/plugins/??…,dsh-commander/client.js,…&rev=…`） |
| CDP 探针 | exit 0；Chrome/157.0.8103.79 |

> 注：首次跑 CDP 时遇到 `Inspector.targetCrashed`（CDP 无响应）——原因是 macOS + 受限父进程下 Chrome 需要 `--no-sandbox --disable-dev-shm-usage --disable-breakpad --disable-crash-reporter`；加上后正常（与页面代码无关）。早前 live 无球**不是**该崩溃导致；live Host 侧现象由 root cause 解释。

## 2. 无头 Chrome 抓到的 console（修复后）

`cdp-events.json` 的 `consoleAll`（摘要 `summary.txt`）：

```
[console:info] [dsh-commander] client apply begin
[console:info] [dsh-commander] slots registered | Object
[console:info] [dsh-commander] client apply ok | Object
```

- `exceptions=0`、`consoleErrors=0`、`logEntries=0`（无 `slot entry crashed`）；
- 网络：commander 组合 bundle 200、`/commander/state` 200、`/plugins/events` 与 `/commander/state` 的 SSE 200；
- 页面内 evaluate（`evaluate.json`）：
  - `moduleLoaderPresent="object"`、`bootExists="object"`
  - `commanderEntries=[{id:"dsh-commander", inject:["@deepseek-ai/dsh-client-ui-layout","@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-locale"], immediately:true, rev:"3e0cdda78b09"}]`
  - `dshcNodes=2`、`ballNodes=4`（`[class*="ball"/"fab"/"launcher"/"overlay"]`）
  - `bodyHasCommanderText=false`（球是图标按钮，不含“指挥官”文本，属预期）
- 截图：`client-repro/screenshot.png`（1440×813；右下角可见 Commander 悬浮球）。

## 2.1 live 验证 PASS（硬刷新后，Lead 代用户执行 2026-11-17 23:30）

- 截图：`docs/validation/m1-artifacts/client-repro/live-hardrefresh.png`（1920×1080；右下角可见蓝色 Commander 悬浮球，右侧面板“指挥官 / 已绑定”已打开）。
- live 复查（只读，origin `http://127.0.0.1:49921`）：
  - `GET /commander/health` → **200** `{"ok":true,"version":"0.1.0","panel":"present","binding":"bound"}`（`live-health-after-hardrefresh.json`）
  - `GET /commander/state` → **200**（`rev:0`、`commanderStatus:"bound"`、`pendingDispatch:null`、workspaces=28、tasks=0、messages=0）（`live-state-after-hardrefresh.json`）
  - `GET /commander/config` → **200**（`live-config-after-hardrefresh.json`）
  - `POST /commander/jev/test` → **200 `ok:true`**，`latencyMs:1351`、`model:"jev-1.14.0"`、`hasApiKey:true`（早前一次 `timeout/1502ms` 为瞬态网络，已恢复；`live-jev-test-after-hardrefresh.json`）
- **不归因说明**：浏览器 console 里大量 `WebSocket connection to 'ws://127.0.0.1:9230/ingest' failed`（以及 `dsh-notify-me` 404、xlate 405）来自**其它插件/工具的 inspector 通道**，与 dsh-commander 无关；commander 自身 console 仅 `[dsh-commander] client apply begin/slots registered/client apply ok`，无异常。


## 2.2 后续：M1 live 全链路验收 PASS（引用 Lead/用户证据）

硬刷新修复后，M1 真实模型全链路已在 live 跑通：`board_query → task_create → dispatch_task → needs_confirmation（确认卡）→ 采纳建议 → dispatched → task running（primarySessionId 已建）`；auto 策略 capability applied（enabled 5 / durationMs 982，session-capabilities.json 写入新会话 cwd=Htdot-OrderCenter）；final `pendingDispatch:null`、health 200。
证据：`tests/artifacts/m1/live/{33-confirm-card.png,34-dispatch-success.png,35-auto-confirm-card.png,36-auto-success.png,37-final-state.json,38-final-health.json,39-session-capabilities-excerpt.json}`；汇总见 `docs/validation/m1-boot.md` §6「M1 live 全链路验收 PASS」。
**live 重载经验（本轮实测）**：Host 变更用 `plugin_manager remove_bundle` + `install_bundle file:<repo>/packages/dsh-commander` + `set_plugin` 重载即可，**无需整机重启**；但新增 lib 文件或 `tsc` 重写会断开 hardlink，必须重装/重载（单纯刷新/重启不够）。
devops 最终 `verify-live-m0.mjs --origin http://127.0.0.1:49921` → exit 0（15 PASS + 1 SKIP 页面 token）；证据 `docs/validation/m1-artifacts/live-acceptance/`。

## 3. 与 live 的差异 / 后续动作

- live 侧 `lib/client.js` 与 repo **同一 inode/sha**（ino `193756017`、sha `e82b4d16…`，131,141B）→ 磁盘已是修复后的 bundle；`package.json` 亦为 hardlink（ino `193741062`），其 `dsh.client.inject` 已含 `@deepseek-ai/dsh-client-locale`（本次由 devops 修改配置 + rebuild）。
- **用户操作建议**：**硬刷新页面（⌘⇧R）已完成 → live PASS（球+面板出现，见 §2.1）**；无需重启 Host、无需 remove/add。
  - **无需 remove/add / 重装**：client.js 与 package.json 均通过 hardlink 已更新；不涉及新增 lib 文件（M1 那次是新增文件才必须重装，见 `docs/validation/m1-live-install.md` §7.7）。
  - 若后续再遇到“强刷仍无球”，才检查页面 `__DSH_BOOT__` commander entry 的 `inject` 是否缓存旧清单 → 必要时重启 DSH Host。
- 结论：无球是 client apply 的 `ctx.locale` 未 inject 抛错；修复（`inject` 加 `locale`、槽位前移、try/catch + 诊断日志 + `dsh.client.inject` 顺序声明加 locale）已在隔离无头环境验证通过；live 侧预期硬刷即可。

## 4. 复跑/回归

```bash
# 全链路（隔离，不碰 live）：
PROBE_ROOT=/tmp/client-repro bash tools/dev/client-repro.sh
# 只跑 CDP 探针（已有隔离 Host 在跑时）：
node tools/dev/cdp-probe.mjs --url 'http://127.0.0.1:<PORT>/?token=<TOKEN>' --out /tmp/repro-report
```

关键产物：`client-repro/{evaluate.json, cdp-events.json, network.json, summary.txt, screenshot.png, commands.log}`。
