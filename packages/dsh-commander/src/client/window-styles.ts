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
  inset: 4px;
  width: calc(100% - 8px);
  height: calc(100% - 8px);
  border: 0;
  border-radius: 50%;
  background: radial-gradient(circle at 32% 28%, #4f8bff, var(--brand) 62%, #1748b8);
  color: #fff;
  box-shadow: 0 6px 18px rgba(15, 40, 100, 0.45), 0 1px 0 rgba(255, 255, 255, 0.35) inset;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  padding: 0;
  touch-action: none;
  transition: transform 140ms ease, box-shadow 140ms ease;
}
.dshcn-ball:hover { transform: translateY(-1px) scale(1.12); box-shadow: 0 12px 28px rgba(15, 40, 100, 0.55); }
.dshcn-ball:active { transform: scale(1.02); }
.dshcn-ball.is-dragging { cursor: grabbing; transform: scale(0.97); }
.dshcn-ball[data-bound="false"] { background: radial-gradient(circle at 32% 28%, #8b94a3, #5b6472 62%, #3d4552); }
.dshcn-flag {
  width: 14px; height: 16px;
  background:
    linear-gradient(#fff, #fff) 2px 1px / 2px 14px no-repeat,
    linear-gradient(#fff, #fff) 2px 1px / 11px 6px no-repeat;
  clip-path: polygon(0 0, 100% 0, 100% 55%, 0 55%, 0 100%, 0 0);
  opacity: 0.95;
}
.dshcn-badge {
  position: absolute; top: -1px; right: -1px;
  min-width: 20px; height: 20px; padding: 0 5px;
  border-radius: 10px;
  background: #f59e0b; color: #1b1e23;
  font-size: 11px; font-weight: 700; line-height: 20px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}
.dshcn-dot {
  position: absolute; right: 2px; bottom: 2px;
  width: 9px; height: 9px; border-radius: 50%;
  background: #9aa1ab;
  border: 1.5px solid var(--bg);
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
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
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
.dshcn-ball[data-busy="true"] {
  animation: dshcn-ball-pulse 1.6s ease-in-out infinite;
}
@keyframes dshcn-ball-pulse {
  0%, 100% { box-shadow: 0 6px 18px rgba(15, 40, 100, 0.45); }
  50% { box-shadow: 0 0 0 8px rgba(79, 139, 255, 0.25), 0 10px 26px rgba(15, 40, 100, 0.5); }
}
`
