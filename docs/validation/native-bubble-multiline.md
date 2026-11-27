# 原生壳 · 气泡多行（v0.6）验证

> 日期：2026-11-27　范围：气泡窗 336×124、最多 5 行、顶/底锚定翻转、输入框优先、统一显隐
> 契约：`docs/architecture/native-shell-contract.md` v0.6　原型：`prototype/bubble-transitions/`

## 1. 需求与设计来源

用户在原型（`prototype/bubble-transitions/multiline.html`）上确认了效果，再落到生产：

1. 气泡从「单行 + 40 字符截断」改成「最多 5 行」，窗口 336×76 → 336×124；
2. 气泡顶边固定、只向下长；尾巴固定在球心高度，不随高度移动；
3. 输入框优先：输入框打开时气泡先退场，两者不叠加；输入框收起后气泡才回来；
4. 球贴屏幕下方时，气泡翻成底边锚定、向上长，不越出屏幕。

## 2. 改动

| 层 | 文件 | 内容 |
|---|---|---|
| Native | `packages/dsh-commander/native/tauri/src/main.rs` | `BUBBLE_HEIGHT 76 → 124`、`BUBBLE_BALL_INSET 6`；`position_bubble` 顶/底锚定翻转（`ball.y + 124 + 8 > 屏幕底` 翻转）；新增事件 `commander:bubble-anchor` |
| Client 数据 | `src/client/bubble.ts` | 行高 16.2、最多 5 行、pill 宽/高/行数/内容宽纯函数、动效决策（单行交叉 / 多行先出后进）、文案上限 40 → 120 字符 |
| Client 样式 | `src/client/window-styles.ts` | 窗口顶/底锚定、pill 尺寸由脚本设、`line-clamp: 5` + 行高 16.2、尾巴固定 16.5px（底锚 `bottom: 16.5px`）、输入条贴 8、离屏测量类；移除整块入场 `animation`（改 WAAPI 统一控制） |
| Client 组件 | `src/client/BubbleApp.tsx` | pill 常驻（去掉 `key={phase}`）、双层文本 + ghost 离场、按测量值缓动宽高、180ms 弹入 / 150ms 淡出（演完再 `set_bubble(false)`）、输入框优先交接 100ms、订阅 `commander:bubble-anchor`、jsdom 无 WAAPI 时降级到终态 |
| Client 桥接 | `src/client/shell-bridge.ts` | 新增 `onBubbleAnchor` |
| 测试 | `tests/client/{bubble,window-styles}.test.ts`、`tests/client/harness/bubble.mjs` | 宽度/行数/高度/动效决策用例；336×124、line-clamp、尾巴固定、锚定断言；harness 截断 120 |

## 3. 验证

| 项 | 结果 |
|---|---|
| `pnpm --filter dsh-commander typecheck` | PASS |
| `pnpm --filter dsh-commander test` | **492/492** |
| `pnpm --filter dsh-commander build`（host + client + window） | PASS |
| client harness `run-harness.mjs` | smoke **52/52**、interact **197/197**、bubble **6/6**，整体 PASS |
| `cargo check`（`native/tauri`） | PASS（仅既有 dead-code warning） |

## 4. 部署与真机待验

- Host 与 `lib/window.js` 都有改动 → **必须重装 + 重启 DSH**（安装是快照式的，只重启不生效）。
- desktop profile 由 Electron 独占管理，CLI `dsh plugin --profile desktop ...` 会报 `profile "desktop" is managed exclusively by the Electron application`；改用插件管理器（GUI，或 `plugin_manager` 的 `remove_bundle` → `install_bundle <本地目录>`）。本次即走 `remove_bundle dsh-commander` → `install_bundle /Users/lzx/Documents/GitHub/dsh-commander/packages/dsh-commander`，返回 `restart-required`。
- 原生壳二进制需要重新构建（`tools/dev/install-native-shell.sh`），窗口尺寸常量变了。
- 真机待验项（本次未在 live 上跑，验证脚本不写 `~/.dsh`）：
  1. 5 行文案时窗口 336×124、pill 最高 99，阴影不被裁；
  2. 球在屏幕上半区 → 向下长；拖到底部 → 翻成向上长（`commander:bubble-anchor` bottom）；
  3. 悬停 0.8s 唤起输入框：气泡先退 100ms，输入框再入；Esc/离开球收起后气泡回来；
  4. `prefers-reduced-motion` 下全部瞬时切换。

## 5. 回归修复（2026-11-27 11:4x，用户反馈「悬停浮球不再弹出输入框」）

- **原因**：`BubbleApp` 的渲染条件 `if (phase === 'hidden' && !shellVisible) return null` 把 `quickOpen` 一起挡掉了。空闲（`phase=hidden`）时悬停唤起输入框，Rust 已 `show()` 窗口，但页面返回 null → 窗口空着。
- **修复**：渲染条件放行 `quickOpen || shown === 'quick'`；从隐藏态直接唤起输入框时不播 100ms 交接、直接切到输入框（避免先闪一下气泡）。
- **回归测试**：新增 `tests/client/harness/quick.mjs`（假 Tauri + 空闲快照 + `commander:quick-input`）：空闲页初始为空、悬停后出现 `.dshcn-quick-bar`、输入框拿到焦点、气泡不在其下层、收起后回到空 —— 7/7。
- 复跑：全量单测 492/492；harness smoke 52/52、interact 197/197、bubble 6/6、quick 7/7。

