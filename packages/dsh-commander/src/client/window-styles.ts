// 原生壳窗口页样式（与 DSH 页内浮窗视觉同口径，但不依赖宿主 CSS 变量）。
export const WINDOW_STYLES = `
:root {
  --dsw-alias-bg-base: #ffffff;
  --dsw-alias-bg-layer-1: #ffffff;
  --dsw-alias-bg-layer-2: #f2f4f7;
  --dsw-alias-bg-layer-3: #f2f4f7;
  --dsw-alias-bg-mask-1: rgba(0, 0, 0, 0.2);
  --dsw-alias-bg-mask-2: rgba(0, 0, 0, 0.28);
  --dsw-alias-bg-module-platform: #f2f4f7;
  --dsw-alias-border-l1: #e5e7eb;
  --dsw-alias-border-l2: #e5e7eb;
  --dsw-alias-border-l3: #9aa1ab;
  --dsw-alias-border-selected: #1f63eb;
  --dsw-alias-brand-primary: #1f63eb;
  --dsw-alias-label-primary: #171a1f;
  --dsw-alias-label-secondary: #6b7280;
  --dsw-alias-label-tertiary: #6b7280;
  --dsw-alias-label-quaternary: #6b7280;
  --dsw-alias-label-on-color: #ffffff;
  --dsw-alias-card-fill: #ffffff;
  --dsw-alias-card-fill-hover: #f2f4f7;
  --dsw-alias-interactive-bg-hover: #f2f4f7;
  --dsw-alias-button-primary-fill: #1f63eb;
  --dsw-alias-button-primary-hover: #1f63eb;
  --dsw-alias-state-success-primary: #22c55e;
  --dsw-alias-state-success-secondary: #22c55e;
  --dsw-alias-state-warn-primary: #d97706;
  --dsw-alias-state-warn-secondary: #d97706;
  --dsw-alias-state-error-primary: #dc2626;
  --dsw-alias-state-error-secondary: #dc2626;
  --dsw-alias-scrollbar-bg-l: transparent;
  --dsw-alias-scrollbar-hover-l: #e5e7eb;
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #171a1f;
  --muted: #6b7280;
  --line: #e5e7eb;
  --brand: #1f63eb;
  --assist: #f2f4f7;
  --danger: #dc2626;
  --warn: #d97706;
}
/* 快捷输入：复用气泡窗，悬停 0.8s 唤起；这一层需要接收鼠标和键盘。 */
.dshcn-quick {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  padding: 12px;
  box-sizing: border-box;
  pointer-events: auto;
}
.dshcn-quick[data-side="left"] { justify-content: flex-end; }
.dshcn-quick[data-side="right"] { justify-content: flex-start; }
.dshcn-quick-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 312px;
  max-width: 100%;
  height: 52px;
  padding: 0 8px 0 10px;
  box-sizing: border-box;
  border: 1px solid var(--dshcn-bubble-line);
  border-radius: 15px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0) 46%),
    var(--dshcn-bubble-bg);
  box-shadow: var(--dshcn-bubble-shadow);
  color: var(--dshcn-bubble-ink);
  animation: dshcn-bubble-in 180ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
.dshcn-quick[data-side="right"] .dshcn-quick-bar { animation-name: dshcn-bubble-in-right; }
.dshcn-quick-bar:focus-within { border-color: rgba(190, 225, 255, 0.55); }
.dshcn-quick[data-error="true"] .dshcn-quick-bar { border-color: rgba(255, 93, 93, 0.5); }
.dshcn-quick-mark {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.28), rgba(120, 160, 200, 0.15));
  color: var(--dshcn-bubble-accent);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
  font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.dshcn-quick-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
}
.dshcn-quick-input {
  width: 100%;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--dshcn-bubble-ink);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.3;
}
.dshcn-quick-input:disabled { opacity: 0.7; }
.dshcn-quick-hint {
  min-height: 11px;
  font-size: 9px;
  line-height: 1.2;
  color: var(--dshcn-bubble-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dshcn-quick-hint[data-error="true"] { color: var(--dshcn-quick-error); }
.dshcn-quick-send {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  cursor: pointer;
}
.dshcn-quick-send {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: linear-gradient(145deg, #e6f1ff 0%, #a8c4e0 48%, #5d7894 100%);
  color: #0c1824;
  box-shadow:
    0 2px 6px rgba(0, 0, 0, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.6);
}
.dshcn-quick-send:disabled { opacity: 0.35; cursor: default; }
.dshcn-quick-send svg { display: block; width: 14px; height: 14px; }

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1b1e23;
    --fg: #e6e8eb;
    --muted: #9aa1ab;
    --line: #2c3138;
    --assist: #24282e;
    --dsw-alias-bg-base: #1b1e23;
    --dsw-alias-bg-layer-1: #1b1e23;
    --dsw-alias-bg-layer-2: #24282e;
    --dsw-alias-bg-layer-3: #24282e;
    --dsw-alias-bg-module-platform: #24282e;
    --dsw-alias-bg-mask-2: rgba(0, 0, 0, 0.5);
    --dsw-alias-border-l1: #2c3138;
    --dsw-alias-border-l2: #2c3138;
    --dsw-alias-border-l3: #9aa1ab;
    --dsw-alias-border-selected: #4f8bff;
    --dsw-alias-brand-primary: #4f8bff;
    --dsw-alias-label-primary: #e6e8eb;
    --dsw-alias-label-secondary: #9aa1ab;
    --dsw-alias-label-tertiary: #9aa1ab;
    --dsw-alias-label-quaternary: #9aa1ab;
    --dsw-alias-label-on-color: #ffffff;
    --dsw-alias-card-fill: #1b1e23;
    --dsw-alias-card-fill-hover: #24282e;
    --dsw-alias-interactive-bg-hover: #24282e;
    --dsw-alias-button-primary-fill: #1f63eb;
    --dsw-alias-button-primary-hover: #1f63eb;
    --dsw-alias-state-success-primary: #22c55e;
    --dsw-alias-state-success-secondary: #22c55e;
    --dsw-alias-state-warn-primary: #f59e0b;
    --dsw-alias-state-warn-secondary: #f59e0b;
    --dsw-alias-state-error-primary: #ef4444;
    --dsw-alias-state-error-secondary: #ef4444;
    --dsw-alias-scrollbar-bg-l: transparent;
    --dsw-alias-scrollbar-hover-l: #2c3138;
  }
}
* { box-sizing: border-box; }
html, body, #root { width: 100%; height: 100%; margin: 0; padding: 0; background: transparent; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif;
  color: var(--fg);
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
  user-select: none;
}

.dshcn-ball {
  position: absolute;
  inset: 8px;
  width: calc(100% - 16px);
  height: calc(100% - 16px);
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  padding: 0;
  touch-action: none;
  transition: transform 140ms ease;
}
.dshcn-ball:hover,
.dshcn-ball.is-hover { transform: translateY(-1px) scale(1.055); }
.dshcn-ball:active { transform: scale(0.97); }
.dshcn-ball.is-dragging { cursor: grabbing; transform: scale(0.97); }
.dshcn-ball:focus-visible { outline: 2px solid var(--dsw-alias-border-selected); outline-offset: 1px; }

/*
 * B 方案「虹彩玻璃」：蓝绿/紫/粉的低饱和折射 + 左上白色高光 + 右下定向 rim，
 * 60px 球，窗外留 8px 透明边，hover 放大到 63px 也不会裁到高光/边缘。
 */
.dshcn-orb-surface {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: block;
  border-radius: 50%;
  overflow: hidden;
  background:
    radial-gradient(40% 36% at 30% 24%, rgba(255, 255, 255, 0.55), transparent 55%),
    radial-gradient(70% 70% at 70% 82%, rgba(0, 0, 0, 0.7), transparent 70%),
    conic-gradient(from 220deg at 50% 50%, #0e1622, #4d6a8e, #b9d2e8, #2a3c54, #070b12, #0e1622),
    radial-gradient(80% 80% at 50% 45%, #506a8a, #101a28 70%, #05080d);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow:
    inset 0 2px 6px rgba(255, 255, 255, 0.18),
    inset 0 -12px 22px rgba(0, 0, 0, 0.6);
  -webkit-mask: radial-gradient(circle at 50% 48%, #000 0 86%, rgba(0, 0, 0, 0.9) 94%, transparent 100%);
  mask: radial-gradient(circle at 50% 48%, #000 0 86%, rgba(0, 0, 0, 0.9) 94%, transparent 100%);
}
.dshcn-orb-surface::before {
  content: "";
  position: absolute;
  left: 13%;
  top: 10%;
  z-index: 2;
  width: 49%;
  height: 37%;
  background:
    radial-gradient(closest-side at 34% 38%, rgba(255, 255, 255, 0.96), rgba(215, 245, 255, 0.55) 34%, transparent 70%),
    radial-gradient(closest-side at 72% 72%, rgba(125, 205, 255, 0.3), transparent 72%);
  filter: blur(0.7px);
  transform: rotate(-18deg);
  pointer-events: none;
}
.dshcn-orb-surface::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 2;
  border-radius: 50%;
  background: conic-gradient(
    from 300deg,
    transparent 0 15%,
    rgba(200, 230, 255, 0) 25%,
    rgba(200, 230, 255, 0.25) 40%,
    rgba(255, 255, 255, 0.45) 50%,
    rgba(120, 170, 220, 0.15) 60%,
    transparent 72%
  );
  -webkit-mask: radial-gradient(circle, transparent 0 78%, #000 86% 100%);
  mask: radial-gradient(circle, transparent 0 78%, #000 86% 100%);
  filter: blur(2px);
  opacity: 0.65;
  pointer-events: none;
}
.dshcn-core {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 0;
  width: 42px;
  height: 42px;
  margin: -21px 0 0 -21px;
  border-radius: 50%;
  background: radial-gradient(
    closest-side,
    rgba(245, 255, 255, 0.96),
    rgba(110, 230, 255, 0.65) 42%,
    rgba(40, 120, 255, 0) 74%
  );
  filter: blur(3px);
  animation: dshcn-core-breathe 4s ease-in-out infinite;
  pointer-events: none;
}
.dshcn-rim {
  position: absolute;
  inset: 0;
  z-index: 1;
  border-radius: 50%;
  box-shadow:
    inset 0 2px 6px rgba(255, 255, 255, 0.18),
    inset -4px -6px 12px rgba(120, 180, 230, 0.22),
    inset 3px 4px 12px rgba(0, 0, 0, 0.3);
  pointer-events: none;
}
.dshcn-sonar {
  position: absolute;
  inset: 4px;
  z-index: 1;
  border-radius: 50%;
  border: 1px solid rgba(111, 227, 255, 0.42);
  opacity: 0;
  pointer-events: none;
}
.dshcn-ball:hover .dshcn-core,
.dshcn-ball.is-hover .dshcn-core {
  animation-duration: 2.6s;
  filter: blur(1.5px) brightness(1.18);
}
.dshcn-ball:hover .dshcn-rim,
.dshcn-ball.is-hover .dshcn-rim {
  box-shadow:
    inset 0 1px 1px rgba(190, 220, 255, 0.18),
    inset 0 0 12px rgba(111, 227, 255, 0.3);
}
/* working：青色卫星沿球缘环行 + 淡轨道。卫星半径压在球缘内（68 窗内），
 * hover 1.055 也不会被窗口裁掉；气泡只保留「正在思考」文字，不再放 loading。 */
.dshcn-ball[data-busy="true"] .dshcn-rim {
  box-shadow:
    inset 0 2px 6px rgba(255, 255, 255, 0.16),
    inset 0 0 14px rgba(170, 215, 250, 0.3);
}
.dshcn-orbit {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: block;
  border-radius: 50%;
  opacity: 0;
  pointer-events: none;
  transition: opacity 180ms ease;
  animation: dshcn-orbit-spin 4.6s linear infinite;
  animation-play-state: paused;
}
.dshcn-ball[data-busy="true"] .dshcn-orbit { opacity: 1; animation-play-state: running; }
.dshcn-ball.is-unread .dshcn-orbit { opacity: 0; animation-play-state: paused; }
.dshcn-orbit::before {
  content: "";
  position: absolute;
  inset: 4px;
  border-radius: 50%;
  border: 1px solid rgba(190, 225, 255, 0.16);
}
.dshcn-satellite {
  position: absolute;
  left: 50%;
  top: 3px;
  width: 8px;
  height: 8px;
  margin-left: -4px;
  border-radius: 50%;
  background: #d6ecff;
  box-shadow:
    0 0 0 2px rgba(190, 225, 255, 0.14),
    0 0 13px rgba(170, 215, 255, 0.8);
}
.dshcn-satellite::before {
  content: "";
  position: absolute;
  right: 6px;
  top: 2px;
  width: 13px;
  height: 4px;
  border-radius: 999px;
  background: linear-gradient(90deg, transparent, rgba(180, 220, 255, 0.32));
  filter: blur(1px);
}

/* unread：完成提示收起后，绿色脉冲核心 + 双层声呐，直到点击浮球查看。 */
.dshcn-ball.is-unread .dshcn-rim {
  box-shadow:
    inset 0 1px 1px rgba(190, 255, 225, 0.22),
    inset 0 0 14px rgba(52, 211, 153, 0.28);
}
.dshcn-ball.is-unread .dshcn-core {
  background: radial-gradient(
    closest-side,
    rgba(210, 255, 235, 0.9),
    rgba(52, 211, 153, 0.55) 45%,
    rgba(16, 185, 129, 0) 74%
  );
  animation: dshcn-core-pulse 1.4s ease-in-out infinite;
}
.dshcn-ball.is-unread .dshcn-sonar {
  border-color: rgba(82, 224, 168, 0.5);
  animation: dshcn-sonar-out 1.8s cubic-bezier(0.2, 0.7, 0.3, 1) infinite;
}
.dshcn-ball.is-unread .dshcn-sonar-2 { animation-delay: 0.6s; }
@keyframes dshcn-orbit-spin {
  to { transform: rotate(360deg); }
}

.dshcn-ball[data-bound="false"] .dshcn-orb-surface {
  background: radial-gradient(80% 80% at 50% 42%, #2a303a 0%, #161a21 68%, #0d1015 100%);
}
.dshcn-ball[data-bound="false"] .dshcn-core {
  background: radial-gradient(
    closest-side,
    rgba(210, 218, 228, 0.55),
    rgba(120, 130, 145, 0.35) 44%,
    rgba(90, 100, 115, 0) 72%
  );
}
.dshcn-ball[data-bound="false"] .dshcn-sonar { border-color: rgba(190, 200, 215, 0.35); }
.dshcn-ball[data-conn="offline"] .dshcn-orb-surface,
.dshcn-ball[data-conn="reconnecting"] .dshcn-orb-surface { filter: saturate(0.12) brightness(0.72); }
.dshcn-ball[data-conn="offline"] .dshcn-orb-surface *,
.dshcn-ball[data-conn="reconnecting"] .dshcn-orb-surface * { animation-play-state: paused; }
.dshcn-ball[data-conn="offline"] .dshcn-orbit,
.dshcn-ball[data-conn="reconnecting"] .dshcn-orbit { animation-play-state: paused; }

@keyframes dshcn-core-breathe {
  0%, 100% { opacity: 0.68; transform: scale(0.92); }
  50% { opacity: 1; transform: scale(1.06); }
}
@keyframes dshcn-core-pulse {
  0%, 100% { opacity: 0.6; transform: scale(0.8); }
  45% { opacity: 1; transform: scale(1.12); }
}
@keyframes dshcn-sonar-out {
  0% { transform: scale(0.55); opacity: 0.7; }
  72% { opacity: 0.12; }
  100% { transform: scale(1.02); opacity: 0; }
}

.dshcn-badge {
  position: absolute; top: -1px; right: -1px;
  min-width: 24px; height: 24px; padding: 0 5px;
  border-radius: 12px;
  background: #f59e0b; color: #1b1e23;
  font-size: 12px; font-weight: 700; line-height: 24px;
  /* 角标贴着球右上，只有 3px 到窗口边：阴影必须收在 3px 内。 */
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
  z-index: 2;
}
/* 面板头部的连接点；球上不再有这个点（2026-11-26 决定）。 */
.dshcn-dot {
  position: absolute; right: 2px; bottom: 2px;
  width: 9px; height: 9px; border-radius: 50%;
  background: #9aa1ab;
  border: 1.5px solid var(--bg);
  z-index: 1;
}
.dshcn-dot[data-phase="live"] { background: #22c55e; }
.dshcn-dot[data-phase="polling"] { background: var(--warn); }
.dshcn-dot[data-phase="offline"] { background: var(--danger); }

.dshcn-panel {
  position: absolute; inset: 6px;
  display: flex; flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 14px;
  /* 窗口只比面板大 12px（每边 6px）：大投影会被裁光，只留 6px 内的轻投影。 */
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.32);
  overflow: hidden;
  user-select: text;
}
.dshcn-head {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  cursor: grab;
  touch-action: none;
  flex: 0 0 auto;
}
.dshcn-head:active { cursor: grabbing; }
.dshcn-head .dshcn-dot { position: static; flex: 0 0 auto; }
.dshcn-title { flex: 1 1 auto; font-size: 13px; font-weight: 650; display: flex; flex-direction: column; gap: 1px; }
.dshcn-sub { font-size: 10.5px; font-weight: 500; color: var(--muted); }
.dshcn-icon {
  border: 0; background: transparent; color: var(--muted);
  width: 24px; height: 24px; border-radius: 6px; cursor: pointer;
  font-size: 16px; line-height: 1;
}
.dshcn-icon:hover { background: var(--assist); color: var(--fg); }
.dshcn-hint {
  margin: 10px 12px 0; padding: 9px 10px;
  border-radius: 8px; background: var(--assist);
  color: var(--muted); font-size: 11.5px; line-height: 1.5;
}
.dshcn-messages {
  flex: 1 1 auto; min-height: 0;
  overflow-y: auto; overscroll-behavior: contain;
  padding: 12px; display: flex; flex-direction: column; gap: 8px;
}
.dshcn-empty { color: var(--muted); font-size: 12px; line-height: 1.6; padding: 18px 6px; text-align: center; }
.dshcn-msg { max-width: 88%; padding: 8px 10px; border-radius: 10px; font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.dshcn-msg-user { align-self: flex-end; background: var(--brand); color: #fff; border-bottom-right-radius: 3px; }
.dshcn-msg-assistant { align-self: flex-start; background: var(--assist); border-bottom-left-radius: 3px; }
.dshcn-msg-system { align-self: center; background: transparent; color: var(--muted); font-size: 11px; }
.dshcn-msg[data-pending="true"] { opacity: 0.7; }
.dshcn-notice { margin: 0 12px 8px; padding: 7px 9px; border-radius: 7px; font-size: 11.5px; background: var(--assist); color: var(--muted); }
.dshcn-notice[data-kind="error"] { color: var(--danger); }
.dshcn-compose {
  flex: 0 0 auto;
  display: flex; gap: 8px; align-items: flex-end;
  padding: 10px 12px;
  border-top: 1px solid var(--line);
}
.dshcn-input {
  flex: 1 1 auto; resize: none;
  border: 1px solid var(--line); border-radius: 9px;
  background: var(--bg); color: var(--fg);
  padding: 8px 9px; font-size: 12.5px; line-height: 1.45;
  font-family: inherit; outline: none;
}
.dshcn-input:focus { border-color: var(--brand); box-shadow: 0 0 0 2px rgba(31, 99, 235, 0.16); }
.dshcn-send {
  flex: 0 0 auto;
  border: 0; border-radius: 9px; padding: 9px 14px;
  background: var(--brand); color: #fff;
  font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.dshcn-send:disabled { opacity: 0.45; cursor: default; }
.dshcn-foot {
  flex: 0 0 auto;
  display: flex; justify-content: space-between;
  padding: 6px 12px 8px;
  font-size: 10.5px; color: var(--muted);
}
.dshcn-foot [data-busy="true"] { color: var(--brand); }

.dshcn-mode { width: auto; padding: 0 6px; font-size: 11px; font-weight: 600; }

.dshcn-approvals { flex: 0 0 auto; padding: 10px 12px 0; display: flex; flex-direction: column; gap: 8px; }
.dshcn-approval {
  border: 1px solid #f0b429; border-radius: 9px;
  background: rgba(240, 180, 41, 0.12);
  padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;
}
.dshcn-approval-title { font-size: 12px; font-weight: 650; color: var(--fg); }
.dshcn-approval-reason { font-size: 11.5px; line-height: 1.45; color: var(--muted); white-space: pre-wrap; word-break: break-word; }
.dshcn-approval-actions { display: flex; gap: 8px; }
.dshcn-allow, .dshcn-reject {
  flex: 1 1 auto; border: 0; border-radius: 7px; padding: 6px 8px;
  font-size: 11.5px; font-weight: 600; cursor: pointer;
}
.dshcn-allow { background: var(--brand); color: #fff; }
.dshcn-reject { background: var(--assist); color: var(--fg); }

.dshcn-board { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 14px; }
.dshcn-group { display: flex; flex-direction: column; gap: 6px; }
.dshcn-group-head {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 11px; font-weight: 650; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.dshcn-group-count { background: var(--assist); border-radius: 8px; padding: 0 6px; font-size: 10.5px; }
.dshcn-card {
  border: 1px solid var(--line); border-radius: 9px; padding: 8px 10px;
  display: flex; flex-direction: column; gap: 4px;
  cursor: pointer; background: var(--bg);
}
.dshcn-card:hover { border-color: var(--brand); }
.dshcn-card-title { font-size: 12.5px; font-weight: 600; line-height: 1.4; }
.dshcn-card-meta { font-size: 10.5px; color: var(--muted); }
.dshcn-card-actions { display: flex; gap: 6px; padding-top: 2px; }
.dshcn-small {
  border: 1px solid var(--line); background: var(--assist); color: var(--fg);
  border-radius: 6px; padding: 3px 8px; font-size: 10.5px; cursor: pointer;
}
.dshcn-small:hover { border-color: var(--brand); color: var(--brand); }

.dshcn-drawer {
  position: absolute; inset: 0; z-index: 5;
  background: var(--bg); display: flex; flex-direction: column;
  border-radius: 14px;
}
.dshcn-drawer-loading { align-items: center; justify-content: center; color: var(--muted); font-size: 12px; }
.dshcn-drawer-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-bottom: 1px solid var(--line);
  font-size: 12.5px; font-weight: 650;
}
.dshcn-drawer-body { flex: 1 1 auto; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.dshcn-drawer-title { font-size: 13px; font-weight: 650; line-height: 1.45; }
.dshcn-drawer-meta { font-size: 11px; color: var(--muted); }
.dshcn-drawer-section { font-size: 11px; font-weight: 650; color: var(--muted); margin-top: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
.dshcn-drawer-list { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 4px; font-size: 12px; line-height: 1.5; }

.dshcn-board-wrap {
  flex: 1 1 auto; min-height: 0; overflow: hidden;
  --dsw-alias-bg-base: var(--bg);
  --dsw-alias-bg-layer-1: var(--bg);
  --dsw-alias-bg-layer-2: var(--assist);
  --dsw-alias-bg-layer-3: var(--assist);
  --dsw-alias-bg-mask-1: rgba(0, 0, 0, 0.2);
  --dsw-alias-bg-mask-2: rgba(0, 0, 0, 0.28);
  --dsw-alias-bg-module-platform: var(--assist);
  --dsw-alias-border-l1: var(--line);
  --dsw-alias-border-l2: var(--line);
  --dsw-alias-border-l3: var(--muted);
  --dsw-alias-border-selected: var(--brand);
  --dsw-alias-brand-primary: var(--brand);
  --dsw-alias-label-primary: var(--fg);
  --dsw-alias-label-secondary: var(--muted);
  --dsw-alias-label-tertiary: var(--muted);
  --dsw-alias-label-quaternary: var(--muted);
  --dsw-alias-label-on-color: #fff;
  --dsw-alias-card-fill: var(--bg);
  --dsw-alias-card-fill-hover: var(--assist);
  --dsw-alias-interactive-bg-hover: var(--assist);
  --dsw-alias-button-primary-fill: var(--brand);
  --dsw-alias-button-primary-hover: var(--brand);
  --dsw-alias-state-success-primary: #22c55e;
  --dsw-alias-state-success-secondary: #22c55e;
  --dsw-alias-state-warn-primary: #d97706;
  --dsw-alias-state-warn-secondary: #d97706;
  --dsw-alias-state-error-primary: #dc2626;
  --dsw-alias-state-error-secondary: #dc2626;
  --dsw-alias-scrollbar-bg-l: transparent;
  --dsw-alias-scrollbar-hover-l: var(--line);
}
.dshcn-board-wrap .dshc-board-header { padding: 8px 12px; }
.dshcn-board-wrap .dshc-board-columns { gap: 8px; padding: 10px 12px 12px; }
.dshcn-board-wrap .dshc-board-column { flex: 1 1 0; min-width: 0; }

.dshcn-question {
  flex: 0 0 auto; margin: 10px 12px 0; padding: 10px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--assist);
  display: flex; flex-direction: column; gap: 8px; max-height: 46%; overflow-y: auto;
}
.dshcn-question-title { font-size: 12px; font-weight: 650; }
.dshcn-question-item { display: flex; flex-direction: column; gap: 6px; }
.dshcn-question-header { font-size: 11px; color: var(--muted); }
.dshcn-question-text { font-size: 12.5px; line-height: 1.5; }
.dshcn-question-detail { font-size: 11px; color: var(--muted); white-space: pre-wrap; }
.dshcn-question-options { display: flex; flex-direction: column; gap: 4px; }
.dshcn-question-option { display: flex; gap: 6px; align-items: flex-start; font-size: 12px; line-height: 1.45; }
.dshcn-question-option em { display: block; font-style: normal; color: var(--muted); font-size: 10.5px; }
.dshcn-question-custom {
  border: 1px solid var(--line); border-radius: 7px; background: var(--bg); color: var(--fg);
  padding: 6px 8px; font-size: 12px; font-family: inherit; outline: none;
}
.dshcn-question-custom:focus { border-color: var(--brand); }
.dshcn-question-actions { display: flex; gap: 8px; justify-content: flex-end; position: sticky; bottom: 0; padding-top: 6px; background: var(--assist); }

.dshcn-transcript {
  display: flex; flex-direction: column; width: 100%; height: 100%;
  background: var(--bg); color: var(--fg);
}
.dshcn-transcript-head {
  flex: 0 0 auto; display: flex; align-items: baseline; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid var(--line);
  font-size: 13px; font-weight: 650;
}
.dshcn-transcript-id { font-size: 10.5px; font-weight: 500; color: var(--muted); }
.dshcn-transcript-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 8px; padding: 12px 16px;
}

.dshcn-md-table { width: 100%; border-collapse: collapse; margin: 2px 0; font-size: 11.5px; }
.dshcn-md-table th, .dshcn-md-table td { border: 1px solid var(--line); padding: 4px 6px; text-align: left; vertical-align: top; }
.dshcn-md-table th { background: var(--assist); font-weight: 650; }

.dshcn-todo-fab {
  position: absolute; right: 12px; bottom: 62px; z-index: 15;
  border: 0; border-radius: 999px; padding: 8px 14px;
  background: var(--brand); color: #fff; font-size: 12px; font-weight: 600;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.3); cursor: pointer;
}
.dshc-sheet-body .dshcn-question, .dshc-sheet-body .dshcn-approval, .dshc-sheet-body .dshcn-notice { margin: 0; }
.dshc-sheet-body .dshcn-question { max-height: none; }

.dshcn-settings-layer {
  position: absolute; inset: 0; z-index: 30;
  background: var(--bg); display: flex; flex-direction: column; border-radius: 14px;
}
.dshcn-settings-head {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border-bottom: 1px solid var(--line);
  font-size: 13px; font-weight: 650;
}
.dshcn-settings-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 12px; }

.dshcn-settings-back { width: auto; padding: 0 8px; font-size: 12px; }

.dshcn-typing {
  align-self: flex-start; display: flex; align-items: center; gap: 5px;
  padding: 8px 11px; border-radius: 10px; background: var(--assist);
  color: var(--muted); font-size: 11.5px;
}
.dshcn-typing-dot {
  width: 5px; height: 5px; border-radius: 50%; background: var(--brand);
  animation: dshcn-typing-blink 1.2s ease-in-out infinite;
}
.dshcn-typing-dot:nth-child(2) { animation-delay: 0.15s; }
.dshcn-typing-dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes dshcn-typing-blink {
  0%, 80%, 100% { opacity: 0.25; transform: translateY(0); }
  40% { opacity: 1; transform: translateY(-1px); }
}
/* 气泡窗（role=bubble）：336×76，独立透明窗，click-through。 */
.dshcn-bubble,
.dshcn-quick {
  --dshcn-bubble-bg: rgba(232, 240, 248, 0.92);
  --dshcn-bubble-ink: #15202b;
  --dshcn-bubble-line: rgba(110, 140, 170, 0.35);
  --dshcn-bubble-muted: #5e7286;
  --dshcn-bubble-accent: #4e7fa8;
  --dshcn-bubble-shadow: 0 3px 8px rgba(15, 30, 45, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.6);
  --dshcn-quick-error: #b91c1c;
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  padding: 12px;
  box-sizing: border-box;
  pointer-events: none;
}
.dshcn-bubble[data-side="left"] { justify-content: flex-end; }
.dshcn-bubble[data-side="right"] { justify-content: flex-start; }

.dshcn-bubble-pill {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: 312px;
  min-height: 44px;
  padding: 8px 13px 8px 10px;
  border: 1px solid var(--dshcn-bubble-line);
  border-radius: 15px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0) 46%),
    var(--dshcn-bubble-bg);
  box-shadow: var(--dshcn-bubble-shadow);
  color: var(--dshcn-bubble-ink);
  animation: dshcn-bubble-in 180ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
.dshcn-bubble[data-side="right"] .dshcn-bubble-pill { animation-name: dshcn-bubble-in-right; }
.dshcn-bubble-pill[data-tone="working"] { border-color: rgba(190, 215, 240, 0.34); }
.dshcn-bubble-pill[data-tone="success"] {
  --dshcn-bubble-accent: #047857;
  border-color: rgba(4, 120, 87, 0.34);
  animation: dshcn-done-pulse 2.8s ease-in-out infinite;
}
@keyframes dshcn-done-pulse {
  0%, 100% { box-shadow: var(--dshcn-bubble-shadow); }
  50% { box-shadow: var(--dshcn-bubble-shadow), 0 0 0 3px rgba(52, 211, 153, 0.14); }
}
.dshcn-bubble-icon {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: var(--dshcn-bubble-accent);
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.28), rgba(120, 160, 200, 0.15));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
}
.dshcn-bubble-pill[data-tone="success"] .dshcn-bubble-icon { background: rgba(4, 120, 87, 0.1); }
.dshcn-bubble-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  font-weight: 650;
  line-height: 1.35;
  white-space: nowrap;
}
.dshcn-bubble-check { display: block; width: 14px; height: 14px; }
.dshcn-bubble-tail {
  position: absolute;
  top: 50%;
  width: 9px;
  height: 9px;
  background: var(--dshcn-bubble-bg);
  transform: translateY(-50%) rotate(45deg);
}
.dshcn-bubble[data-side="left"] .dshcn-bubble-tail {
  right: -5px;
  border-top: 1px solid var(--dshcn-bubble-line);
  border-right: 1px solid var(--dshcn-bubble-line);
  border-radius: 2px;
}
.dshcn-bubble[data-side="right"] .dshcn-bubble-tail {
  left: -5px;
  border-bottom: 1px solid var(--dshcn-bubble-line);
  border-left: 1px solid var(--dshcn-bubble-line);
  border-radius: 2px;
}
@keyframes dshcn-bubble-in {
  from { opacity: 0; transform: translateX(6px) scale(0.96); }
  to { opacity: 1; transform: none; }
}
@keyframes dshcn-bubble-in-right {
  from { opacity: 0; transform: translateX(-6px) scale(0.96); }
  to { opacity: 1; transform: none; }
}

/* 快捷输入：复用气泡窗，悬停 0.8s 唤起；这一层需要接收鼠标和键盘。 */
.dshcn-quick {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  padding: 12px;
  box-sizing: border-box;
  pointer-events: auto;
}
.dshcn-quick[data-side="left"] { justify-content: flex-end; }
.dshcn-quick[data-side="right"] { justify-content: flex-start; }
.dshcn-quick-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 312px;
  max-width: 100%;
  height: 52px;
  padding: 0 8px 0 10px;
  box-sizing: border-box;
  border: 1px solid var(--dshcn-bubble-line);
  border-radius: 15px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0) 46%),
    var(--dshcn-bubble-bg);
  box-shadow: var(--dshcn-bubble-shadow);
  color: var(--dshcn-bubble-ink);
  animation: dshcn-bubble-in 180ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
.dshcn-quick[data-side="right"] .dshcn-quick-bar { animation-name: dshcn-bubble-in-right; }
.dshcn-quick-bar:focus-within { border-color: rgba(190, 225, 255, 0.55); }
.dshcn-quick[data-error="true"] .dshcn-quick-bar { border-color: rgba(255, 93, 93, 0.5); }
.dshcn-quick-mark {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.28), rgba(120, 160, 200, 0.15));
  color: var(--dshcn-bubble-accent);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
  font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.dshcn-quick-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
}
.dshcn-quick-input {
  width: 100%;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--dshcn-bubble-ink);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.3;
}
.dshcn-quick-input:disabled { opacity: 0.7; }
.dshcn-quick-hint {
  min-height: 11px;
  font-size: 9px;
  line-height: 1.2;
  color: var(--dshcn-bubble-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dshcn-quick-hint[data-error="true"] { color: var(--dshcn-quick-error); }
.dshcn-quick-send {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  cursor: pointer;
}
.dshcn-quick-send {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: linear-gradient(145deg, #e6f1ff 0%, #a8c4e0 48%, #5d7894 100%);
  color: #0c1824;
  box-shadow:
    0 2px 6px rgba(0, 0, 0, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.6);
}
.dshcn-quick-send:disabled { opacity: 0.35; cursor: default; }
.dshcn-quick-send svg { display: block; width: 14px; height: 14px; }

@media (prefers-color-scheme: dark) {
  .dshcn-bubble,
  .dshcn-quick {
    --dshcn-bubble-bg: rgba(24, 33, 43, 0.9);
    --dshcn-bubble-ink: #eef6ff;
    --dshcn-bubble-line: rgba(185, 215, 245, 0.3);
    --dshcn-bubble-muted: #9fb2c8;
    --dshcn-bubble-accent: #b9e0ff;
    --dshcn-bubble-shadow: 0 3px 8px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.12);
    --dshcn-quick-error: #ff9b9b;
  }
  .dshcn-bubble-pill[data-tone="working"] { border-color: rgba(190, 220, 250, 0.3); }
  .dshcn-bubble-pill[data-tone="success"] {
    --dshcn-bubble-accent: #34d399;
    border-color: rgba(52, 211, 153, 0.34);
    animation: dshcn-done-pulse 2.8s ease-in-out infinite;
  }
  .dshcn-bubble-icon { background: rgba(185, 224, 255, 0.12); }
  .dshcn-bubble-pill[data-tone="success"] .dshcn-bubble-icon { background: rgba(52, 211, 153, 0.13); }
}

@media (prefers-reduced-motion: reduce) {
  .dshcn-ball,
  .dshcn-orb-surface *,
  .dshcn-bubble-pill {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}
`
