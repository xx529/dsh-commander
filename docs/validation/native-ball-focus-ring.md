# 原生壳：球窗焦点环（启动时浮球一圈蓝边）修复（2026-11-27）

> 契约：`docs/architecture/native-shell-contract.md` v0.7「键盘焦点」
> 触发：用户反馈「启动时候浮球会有一圈蓝色边框，鼠标移动过去后就不会再出现」

## 结论

- 那圈蓝边是浮球按钮的**键盘焦点环**（`:focus-visible` 的 2px `#4f8bff` 描边），不是状态/忙碌动画。
- 根因：球窗在 `show()` 时被 AppKit 设为 key，WKWebView 的初始焦点落到球按钮上；此时页面还没收到过指针输入，浏览器按「键盘焦点」处理 → 画出焦点环。焦点一被别处拿走，环就消失且不会自动回来。
- 修复（方案 B，原生层）：球窗 `.focusable(false)` —— tao 的 `canBecomeKeyWindow` 直接读这个标志，球窗**永不成为 key**，拿不到键盘焦点，也就不会画环。球是纯指针控件，键盘交互全部走面板窗与气泡窗。
- 回归护栏：新增 `tools/dev/native-focus-probe.mjs`（脚本化断言，旧产物必失败）。

## 证据

### 1. 环本身就是 `:focus-visible`（截图像素 + CSS 源码）

用户截图（147×143 裁切）逐像素量测：圆环宽 **2px**、颜色 **rgb(79,139,255)**、与球体之间 **1px** 间隙；与 `packages/dsh-commander/src/client/window-styles.ts` 中的

```css
.dshcn-ball:focus-visible { outline: 2px solid var(--dsw-alias-border-selected); outline-offset: 1px; }
```

三项（宽度 / 颜色 / offset）逐项吻合；`--dsw-alias-border-selected` 在该主题下就是 `#4f8bff`。同页其它候选环均排除：`dshcn-sonar` 是 1px `rgba(111,227,255,0.42)`，`dshcn-orbit::before` 是 1px `rgba(190,225,255,0.16)`。

### 2. 旧产物实测：球窗真的拿了键盘焦点

用真实壳二进制 + loopback 探针页（同 `native-shell-smoke.mjs` 的握手参数、独立 state 目录）在球窗里采样，**修复前**：

| 时刻 | activeElement | `:focus` | `:focus-visible` | 计算 outline |
|---|---|---|---|---|
| t≈19ms | `b`（球按钮） | false | false | none（窗还未成为 key） |
| t≈89ms | `b` | true | **true** | **solid 2px rgb(79,139,255) 1px** |
| t≈1184ms | `b` | false | false | 窗失焦（`ball-blur` / `win-blur`）→ 环消失 |

即：环与 `:focus-visible` 状态严格同步，颜色/宽度/offset 与截图一致。

### 3. 修复后实测（新产物 `native-focus-probe.mjs`）

```
[focus] ball samples: win-focus(doc=false,fv=false) t200(doc=false,fv=false) mode-panel-ok(doc=false,fv=false)
        t700(doc=false,fv=false) t1200(doc=false,fv=false) t2000(doc=false,fv=false) t2600(doc=false,fv=false)
        t3200(doc=false,fv=false) ball-click(doc=false,fv=false)
[focus] panel samples: t200(doc=false) win-focus(doc=true) t700(doc=true) t1200(doc=true) t2000(doc=true)
        win-blur(doc=false) t2600(doc=false) t3200(doc=false)
[focus] PASS: ball never focused; panel focus OK; click=click-ok
```

- 球窗任何采样 `document.hasFocus() === false`、球按钮 `:focus`/`:focus-visible` 恒 false、outline 不再是 `solid`（旧产物在第一条断言就失败）；
- 面板经 `invoke('set_mode', {mode:'panel'})` 打开后能拿到键盘焦点（`doc=true`），收起后释放 —— 键盘输入没被这次改动影响；
- `cliclick` 真实点击球心，球页收到 `ball-click` —— `focusable(false)` 没破坏指针交互。

## 改动

| 层 | 文件 | 内容 |
|---|---|---|
| Native | `packages/dsh-commander/native/tauri/src/main.rs` | 球窗 builder 加 `.focusable(false)`（附根因注释） |
| 工具 | `tools/dev/native-focus-probe.mjs`（新增） | 焦点回归探针：球窗不得有 document 焦点/焦点环；面板仍可聚焦；可选真实点击验证指针交互 |
| 契约 | `docs/architecture/native-shell-contract.md` | 升 v0.7：§4 窗口表加 `focusable: false`、新增「键盘焦点」行；§5.2 接管条件的 `focused` 语义说明 |

Client 侧未改：`window-styles.ts` 的 `:focus-visible` 规则保留（键盘导航仍需要它；球窗拿不到键盘焦点后它自然不再触发）。

## 副作用与取舍

- `window/visibility` 的 `focused` 字段（壳上报）此前 = 球窗或面板窗聚焦；球窗不再参与键盘焦点后，**等价于「面板窗已打开且聚焦」**。审批/问答桥的接管条件（`running + visible + focused`）因此变成「面板打开且聚焦才接管」，面板没打开时回落 DSH 页内 —— 比之前更安全（此前球窗一旦被 key，接管后审批卡在没打开的面板里，用户看不见）。
- 球窗不再抢键盘焦点，也顺带消除了「壳启动时把键盘焦点从用户正在输入的地方抢走」。
- 已知边界：`focusable(false)` 是 macOS/tao 的窗口属性；Windows 实现（WebView2）未验证。

## 验证

| 项 | 结果 |
|---|---|
| `pnpm --filter dsh-commander typecheck` | PASS |
| `pnpm --filter dsh-commander test` | PASS，**516/516** |
| `pnpm --filter dsh-commander build:native` | PASS（release，darwin-arm64，3m32s） |
| `node tools/dev/native-focus-probe.mjs` | **PASS**（球窗无焦点/无环；面板可聚焦；真实点击命中） |
| `node tools/dev/native-shell-smoke.mjs` | PASS（hello → ready/ping → 窗口页 → pong → shutdown） |
| `node tools/dev/native-ipc-probe.mjs` | PASS（球窗 76×76 恒定、`set_mode` panel/board/ball 全部 ok） |
| `node tools/dev/native-window-probe.mjs` | PASS（真实窗口 bundle 执行并打到数据面） |
| `node packages/dsh-commander/tests/e2e/m4-e2e.mjs` | **10/10 PASS** |
| 真机拖动（`focusable(false)` 下） | PASS：`cliclick` 在球心按下 → 页面 `pointerdown` 触发、`startDragging()` 返回 ok，`window.json` 从 `1820,932` 变为 `1730,842` |

## 部署

改的是**原生壳二进制**（`native/dist/darwin-arm64/dsh-commander-shell`），live 安装是**快照式拷贝**（`~/.dsh/profiles/desktop/node_modules/dsh-commander` 是真实目录，不是软链），所以：

1. `pnpm --filter dsh-commander build`（host/client/window 未改，保险跑一次）
2. `pnpm --filter dsh-commander build:native`（**已在本机跑完**）
3. 重装插件 + 重启 DSH —— 只重启不重装拿到的还是旧壳。

## 未验证

- live 重启后「启动无蓝环」的**视觉**确认（需用户重装 + 重启后看一眼）。
- 悬停快捷输入、未读脉冲等既有交互在 `focusable(false)` 下的真机手感 —— 已覆盖「真实点击命中」「面板聚焦」「真实拖动（window.json 变化）」；悬停气泡/快捷输入仍需真机走查。
- Windows / WebView2。