## 6. 回归修复（2026-11-27 15:5x，用户反馈「输入框提交后卫星在转但没气泡，完成时才闪一下」）

- **现象**：悬停球 → 输入框 → 提交问题 → 球在 working（卫星转）但无气泡；本轮结束闪现一次「已完成」，下一轮推理开始时气泡才正常。
- **根因（时序）**：提交瞬间 `commanderBusy` 先变 true，client 调 `set_bubble(true)`，但 `quick_open` 仍为 true（输入框 100 ms 后才关）→ `set_bubble` 直接 return **且没有记住 `bubble_active`**；随后 `close_quick_input` 里 `bubble_active` 仍是 false，`show_bubble` 早退，窗口在关输入框时已被 hide。phase 不变就没人再 show，直到 success 才重新触发。
- **修复（`native/tauri/src/main.rs`）**：
  1. `set_bubble` 在 `quick_open` 且光标在球上时**记录 `bubble_active` 意图**（note `set_bubble:quick-defer`），等 quick 关闭后再显示；
  2. `close_quick_input` 改成「气泡仍激活就不 hide」，末尾交给 `show_bubble` 重新定位显示。
- **验证**：`cargo check` / `build:native` PASS；`bubble-state.json` 新增 `set_bubble:quick-defer` note 便于下次现场核对。

### 6.1 仍然复现 → 真正的根因在 client 的退场动画

- **现象**：修了壳侧时序后仍复现（提交后无气泡、完成时闪一下、下一轮恢复）。
- **根因**：`hideShell` / 输入框交接 / `closeQuick` 三处退场动画都用 `fill: 'forwards'` 从一个 100 ms+ 的透明度过渡开始，**却从不 `cancel()`**。动画结束后元素被持续压成 `opacity: 0`。输入框交接只切换根节点上的内容（class 变了、DOM 节点没换），所以那个 forwards 透明度一直生效：之后进入 working 播的入场动画作用在子元素（pill）上，根节点仍透明；直到 success 5 s 后 `phase=hidden` 卸载节点，下一轮重建才恢复正常 —— 正好对应“完成时闪一下、下一轮正常”。
- **修复**（`src/client/BubbleApp.tsx`）：新增 `playExit()`，演完立刻 `cancel()`；`hideShell` / 交接 / `closeQuick` 三处统一走它；`showShell` 额外清理根节点上残留的已结束动画（并对没有 `getAnimations` 的环境做了特性检测）。
- **回归**：`quick.mjs` 注入假 Web Animations，关闭输入框后断言根节点上没有未 cancel 的退场动画（8/8）；全量单测 492/492；harness smoke 52/52、interact 197/197、bubble 6/6、quick 8/8。

## 7. 完成态显示最后一轮回复（2026-11-27 16:3x）

- **需求**：完成后气泡显示 commander 最后一轮的回复内容，外框保留绿色打勾表示「这是回复，不是工作过程」。
- **实现**：`bubble.ts` 新增 `lastAssistantReply()`（从 `view.messages` 倒序取最后一条非空 assistant 文本）；`BubbleApp` 的 success 文案改为 `bubbleActivityText(lastAssistantReply(...))`，取不到回复时回退 `copy.success`；绿色打勾/绿框/呼吸不变，5s 后收起转未读的行为不变。
- **验证**：单测 493/493（新增 `lastAssistantReply` 用例）；harness bubble 6/6（turn end 断言文本为最后回复内容）；smoke 52/52、interact 197/197、quick 8/8。
- **部署**：纯 client 改动 → `build` 后重启 DSH 生效。

## 8. 气泡宽度测量（2026-11-27 16:4x）

- **现象**：「正在思考」四个字被压成两行、pill 极窄。
- **原因**：pill 宽度 = `bubblePillWidth(不换行文本宽, hasIcon)`，而离屏测量节点用的是 `position: fixed; left: -9999px`。WKWebView 对这个组合的 shrink-to-fit 给出的宽度过窄（Chrome/jsdom 里正常，所以 harness 测不出来），导致算出的 pill 放不下四个字，文本换行。
- **修复**：`.dshcn-bubble-measure` 改成 `position: absolute; left: 0; top: 0; width: max-content`，宽度不再受父容器/视口约束；换行模式仍由脚本 inline 设 `width`。
- **备注**：jsdom 全零布局测不到这个差异；真机验证方式为「空闲时悬停/等待 working，看『正在思考』是否一行」。若仍窄，下一步改用 `canvas.measureText` + 计算后的 font 兜底。

## 9. 已知边界

- 气泡窗口固定 124 高，1 行时下方留白（避免动态改窗口尺寸带来的 IPC 抖动）。
- 上下都放不下 124 高时取顶边锚定并 clamp 贴边，此时球心与尾巴会有偏移。
- 交接期间（100ms）窗口内没有可交互内容，输入框的键盘聚焦在交接完成后才生效。
