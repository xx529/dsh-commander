/**
 * Injected style sheet for the Commander Client surface.
 *
 * The plugin cannot edit global CSS, so the sheet is rendered as a local
 * `<style>` element inside the slot entries (React removes it on unmount).
 * Every color comes from a DSH theme alias token (`--dsw-alias-*`), so light
 * and dark themes follow the host automatically; spacing, radii, and motion
 * are fixed values consistent with the host's controls.
 */
export const STYLES = `
.dshc-root { font-family: inherit; color: var(--dsw-alias-label-primary); pointer-events: none; }

/* ---------------------------------------------------------------- ball */
.dshc-ball {
  position: fixed; z-index: 1000; width: 56px; height: 56px; padding: 0; overflow: visible;
  /* The overlay layer (and .dshc-root) is click-through; the ball opts back in. */
  pointer-events: auto;
  display: flex; align-items: center; justify-content: center;
  border: 0; border-radius: 28px; cursor: pointer;
  color: var(--dsw-alias-label-on-color);
  background:
    linear-gradient(155deg, var(--dsw-alias-button-primary-hover) 0%, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-button-primary-fill) 100%);
  box-shadow:
    0 9px 24px var(--dsw-alias-bg-mask-2),
    inset 0 1px 0 rgba(255, 255, 255, .28),
    inset 0 0 0 1px rgba(255, 255, 255, .08);
  transition: transform .18s cubic-bezier(.4,0,.2,1), filter .18s cubic-bezier(.4,0,.2,1), box-shadow .18s cubic-bezier(.4,0,.2,1);
}
/* 自由拖动：位置由组件按归一化坐标算成 left/top（内联），这里只管手感。 */
.dshc-ball { touch-action: none; cursor: grab; }
/*
 * DSH 桌面端把侧边栏 logo 行 / 会话标题行标成 [data-window-drag]{-webkit-app-region:drag}，
 * 那片区域的指针事件会被 Electron 的窗口拖拽区吞掉。浮窗/面板是覆盖层（不在拖拽区 DOM 内），
 * 必须显式声明 no-drag 才能在上面打洞——否则拖到标题条附近后既点不动也拖不动（2026-11-18 用户反馈）。
 */
.dshc-ball, .dshc-panel { -webkit-app-region: no-drag; app-region: no-drag; }
.dshc-ball[data-dragging='true'] { cursor: grabbing; transition: none; }
.dshc-ball:hover { transform: translateY(-1px) scale(1.035); filter: brightness(1.07); }
.dshc-ball:active { transform: scale(.97); }
.dshc-ball:focus-visible { outline: 2px solid var(--dsw-alias-border-selected); outline-offset: 3px; }
.dshc-ball-mark { width: 25px; height: 25px; display: block; overflow: visible; }
.dshc-ball-mark-pole { fill: none; stroke: currentColor; stroke-width: 2.1; stroke-linecap: round; }
.dshc-ball-mark-flag { fill: currentColor; }
.dshc-ball[data-busy='true']::after {
  content: ""; position: absolute; inset: -5px; border-radius: 50%;
  border: 1px solid var(--dsw-alias-border-selected);
  animation: dshc-ball-ring 1.8s ease-out infinite;
  pointer-events: none;
}
@keyframes dshc-ball-ring {
  0% { transform: scale(.94); opacity: .75; }
  70% { transform: scale(1.18); opacity: 0; }
  100% { opacity: 0; }
}
.dshc-ball-badge {
  position: absolute; top: -2px; right: -2px; min-width: 18px; height: 18px; padding: 0 4px;
  display: flex; align-items: center; justify-content: center; box-sizing: border-box;
  border-radius: 9px; font-size: 10.5px; font-weight: 700; line-height: 1;
  color: #211604;
  background: var(--dsw-alias-state-warn-primary);
  border: 2px solid var(--dsw-alias-bg-base);
  box-shadow: 0 2px 6px var(--dsw-alias-bg-mask-2);
}
.dshc-ball-state {
  position: absolute; right: 4px; bottom: 4px; width: 9px; height: 9px; border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary);
  border: 2px solid var(--dsw-alias-bg-base);
}
.dshc-ball-state[data-tone='offline'], .dshc-ball-state[data-tone='broken'] { background: var(--dsw-alias-state-error-primary); }
.dshc-ball-label {
  position: fixed; z-index: 1000;
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
  padding: 6px 9px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: 0 10px 26px var(--dsw-alias-bg-mask-2);
  width: max-content; max-width: 260px;
  color: var(--dsw-alias-label-primary); text-align: left; white-space: nowrap;
  pointer-events: none; opacity: 0;
  transition: opacity .16s cubic-bezier(.4,0,.2,1);
}
.dshc-ball-label-title { font-size: 11px; font-weight: 600; line-height: 1.3; }
.dshc-ball-label-sub { font-size: 9.5px; line-height: 1.3; color: var(--dsw-alias-state-warn-primary); }
.dshc-ball:hover + .dshc-ball-label, .dshc-ball:focus-visible + .dshc-ball-label { opacity: 1; }
.dshc-ball-label[data-open='true'] { opacity: 0 !important; }
.dshc-ball[data-status='unbound'] { background: var(--dsw-alias-bg-module-platform); }
.dshc-ball[data-status='broken'] { background: var(--dsw-alias-state-error-primary); }

/* --------------------------------------------------------------- panel */
.dshc-panel {
  position: fixed; z-index: 1000; width: 420px; height: 660px; max-height: calc(100vh - 120px);
  /* Same opt-in as the ball; descendants inherit auto from the panel. */
  pointer-events: auto;
  display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden;
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: 0 18px 48px var(--dsw-alias-bg-mask-2);
  color: var(--dsw-alias-label-primary);
}
.dshc-panel-header {
  display: flex; align-items: center; gap: 8px; padding: 13px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
}
.dshc-panel-title { font-size: 15px; font-weight: 600; line-height: 1.2; color: var(--dsw-alias-label-primary); }
.dshc-panel-meta { flex: 1; min-width: 0; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshc-pill {
  flex: none; padding: 2px 8px; border-radius: 999px; font-size: 11px; line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
}
.dshc-pill[data-status='bound'] { color: var(--dsw-alias-state-success-primary); }
.dshc-pill[data-status='broken'] { color: var(--dsw-alias-state-error-primary); }
.dshc-icon-button {
  flex: none; width: 28px; height: 28px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 8px; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  transition: background .2s cubic-bezier(.4,0,.2,1);
}
.dshc-icon-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshc-icon-button:focus-visible { outline: 2px solid var(--dsw-alias-border-selected); outline-offset: 1px; }
.dshc-icon-button:disabled { opacity: .45; cursor: not-allowed; }

.dshc-panel-body {
  flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px;
  scrollbar-width: thin;
  scrollbar-color: var(--dsh-scrollbar-thumb) transparent;
}
.dshc-panel-body[data-fab='true'] { padding-bottom: 48px; }
.dshc-panel-body::-webkit-scrollbar { width: 8px; }
.dshc-panel-body::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l1); border-radius: 4px;
}
.dshc-panel-body::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l1); }
.dshc-empty { margin: auto 0; padding: 32px 18px; text-align: center; font-size: 12.5px; line-height: 1.7; color: var(--dsw-alias-label-tertiary); }

.dshc-msg { display: flex; flex-direction: column; gap: 3px; }
.dshc-msg[data-role='user'] { align-items: flex-end; }
.dshc-msg[data-role='assistant'] { align-items: flex-start; }
.dshc-msg[data-role='system'] { align-items: center; }
.dshc-msg-author { font-size: 11px; color: var(--dsw-alias-label-tertiary); padding: 0 2px; }
.dshc-bubble {
  max-width: 86%; box-sizing: border-box; padding: 9px 12px; border-radius: 12px;
  font-size: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere;
}
.dshc-msg[data-role='user'] .dshc-bubble {
  color: var(--dsw-alias-label-on-color);
  background: var(--dsw-alias-brand-primary);
  border-bottom-right-radius: 4px;
}
.dshc-msg[data-role='assistant'] .dshc-bubble {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  border-bottom-left-radius: 4px;
}
.dshc-msg[data-pending='true'] .dshc-bubble { opacity: .6; }
/* assistant 回复走 Markdown：块级排版不需要 pre-wrap，宽表格可横向滚动 */
.dshc-bubble--markdown { white-space: normal; overflow-x: auto; }
.dshc-bubble--markdown > :first-child { margin-top: 0; }
.dshc-bubble--markdown > :last-child { margin-bottom: 0; }
.dshc-msg[data-role='system'] .dshc-bubble {
  max-width: 100%; padding: 2px 4px; font-size: 11px; color: var(--dsw-alias-label-tertiary);
  background: transparent; border: none;
}
.dshc-msg-time { font-size: 10px; color: var(--dsw-alias-label-quaternary); padding: 0 2px; }

.dshc-banner {
  display: flex; align-items: flex-start; gap: 8px; margin: 0 16px 10px; padding: 8px 10px;
  border-radius: 8px; font-size: 12px; line-height: 1.5;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.dshc-banner[data-kind='error'] { background: var(--dsw-alias-state-error-secondary); border-color: var(--dsw-alias-state-error-primary); }
.dshc-banner[data-kind='ok'] { background: var(--dsw-alias-state-success-secondary); border-color: var(--dsw-alias-state-success-primary); }
.dshc-banner-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dshc-banner-actions { display: flex; gap: 6px; flex: none; }

.dshc-composer {
  flex: none; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px 11px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
}
.dshc-input {
  width: 100%; box-sizing: border-box; min-height: 40px; max-height: 112px; padding: 10px 12px;
  resize: none; overflow-y: auto; border-radius: 10px; outline: none;
  font-family: inherit; font-size: 13px; line-height: 1.5;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l2);
  transition: border-color .2s cubic-bezier(.4,0,.2,1);
}
.dshc-input::placeholder { color: var(--dsw-alias-label-quaternary); }
.dshc-input:focus { border-color: var(--dsw-alias-border-selected); }
.dshc-input:disabled { opacity: .6; }
.dshc-composer-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-quaternary); }
.dshc-composer-hint { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshc-composer-hint[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary); }
.dshc-composer-hint[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }

/* ------------------------------------------------------------- buttons */
.dshc-button {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  padding: 5px 12px; border-radius: 8px; font-family: inherit; font-size: 12px; line-height: 1.5;
  border: 1px solid transparent; cursor: pointer;
  transition: background .2s cubic-bezier(.4,0,.2,1), border-color .2s cubic-bezier(.4,0,.2,1);
}
.dshc-button:focus-visible { outline: 2px solid var(--dsw-alias-border-selected); outline-offset: 1px; }
.dshc-button:disabled { opacity: .45; cursor: not-allowed; }
.dshc-button[data-variant='primary'] {
  color: var(--dsw-alias-label-on-color);
  background: var(--dsw-alias-button-primary-fill);
}
.dshc-button[data-variant='primary']:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dshc-button[data-variant='secondary'] {
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border-color: var(--dsw-alias-border-l2);
}
.dshc-button[data-variant='secondary']:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshc-button[data-variant='ghost'] { color: var(--dsw-alias-label-secondary); background: transparent; }
.dshc-button[data-variant='ghost']:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshc-button[data-size='sm'] { padding: 2px 8px; font-size: 11px; }

/* ------------------------------------------------------------ settings */
.dshc-settings { display: flex; flex-direction: column; gap: 16px; padding: 2px 2px 28px; font-size: 13px; color: var(--dsw-alias-label-primary); pointer-events: auto; }
.dshc-settings-intro { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
.dshc-card {
  display: flex; flex-direction: column; gap: 12px; padding: 16px; border-radius: 12px;
  background: var(--dsw-alias-card-fill);
  border: 1px solid var(--dsw-alias-border-l1);
}
.dshc-card-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13.5px; font-weight: 600; }
.dshc-card-desc { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
.dshc-kv { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 6px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
/* Labels are plain spans; long values must never push the value column out of view. */
.dshc-kv > span { min-width: 0; overflow-wrap: anywhere; }
.dshc-board-section .dshc-kv { grid-template-columns: minmax(88px, max-content) minmax(0, 1fr); }
.dshc-kv-value { color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dshc-kv-value[data-muted='true'] { color: var(--dsw-alias-label-tertiary); }
.dshc-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.dshc-field { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.dshc-field-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.dshc-field[data-span='2'] { grid-column: 1 / -1; }
.dshc-field-input, .dshc-field-select, .dshc-field-textarea {
  width: 100%; box-sizing: border-box; font-family: inherit; font-size: 12.5px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; outline: none;
}
.dshc-field-input, .dshc-field-select { height: 30px; padding: 0 10px; }
.dshc-field-select { cursor: pointer; }
.dshc-field-textarea { min-height: 58px; padding: 7px 10px; line-height: 1.5; resize: vertical; }
.dshc-field-input:focus, .dshc-field-select:focus, .dshc-field-textarea:focus { border-color: var(--dsw-alias-border-selected); }
.dshc-field-range { width: 100%; accent-color: var(--dsw-alias-brand-primary); }
.dshc-field-range-row { display: flex; align-items: center; gap: 10px; }
.dshc-field-range-value { flex: none; min-width: 36px; text-align: right; font-size: 12px; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.dshc-check { width: 15px; height: 15px; margin: 2px 0 0; accent-color: var(--dsw-alias-brand-primary); }
.dshc-ws-row { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 10px; padding: 10px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dshc-ws-row:first-child { border-top: none; padding-top: 0; }
.dshc-ws-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dshc-ws-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dshc-ws-name { font-size: 12.5px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dshc-ws-path { font-family: var(--dsh-font-family-code); font-size: 10.5px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.dshc-row-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.dshc-result { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.dshc-result[data-kind='ok'] { color: var(--dsw-alias-state-success-primary); }
.dshc-result[data-kind='error'] { color: var(--dsw-alias-state-error-primary); }
.dshc-note {
  font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary);
  padding: 7px 10px; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  border-left: 2px solid var(--dsw-alias-state-warn-primary);
}
.dshc-divider { height: 1px; background: var(--dsw-alias-border-l1); }
.dshc-sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}


/* ------------------------------------------------ dispatch card (M1) */
.dshc-card-dispatch {
  display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary); pointer-events: auto;
}
.dshc-card-dispatch[data-expired='true'] { opacity: .65; }
.dshc-dispatch-head { display: flex; align-items: center; gap: 8px; }
.dshc-dispatch-title { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; }
.dshc-dispatch-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshc-dispatch-tasktitle { font-size: 13px; font-weight: 600; line-height: 1.45; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dshc-tag {
  flex: none; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 400;
  color: var(--dsw-alias-state-warn-primary);
  border: 1px solid var(--dsw-alias-state-warn-primary);
}
.dshc-dispatch-countdown { flex: none; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dshc-dispatch-target { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; font-size: 12px; font-weight: 500; }
.dshc-dispatch-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dshc-meter { position: relative; height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-1); }
.dshc-meter-fill { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 3px; background: var(--dsw-alias-brand-primary); }
.dshc-meter-threshold { position: absolute; top: -3px; bottom: -3px; width: 2px; border-radius: 1px; background: var(--dsw-alias-state-warn-primary); }
.dshc-candidates { display: flex; flex-direction: column; gap: 4px; }
.dshc-candidates-details { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 4px; }
.dshc-candidates-details summary {
  display: flex; align-items: center; gap: 4px; cursor: pointer; list-style: none;
  font-size: 11px; color: var(--dsw-alias-label-secondary);
}
.dshc-candidates-details summary::-webkit-details-marker { display: none; }
.dshc-candidates-details summary::after { content: "›"; color: var(--dsw-alias-label-quaternary); font-size: 12px; line-height: 1; }
.dshc-candidates-details[open] summary { margin-bottom: 5px; }
.dshc-candidates-details[open] summary::after { transform: rotate(90deg); }
.dshc-candidate {
  display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) auto; gap: 8px; align-items: center;
  padding: 4px 7px; border-radius: 6px; font-size: 11.5px; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1);
}
.dshc-candidate[data-recommended='true'] { border-color: var(--dsw-alias-border-selected); }
.dshc-candidate-name { color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshc-candidate-mode { color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshc-candidate-pct { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.dshc-dispatch-reason { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dshc-dispatch-actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.dshc-dispatch-custom {
  display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 8px;
  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1);
}
.dshc-dispatch-waiting { font-size: 11.5px; color: var(--dsw-alias-state-warn-primary); }
.dshc-dispatch-sent {
  display: inline-flex; align-items: center; gap: 6px; width: fit-content; max-width: calc(100% - 28px);
  margin: 0 14px 8px; padding: 4px 8px; border-radius: 6px;
  font-size: 10.5px; line-height: 1.4; color: var(--dsw-alias-state-success-primary);
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
}

/* ------------------------------------------------- task strip (M1) */
.dshc-taskbar {
  flex: none; display: flex; flex-direction: column; gap: 6px; padding: 8px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
}
.dshc-taskbar-head { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dshc-taskbar-counts { display: flex; flex-wrap: wrap; gap: 4px; flex: 1; }
.dshc-chip {
  padding: 1px 7px; border-radius: 999px; font-size: 10.5px;
  color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l2);
}
.dshc-chip[data-status='running'] { color: var(--dsw-alias-state-success-primary); }
.dshc-chip[data-status='queued'] { color: var(--dsw-alias-brand-primary); }
.dshc-chip[data-status='blocked'] { color: var(--dsw-alias-state-error-primary); }
.dshc-chip[data-status='review'] { color: var(--dsw-alias-state-warn-primary); }
.dshc-tasklist { display: flex; flex-direction: column; gap: 4px; }
.dshc-task-row {
  display: flex; align-items: center; gap: 8px; padding: 4px 7px; border-radius: 6px;
  font-size: 11.5px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1);
}
.dshc-task-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.dshc-task-ws { flex: none; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.dshc-task-status {
  flex: none; padding: 1px 7px; border-radius: 999px; font-size: 10.5px;
  color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l2);
}
.dshc-task-status[data-status='running'] { color: var(--dsw-alias-state-success-primary); }
.dshc-task-status[data-status='queued'] { color: var(--dsw-alias-brand-primary); }
.dshc-task-status[data-status='blocked'] { color: var(--dsw-alias-state-error-primary); }
.dshc-task-status[data-status='review'] { color: var(--dsw-alias-state-warn-primary); }
.dshc-task-cap { flex: none; font-size: 10px; color: var(--dsw-alias-label-tertiary); }

/* --------------------------------------------- settings: switch/test */
.dshc-switch-row { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--dsw-alias-label-primary); }
.dshc-switch {
  position: relative; flex: none; width: 34px; height: 20px; padding: 0; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-3);
  cursor: pointer;
}
.dshc-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dshc-switch[aria-checked='true'] .dshc-switch-knob { left: 16px; }
.dshc-switch[aria-disabled='true'] { cursor: not-allowed; opacity: .65; }
.dshc-switch:focus-visible { outline: 2px solid var(--dsw-alias-border-selected); outline-offset: 2px; }
.dshc-switch-knob { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 7px; background: var(--dsw-alias-bg-base); transition: left .15s cubic-bezier(.4,0,.2,1); }
.dshc-test-result { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.dshc-test-result[data-kind='ok'] { color: var(--dsw-alias-state-success-primary); }
.dshc-test-result[data-kind='error'] { color: var(--dsw-alias-state-error-primary); }
.dshc-msg-toggle {
  background: none; border: none; padding: 0; cursor: pointer;
  font-family: inherit; font-size: 11px; color: var(--dsw-alias-brand-primary);
}


/* ---------------------------------------- attach session picker (M1R) */
.dshc-session-picker { display: flex; flex-direction: column; gap: 6px; }
.dshc-session-state { font-size: 11px; color: var(--dsw-alias-label-tertiary); display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dshc-session-state[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary); }
.dshc-session-state[data-tone='muted'] { color: var(--dsw-alias-label-quaternary); }
.dshc-session-state[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }
.dshc-session-list {
  display: flex; flex-direction: column; gap: 4px; max-height: 168px; overflow-y: auto;
  padding: 2px; border-radius: 8px; pointer-events: auto;
  scrollbar-width: thin; scrollbar-color: var(--dsh-scrollbar-thumb) transparent;
}
.dshc-session-row {
  display: flex; flex-direction: column; gap: 2px; width: 100%; box-sizing: border-box;
  padding: 6px 8px; border-radius: 6px; cursor: pointer; text-align: left;
  font-family: inherit; font-size: 11.5px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  transition: border-color .2s cubic-bezier(.4,0,.2,1), background .2s cubic-bezier(.4,0,.2,1);
}
.dshc-session-row:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshc-session-row[data-selected='true'] { border-color: var(--dsw-alias-border-selected); }
.dshc-session-row:focus-visible { outline: 2px solid var(--dsw-alias-border-selected); outline-offset: 1px; }
.dshc-session-row:disabled { opacity: .55; cursor: not-allowed; }
.dshc-session-title {
  display: flex; align-items: baseline; gap: 6px; min-width: 0;
  font-size: 12px; color: var(--dsw-alias-label-primary);
}
.dshc-session-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshc-session-shortid { flex: none; font-size: 10px; color: var(--dsw-alias-label-quaternary); font-variant-numeric: tabular-nums; }
.dshc-session-title[data-unnamed='true'] .dshc-session-name { color: var(--dsw-alias-label-tertiary); font-style: italic; }
.dshc-session-meta { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }


/* ------------------------------------------------- M2 board page */
.dshc-board {
  position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; box-sizing: border-box;
  padding-top: var(--dsh-frame-top-clearance, 0px);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  pointer-events: auto;
  /* 「结论」卡的强调色：DSH 色板里的深蓝，刻意避开证据勾的语义绿/琥珀。 */
  --dshc-conclusion-accent: var(--dsw-static-deepseek-450, #5686fe);
}
.dshc-board-header {
  flex: none; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 12px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.dshc-board-heading { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dshc-board-title { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.2; }
.dshc-board-subtitle { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.dshc-board-tabs { display: flex; gap: 4px; margin-left: auto; }
.dshc-board-tab {
  padding: 4px 10px; border-radius: 8px; font-family: inherit; font-size: 12px; cursor: pointer;
  color: var(--dsw-alias-label-secondary); background: transparent; border: 1px solid transparent;
}
.dshc-board-tab:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshc-board-tab[data-active='true'] {
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-border-l2);
}
.dshc-board-actions { display: flex; gap: 6px; }
.dshc-board-toast {
  flex: none; margin: 8px 20px 0; padding: 6px 10px; border-radius: 8px;
  font-size: 12px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
}
.dshc-board-toast[data-kind='ok'] { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.dshc-board-toast[data-kind='error'] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dshc-board-columns {
  flex: 1; min-height: 0; display: flex; gap: 12px; align-items: stretch;
  padding: 12px 20px 20px; overflow-x: auto; overflow-y: hidden;
}
.dshc-board-column {
  flex: 0 0 272px; display: flex; flex-direction: column; min-height: 0; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
}
.dshc-board-column-head {
  flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dshc-board-column-title { font-size: 12.5px; font-weight: 600; }
.dshc-board-count {
  font-size: 11px; color: var(--dsw-alias-label-tertiary); padding: 1px 7px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
}
.dshc-board-column-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.dshc-board-column-empty { padding: 16px 0; text-align: center; font-size: 11.5px; color: var(--dsw-alias-label-quaternary); }
.dshc-board-card {
  display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 10px;
  background: var(--dsw-alias-card-fill); border: 1px solid var(--dsw-alias-border-l1);
  border-left: 3px solid var(--dsw-alias-border-l3); cursor: pointer; outline: none;
}
.dshc-board-card:hover { background: var(--dsw-alias-card-fill-hover); }
.dshc-board-card:focus-visible { border-color: var(--dsw-alias-border-selected); }
.dshc-board-card[data-status='queued'], .dshc-board-card[data-status='running'] { border-left-color: var(--dsw-alias-brand-primary); }
.dshc-board-card[data-status='blocked'] { border-left-color: var(--dsw-alias-state-error-primary); }
.dshc-board-card[data-status='review'] { border-left-color: var(--dsw-alias-state-warn-primary); }
.dshc-board-card[data-status='done'] { border-left-color: var(--dsw-alias-state-success-primary); }
.dshc-board-card[data-pending-dispatch='true'] { box-shadow: inset 0 0 0 1px var(--dsw-alias-border-selected); }
.dshc-board-card-head { display: flex; align-items: flex-start; gap: 6px; }
.dshc-board-card-title { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
.dshc-board-stale {
  flex: none; font-size: 10px; padding: 0 6px; border-radius: 999px;
  color: var(--dsw-alias-state-warn-primary); border: 1px solid var(--dsw-alias-state-warn-primary);
}
.dshc-board-card-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.dshc-board-priority { padding: 0 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); }
.dshc-board-priority[data-priority='high'] { color: var(--dsw-alias-state-warn-primary); }
.dshc-board-priority[data-priority='urgent'] { color: var(--dsw-alias-state-error-primary); }
.dshc-board-priority[data-priority='low'] { color: var(--dsw-alias-label-quaternary); }
.dshc-board-card-status { margin-left: auto; }
.dshc-board-card-block { font-size: 10.5px; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.dshc-board-card-badges { display: flex; flex-wrap: wrap; gap: 4px; }
.dshc-board-badge {
  font-size: 9.5px; line-height: 16px; padding: 0 6px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary);
}
.dshc-board-badge[data-tone='pending'] { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.dshc-board-badge[data-tone='waiting'] { color: var(--dsw-alias-label-secondary); }
.dshc-board-badge[data-tone='ready'] { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.dshc-board-badge[data-tone='continue'] { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dshc-board-card-foot { display: flex; justify-content: space-between; gap: 8px; font-size: 10px; color: var(--dsw-alias-label-quaternary); }
.dshc-board-card-actions { display: flex; gap: 10px; opacity: 0; transition: opacity .15s cubic-bezier(.4,0,.2,1); }
.dshc-board-card:hover .dshc-board-card-actions, .dshc-board-card:focus-within .dshc-board-card-actions { opacity: 1; }
.dshc-board-trash { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 20px; display: flex; flex-direction: column; gap: 6px; }
.dshc-board-trash-row {
  display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); font-size: 12px;
}
.dshc-board-trash-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshc-board-trash-time { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.dshc-board-state { padding: 24px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dshc-board-mask { position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1); z-index: 5; }
.dshc-board-drawer {
  position: absolute; top: 0; right: 0; bottom: 0; z-index: 6; width: min(520px, 94%);
  display: flex; flex-direction: column; box-sizing: border-box;
  background: var(--dsw-alias-bg-layer-1);
  border-left: 1px solid var(--dsw-alias-border-l2);
  box-shadow: -12px 0 32px var(--dsw-alias-bg-mask-1);
}
.dshc-board-drawer summary { list-style: none; }
.dshc-board-drawer summary::-webkit-details-marker { display: none; }

/* ------------------------------------------------------------------ drawer D */
.dshc-d-head { flex: none; padding: 16px 18px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshc-d-head--slim { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 16px; }
.dshc-d-slim-title { font-size: 13.5px; font-weight: 600; }
.dshc-d-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.dshc-d-eyebrow {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0;
  padding-right: 2px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary);
}
.dshc-d-sep { color: var(--dsw-alias-label-quaternary); }
.dshc-d-workspace { color: var(--dsw-alias-label-secondary); }
.dshc-d-status {
  display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px;
  border-radius: 999px; background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary); font-size: 11.5px; font-weight: 500;
}
.dshc-d-status i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.dshc-d-status[data-status='review'] { color: var(--dsw-alias-state-warn-primary); }
.dshc-d-status[data-status='done'] { color: var(--dsw-alias-state-success-primary); }
.dshc-d-status[data-status='blocked'] { color: var(--dsw-alias-state-error-primary); }
.dshc-d-status[data-status='running'] { color: var(--dsw-alias-brand-primary); }
.dshc-d-priority {
  padding: 0; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11.5px; cursor: pointer;
}
.dshc-d-head-actions { position: relative; display: flex; align-items: center; gap: 2px; flex: none; margin: -4px -6px 0 0; }
.dshc-d-menu {
  position: absolute; top: 32px; right: 0; z-index: 10; min-width: 148px; padding: 4px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); box-shadow: 0 12px 32px var(--dsw-alias-bg-mask-2);
}
.dshc-d-menu button {
  display: block; width: 100%; padding: 7px 9px; border: 0; border-radius: 6px;
  background: transparent; text-align: left; font: inherit; font-size: 12px;
  color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.dshc-d-menu button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

.dshc-d-title {
  display: block; width: 100%; box-sizing: border-box; margin: 8px 0 0;
  padding: 1px 4px 3px; border: 1px solid transparent; border-radius: 6px;
  background: transparent; font-family: inherit; font-size: 18px; font-weight: 600; line-height: 1.4;
  color: var(--dsw-alias-label-primary);
}
.dshc-d-title:hover { border-color: var(--dsw-alias-border-l1); }
.dshc-d-title:focus { outline: none; border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.dshc-d-steps { list-style: none; margin: 14px 4px 0; padding: 0; display: flex; gap: 4px; }
.dshc-d-steps li {
  flex: 1; display: flex; flex-direction: column; gap: 6px;
  font-size: 10.5px; color: var(--dsw-alias-label-quaternary); white-space: nowrap;
}
.dshc-d-steps li i { height: 3px; border-radius: 2px; background: var(--dsw-alias-border-l2); }
.dshc-d-steps li[data-state='done'] { color: var(--dsw-alias-label-tertiary); }
.dshc-d-steps li[data-state='done'] i { background: var(--dsw-alias-state-success-primary); opacity: .65; }
.dshc-d-steps li[data-state='active'] { color: var(--dsw-alias-state-warn-primary); font-weight: 600; }
.dshc-d-steps li[data-state='active'] i { background: var(--dsw-alias-state-warn-primary); }
.dshc-d-steps li[data-state='active'][data-tone='success'] { color: var(--dsw-alias-state-success-primary); }
.dshc-d-steps li[data-state='active'][data-tone='success'] i { background: var(--dsw-alias-state-success-primary); }
.dshc-d-steps li[data-blocked='true'] { color: var(--dsw-alias-state-error-primary); }
.dshc-d-steps li[data-blocked='true'] i { background: var(--dsw-alias-state-error-primary); }
.dshc-d-steps li[data-terminal='true'] { opacity: .55; }
.dshc-d-deps {
  margin: 10px 4px 0; padding: 9px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
  display: flex; flex-direction: column; gap: 4px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary);
}
.dshc-d-deps b { color: var(--dsw-alias-label-secondary); font-weight: 600; }
.dshc-d-deps-waiting { color: var(--dsw-alias-label-secondary); }
.dshc-d-deps-ready { color: var(--dsw-alias-state-success-primary); }
.dshc-d-deps-pending { color: var(--dsw-alias-state-warn-primary); }
.dshc-d-deps-block { color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.dshc-d-debug summary { cursor: pointer; color: var(--dsw-alias-label-quaternary); font-size: 10px; }
.dshc-d-debug pre { margin: 4px 0 0; padding: 6px; border-radius: 6px; background: var(--dsw-alias-bg-layer-1); overflow-x: auto; font-size: 10px; }

.dshc-d-meta {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin: 12px 4px 0; font-size: 11px; color: var(--dsw-alias-label-tertiary);
}
.dshc-d-dot { color: var(--dsw-alias-label-quaternary); }
.dshc-d-jump {
  margin-left: auto; padding: 0; border: 0; background: transparent;
  font: inherit; font-size: 11.5px; color: var(--dsw-alias-brand-primary); cursor: pointer;
}
.dshc-d-jump:hover { text-decoration: underline; }
.dshc-d-jump:focus-visible { outline: 2px solid var(--dsw-alias-border-selected); outline-offset: 2px; border-radius: 4px; }

.dshc-d-body {
  flex: 1; min-height: 0; overflow-y: auto; box-sizing: border-box;
  padding: 12px 18px 16px;
  scrollbar-width: thin; scrollbar-color: var(--dsw-alias-scrollbar-bg-l1) transparent;
}
.dshc-d-body::-webkit-scrollbar { width: 6px; }
.dshc-d-body::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l1); border-radius: 3px; }
.dshc-d-feed { position: relative; }
.dshc-d-feed::before {
  content: ''; position: absolute; left: 10px; top: 4px; bottom: 12px;
  width: 1px; background: var(--dsw-alias-border-l3);
}
.dshc-d-day { padding: 0 0 10px 30px; font-size: 10.5px; color: var(--dsw-alias-label-quaternary); }
.dshc-d-ev {
  position: relative; display: grid; grid-template-columns: 20px minmax(0, 1fr);
  gap: 10px; padding-bottom: 16px;
}
.dshc-d-ev:last-child { padding-bottom: 2px; }
.dshc-d-rail { display: flex; justify-content: center; padding-top: 3px; }
.dshc-d-event-dot {
  width: 7px; height: 7px; border-radius: 50%; z-index: 1;
  background: var(--dsw-alias-label-secondary);
  box-shadow: 0 0 0 1px var(--dsw-alias-border-l3), 0 0 0 3px var(--dsw-alias-bg-layer-1);
}
.dshc-d-event-dot[data-kind='dispatch'] { background: var(--dsw-alias-brand-primary); }
.dshc-d-event-dot[data-kind='session_stop'] { background: var(--dsw-alias-label-secondary); }
.dshc-d-event-dot[data-kind='report'],
.dshc-d-event-dot[data-kind='acceptance'],
.dshc-d-event-dot[data-kind='accept'] { background: var(--dsw-alias-state-success-primary); }
.dshc-d-event-dot[data-kind='rework'] { background: var(--dsw-alias-state-error-primary); }

.dshc-d-ev-main { min-width: 0; }
.dshc-d-ev-meta {
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  font-size: 10.5px; color: var(--dsw-alias-label-tertiary);
}
.dshc-d-ev-meta time { font-family: monospace; font-size: 10px; color: var(--dsw-alias-label-quaternary); }
.dshc-d-ev-kind {
  line-height: 16px; padding: 0 6px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary); font-size: 9.5px;
}
.dshc-d-ev-ok { font-size: 10px; color: var(--dsw-alias-state-success-primary); }
.dshc-d-ev-ok[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary); }
.dshc-d-ev-text {
  margin: 4px 0 0; font-size: 12.5px; line-height: 1.65;
  color: var(--dsw-alias-label-primary); overflow-wrap: anywhere;
}
/* 「结论」卡（commander_task_report 的 summary）：深蓝强调，避免与证据勾的绿色重复。 */
.dshc-d-conclusion {
  position: relative; margin-top: 8px; padding: 9px 12px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-left: 3px solid var(--dshc-conclusion-accent, #5686fe);
  border-radius: 10px;
  background:
    linear-gradient(180deg, rgba(86, 134, 254, .10), rgba(86, 134, 254, 0) 64%),
    var(--dsw-alias-bg-layer-2);
}
.dshc-d-conclusion-head { display: flex; align-items: center; gap: 7px; }
.dshc-d-conclusion-pill {
  display: inline-flex; align-items: center; padding: 1px 6px; border-radius: 5px;
  background: var(--dshc-conclusion-accent, #5686fe); color: #fff;
  font-size: 10px; font-weight: 600; line-height: 15px;
}
.dshc-d-conclusion-text {
  margin: 5px 0 0; font-size: 12.5px; line-height: 1.72;
  color: var(--dsw-alias-label-primary); white-space: pre-wrap; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden;
}
.dshc-d-conclusion[data-collapsible='true'] .dshc-d-conclusion-text[data-expanded='false'] {
  -webkit-mask-image: linear-gradient(180deg, #000 72%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 72%, transparent 100%);
}
.dshc-d-conclusion-text[data-expanded='true'] { -webkit-line-clamp: unset; display: block; }
.dshc-d-conclusion-foot { display: flex; justify-content: flex-end; margin-top: 7px; }
.dshc-d-conclusion-toggle {
  display: inline-flex; align-items: center; gap: 3px;
  margin: 0; padding: 0; border: 0; background: none; cursor: pointer;
  font-family: inherit; font-size: 10.5px; color: var(--dsw-alias-label-secondary);
}
.dshc-d-conclusion-toggle:hover { color: var(--dsw-alias-label-primary); }
.dshc-d-conclusion-toggle svg { transition: transform .2s cubic-bezier(.4,0,.2,1); }
.dshc-d-conclusion-toggle[aria-expanded='true'] svg { transform: rotate(180deg); }
.dshc-d-edit {
  margin: 5px 0 0; padding: 5px 8px; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2); font-family: monospace; font-size: 10.5px;
  color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere;
}

.dshc-d-receipt {
  display: flex; flex-direction: column; gap: 6px; margin-top: 8px;
  padding: 10px 11px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px; background: var(--dsw-alias-bg-layer-2);
}
.dshc-d-receipt-top { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dshc-d-jev {
  padding: 1px 6px; border-radius: 5px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-state-warn-primary);
  font-size: 10.5px; font-weight: 600;
}
.dshc-d-receipt-target { margin: 0; font-size: 12.5px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dshc-d-receipt-sub { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.dshc-d-candidates summary {
  display: flex; align-items: center; gap: 6px; width: fit-content;
  font-size: 10.5px; color: var(--dsw-alias-label-tertiary); cursor: pointer;
}
.dshc-d-candidates summary:hover { color: var(--dsw-alias-label-secondary); }
.dshc-d-candidates summary svg, .dshc-d-evfull summary svg { transition: transform .2s cubic-bezier(.4,0,.2,1); }
.dshc-d-candidates[open] summary svg, .dshc-d-evfull[open] summary svg { transform: rotate(180deg); }
.dshc-d-candidates ul { list-style: none; margin: 7px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.dshc-d-candidates li {
  display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
  font-size: 11px; color: var(--dsw-alias-label-secondary);
}
.dshc-d-pct { flex: none; font-family: monospace; font-size: 10px; color: var(--dsw-alias-label-tertiary); }

.dshc-d-checks {
  margin-top: 8px; padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
}
.dshc-d-check { display: flex; gap: 10px; padding: 10px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dshc-d-check:first-child { border-top: 0; }
.dshc-d-check-dot {
  display: flex; align-items: center; justify-content: center; flex: none;
  width: 16px; height: 16px; margin-top: 2px; border-radius: 50%;
  border: 1px solid var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary); font-size: 10px; font-weight: 700; line-height: 1;
}
.dshc-d-check-dot[data-state='insufficient'] { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.dshc-d-check-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.dshc-d-check-text { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dshc-d-evline, .dshc-d-evfull > summary {
  display: flex; align-items: baseline; gap: 6px; min-width: 0; margin: 0;
  font-size: 10.5px; color: var(--dsw-alias-label-tertiary);
}
.dshc-d-evfull > summary { cursor: pointer; }
.dshc-d-evfull > summary:hover { color: var(--dsw-alias-label-secondary); }
.dshc-d-evfull > summary svg { flex: none; align-self: center; margin-left: auto; color: var(--dsw-alias-label-quaternary); }
.dshc-d-evtag {
  flex: none; padding: 0 5px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 4px; background: var(--dsw-alias-bg-layer-1); font-size: 9.5px;
}
.dshc-d-evsum {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: monospace; font-size: 10px;
}
.dshc-d-evfull dl {
  display: grid; grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 8px; margin: 7px 0 2px; font-size: 10.5px;
}
.dshc-d-evfull dt { color: var(--dsw-alias-label-quaternary); }
.dshc-d-evfull dd {
  margin: 0; color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap; overflow-wrap: anywhere; font-family: monospace; font-size: 10px;
}

.dshc-d-session {
  display: flex; align-items: center; gap: 9px; width: 100%; box-sizing: border-box;
  margin-top: 8px; padding: 9px 10px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px; background: var(--dsw-alias-bg-layer-2); color: inherit; text-align: left;
}
button.dshc-d-session { cursor: pointer; font: inherit; }
button.dshc-d-session:hover { border-color: var(--dsw-alias-border-l3); }
.dshc-d-avatar {
  display: flex; align-items: center; justify-content: center; flex: none;
  width: 24px; height: 24px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px; background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-brand-primary); font-size: 11px; font-weight: 600;
}
.dshc-d-session-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dshc-d-session-title { font-size: 12px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshc-d-session-sub { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshc-d-chip {
  flex: none; padding: 1px 6px; border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px; font-size: 9.5px; color: var(--dsw-alias-label-tertiary);
}
.dshc-d-chip[data-status='running'] { color: var(--dsw-alias-state-success-primary); }
.dshc-d-chip[data-status='missing'] { color: var(--dsw-alias-state-error-primary); }
.dshc-d-session-chev { flex: none; color: var(--dsw-alias-label-quaternary); }

.dshc-d-now { align-items: flex-start; }
.dshc-d-now-dot {
  width: 9px; height: 9px; margin-top: 3px; border: 2px solid var(--dsw-alias-state-success-primary);
  border-radius: 50%; background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 0 0 3px var(--dsw-alias-bg-layer-1);
}
.dshc-d-now-main strong { display: block; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dshc-d-now-main p { margin: 2px 0 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); }

.dshc-d-foot {
  flex: none; display: flex; flex-direction: column; gap: 8px;
  padding: 12px 18px 14px; border-top: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.dshc-d-foot-main { display: flex; align-items: center; gap: 12px; }
.dshc-d-foot-meta { flex: 1; min-width: 0; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.dshc-d-foot-actions { display: flex; gap: 8px; flex: none; }
.dshc-d-foot-hint { margin: 0; font-size: 10px; color: var(--dsw-alias-label-quaternary); }
.dshc-d-confirm { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px; color: var(--dsw-alias-label-primary); }
.dshc-d-rework { display: flex; flex-direction: column; gap: 6px; }
.dshc-d-rework .dshc-field-textarea { min-height: 64px; }
.dshc-d-rework-actions { display: flex; gap: 8px; }

@media (max-width: 720px) {
  .dshc-board-columns { padding: 10px 12px 16px; }
  .dshc-board-column { flex-basis: 240px; }
  .dshc-board-drawer { width: 100%; }
}

/* --------------------------------------- M3 approval card & badges */
.dshc-ball-badge[data-kind='blocked'] { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-on-color); }
.dshc-badge-hints {
  flex: none; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 6px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
}
.dshc-badge-summary { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.dshc-badge-chip {
  padding: 1px 8px; border-radius: 999px; font-family: inherit; font-size: 10.5px; cursor: pointer;
  color: var(--dsw-alias-label-secondary); background: transparent;
  border: 1px solid var(--dsw-alias-border-l2);
}
.dshc-badge-chip:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshc-badge-chip[data-kind='approval'] { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dshc-badge-chip[data-kind='review'] { color: var(--dsw-alias-state-warn-primary); }
.dshc-badge-chip[data-kind='blocked'] { color: var(--dsw-alias-state-error-primary); }
.dshc-approval-card {
  display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-brand-primary);
  pointer-events: auto;
}
.dshc-approval-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshc-approval-title { font-size: 12.5px; font-weight: 600; }
.dshc-approval-counter { display: flex; align-items: center; gap: 4px; margin-left: auto; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.dshc-approval-meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dshc-approval-summary { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dshc-approval-task { font-size: 13px; font-weight: 600; line-height: 1.45; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dshc-approval-cmd {
  padding: 7px 8px; border-radius: 7px; background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  font-family: var(--dsh-font-family-code); font-size: 11px; line-height: 1.5;
  color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere;
}
.dshc-approval-cmd code { font-family: inherit; }
.dshc-approval-error { font-size: 11.5px; color: var(--dsw-alias-state-error-primary); }
.dshc-approval-actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; align-items: center; }
.dshc-approval-spacer { flex: 1; min-width: 4px; }
/* ------------------------------------------------------- question card */
.dshc-question-card {
  display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-selected);
  pointer-events: auto;
}
.dshc-question-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshc-question-title { font-size: 12.5px; font-weight: 600; }
.dshc-question-counter, .dshc-question-queue { display: flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.dshc-question-queue { margin-left: auto; }
.dshc-question-body { display: flex; flex-direction: column; gap: 6px; }
.dshc-question-label { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.dshc-question-text { font-size: 13px; font-weight: 600; line-height: 1.5; color: var(--dsw-alias-label-primary); white-space: pre-wrap; overflow-wrap: anywhere; }
.dshc-question-detail {
  max-height: 96px; overflow: auto; padding: 7px 8px; border-radius: 7px;
  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1);
  font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; overflow-wrap: anywhere;
}
.dshc-question-options { display: flex; flex-direction: column; gap: 4px; }
.dshc-question-option {
  display: flex; flex-direction: column; gap: 2px; text-align: left; cursor: pointer;
  padding: 7px 9px; border-radius: 8px; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2);
}
.dshc-question-option[data-selected='true'] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-hover); }
.dshc-question-option:disabled { cursor: default; opacity: .55; }
.dshc-question-option-label { font-weight: 500; }
.dshc-question-option-desc { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dshc-question-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.dshc-question-custom { min-height: 46px; }
.dshc-question-error { font-size: 11.5px; color: var(--dsw-alias-state-error-primary); }
.dshc-question-actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; align-items: center; }

.dshc-decision {
  border: 1px solid var(--dsw-alias-border-l1);
  border-left: 2px solid var(--dsw-alias-brand-primary);
  border-radius: 8px; background: var(--dsw-alias-bg-layer-2);
  overflow: hidden;
}
.dshc-decision-head {
  display: flex; align-items: center; gap: 7px; padding: 7px 9px;
  cursor: pointer; list-style: none; font-size: 11.5px;
}
.dshc-decision-head::-webkit-details-marker { display: none; }
.dshc-decision-head::after {
  content: "›"; margin-left: 2px; color: var(--dsw-alias-label-quaternary);
  font-size: 13px; line-height: 1; transition: transform .16s cubic-bezier(.4,0,.2,1);
}
.dshc-decision[open] .dshc-decision-head::after { transform: rotate(90deg); }
.dshc-decision-icon {
  display: inline-grid; place-items: center; width: 15px; height: 15px; flex: none;
  border-radius: 50%; background: var(--dsw-alias-state-success-secondary);
  color: var(--dsw-alias-state-success-primary); font-size: 9px; font-weight: 700;
}
.dshc-decision-title { font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dshc-decision-action { color: var(--dsw-alias-label-primary); }
.dshc-decision-target { color: var(--dsw-alias-label-tertiary); font-size: 10.5px; }
.dshc-decision-time { margin-left: auto; color: var(--dsw-alias-label-quaternary); font-size: 9.5px; }
.dshc-decision-raw {
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base); padding: 7px 9px;
}
.dshc-decision-raw-caption { margin-bottom: 4px; font-size: 9px; color: var(--dsw-alias-label-quaternary); }
.dshc-decision-raw pre {
  margin: 0; font-family: var(--dsh-font-family-code); font-size: 9.5px; line-height: 1.6;
  color: var(--dsw-alias-label-tertiary); white-space: pre-wrap; overflow-wrap: anywhere;
}
.dshc-system-card {
  display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2); border-left: 2px solid var(--dsw-alias-brand-primary);
}
.dshc-system-card[data-kind='board-edit'] { border-left-color: var(--dsw-alias-state-warn-primary); }
.dshc-system-card-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dshc-system-card-title { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dshc-system-card-meta { font-size: 10px; color: var(--dsw-alias-label-quaternary); }
.dshc-system-card-body { font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dsw-alias-label-primary); }
.dshc-system-card-body--markdown { white-space: normal; overflow-x: auto; }
/* ------------------------------------ settings: binding session picker */
.dshc-binding-picker {
  display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 8px;
  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1);
}
.dshc-binding-picker .dshc-session-list { max-height: 196px; }
.dshc-session-row[data-bound='true'] { border-color: var(--dsw-alias-state-success-primary); }
.dshc-session-row[data-bound='true'] .dshc-session-meta { color: var(--dsw-alias-state-success-primary); }

/* --------------------------------------- C panel: status bar / sheet */
.dshc-panel-head-fill { flex: 1; min-width: 0; }

.dshc-statusbar {
  flex: none; display: flex; align-items: center; gap: 6px;
  width: 100%; height: 32px; box-sizing: border-box;
  padding: 0 9px 0 12px; border: 0; border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 11px; text-align: left; cursor: pointer;
}
.dshc-statusbar:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshc-statusbar:focus-visible { outline: 2px solid var(--dsw-alias-border-selected); outline-offset: -2px; }
.dshc-status-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-quaternary); }
.dshc-status-dot[data-status='bound'] { background: var(--dsw-alias-state-success-primary); }
.dshc-status-dot[data-status='broken'] { background: var(--dsw-alias-state-error-primary); }
.dshc-status-dot[data-status='unknown'] { background: var(--dsw-alias-state-warn-primary); }
.dshc-status-session {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11.5px; color: var(--dsw-alias-label-primary);
}
.dshc-status-chips { flex: 0 1 auto; min-width: 0; display: flex; align-items: center; gap: 4px; overflow: hidden; }
.dshc-status-chips .dshc-chip { flex: none; padding: 0 6px; font-size: 9.5px; line-height: 17px; }
.dshc-status-conn { flex: none; font-size: 9.5px; color: var(--dsw-alias-label-tertiary); padding-left: 2px; }
.dshc-status-conn[data-conn='live'] { color: var(--dsw-alias-state-success-primary); }
.dshc-status-conn[data-conn='polling'] { color: var(--dsw-alias-state-warn-primary); }
.dshc-status-conn[data-conn='offline'] { color: var(--dsw-alias-state-error-primary); }
.dshc-status-chevron { flex: none; display: flex; color: var(--dsw-alias-label-quaternary); }

.dshc-status-layer { position: absolute; inset: 0; z-index: 30; pointer-events: none; }
.dshc-status-scrim { position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1); pointer-events: auto; }
.dshc-status-pop {
  position: absolute; z-index: 1; top: 46px; left: 8px; right: 8px;
  max-height: calc(100% - 56px); overflow-y: auto; padding: 12px; box-sizing: border-box;
  border-radius: 12px; background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: 0 16px 44px var(--dsw-alias-bg-mask-2); pointer-events: auto;
}
.dshc-status-pop-head { display: flex; align-items: center; gap: 8px; }
.dshc-status-pop-title { font-size: 13px; font-weight: 600; }
.dshc-status-pop-sub { flex: 1; min-width: 0; font-size: 9.5px; color: var(--dsw-alias-label-tertiary); }
.dshc-status-block { padding-top: 10px; margin-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dshc-status-label { margin-bottom: 6px; font-size: 10px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dshc-status-kv { display: grid; grid-template-columns: 60px minmax(0, 1fr); gap: 6px 9px; margin: 0; font-size: 11px; }
.dshc-status-kv dt { color: var(--dsw-alias-label-tertiary); }
.dshc-status-kv dd { margin: 0; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dshc-status-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 9px; }
.dshc-status-hint { font-size: 10px; color: var(--dsw-alias-label-quaternary); }
.dshc-status-tasks { display: flex; flex-direction: column; gap: 4px; }
.dshc-status-task {
  display: flex; align-items: center; gap: 8px; padding: 4px 7px; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
}
.dshc-status-task-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dshc-status-conn-line { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dshc-status-conn-line[data-conn='live'] { color: var(--dsw-alias-state-success-primary); }
.dshc-status-conn-line[data-conn='polling'] { color: var(--dsw-alias-state-warn-primary); }

.dshc-composer { position: relative; }
.dshc-pending-fab {
  position: absolute; right: 10px; bottom: calc(100% + 8px); z-index: 5;
  display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 9px;
  border-radius: 8px; border: 1px solid var(--dsw-alias-state-warn-primary);
  background: var(--dsw-alias-state-warn-secondary); color: var(--dsw-alias-state-warn-primary);
  font-family: inherit; font-size: 10.5px; font-weight: 600; cursor: pointer;
  box-shadow: 0 8px 22px var(--dsw-alias-bg-mask-1);
}
.dshc-pending-fab:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshc-pending-fab:focus-visible { outline: 2px solid var(--dsw-alias-border-selected); outline-offset: 1px; }

.dshc-sheet-layer { position: fixed; inset: 0; z-index: 1200; pointer-events: none; }
/* 从下往上的抽屉：整窗底部弹出、内容限宽，与 DSH 官方提问/审批抽屉同形。 */

.dshc-sheet-scrim {
  position: absolute; left: 0; right: 0; top: 76px; bottom: 0;
  background: var(--dsw-alias-bg-mask-1); pointer-events: auto;
}
.dshc-sheet {
  position: absolute; z-index: 1; left: 50%; right: auto; bottom: 0; transform: translateX(-50%);
  width: min(680px, calc(100% - 24px)); max-height: min(80vh, 640px);
  display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-layer-1);
  border-top: 1px solid var(--dsw-alias-border-l2);
  border-radius: 16px 16px 0 0;
  box-shadow: 0 -18px 44px var(--dsw-alias-bg-mask-2);
  pointer-events: auto;
}
.dshc-sheet-grab { width: 34px; height: 4px; border-radius: 2px; background: var(--dsw-alias-border-l2); margin: 6px auto 0; flex: none; }
.dshc-sheet-head {
  flex: none; display: flex; align-items: center; gap: 7px; padding: 6px 10px 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
}
.dshc-sheet-title { display: flex; align-items: center; gap: 5px; font-size: 12.5px; font-weight: 600; }
.dshc-sheet-count {
  display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 4px;
  border-radius: 8px; background: var(--dsw-alias-state-warn-secondary);
  color: var(--dsw-alias-state-warn-primary); font-size: 9.5px; font-weight: 700;
}
.dshc-sheet-sub { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; color: var(--dsw-alias-label-quaternary); }
.dshc-sheet-body {
  flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px 12px;
  display: flex; flex-direction: column; gap: 9px;
  scrollbar-width: thin; scrollbar-color: var(--dsh-scrollbar-thumb) transparent;
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 14px), transparent);
  mask-image: linear-gradient(to bottom, #000 calc(100% - 14px), transparent);
}
.dshc-sheet-body > * { flex: 0 0 auto; }
.dshc-sheet .dshc-dispatch-sent { margin: 0 0 8px; }
.dshc-sheet-foot {
  flex: none; display: flex; align-items: center; gap: 6px; padding: 7px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  font-size: 9px; color: var(--dsw-alias-label-quaternary);
}
.dshc-sheet-foot-fill { flex: 1; }
.dshc-sheet-empty { padding: 18px 8px; text-align: center; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.dshc-dispatch-sent--strip { margin: 0 14px 8px; }

@keyframes dshc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) {
  .dshc-ball, .dshc-button, .dshc-input { transition: none; }
  .dshc-ball:hover, .dshc-ball:active { transform: none; }
  .dshc-ball[data-busy='true']::after { animation: none; }
}
@media (max-width: 560px) {
  .dshc-panel { left: 12px; right: 12px; width: auto; bottom: 84px; max-height: calc(100vh - 100px); height: min(660px, calc(100vh - 100px)); }
  .dshc-grid { grid-template-columns: minmax(0, 1fr); }
}

/* ------------------------------------------------------------------ M5 多轮详情 */
.dshc-board-round {
  padding: 0 6px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary);
  font-size: 9.5px; line-height: 16px; white-space: nowrap;
}
.dshc-board-round[data-current='true'] {
  background: var(--dsw-alias-brand-primary); color: #fff; font-weight: 600;
}
.dshc-d-head { position: relative; }
.dshc-d-head-actions { position: absolute; top: 10px; right: 12px; z-index: 2; margin: 0; }
.dshc-d-title { margin-top: 18px; padding-right: 64px; font-size: 19px; }
.dshc-d-round-chip {
  display: inline-flex; align-items: center; height: 22px; padding: 0 9px;
  border-radius: 999px; background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 500;
}
.dshc-d-workspace em { margin-left: 4px; padding: 0 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-brand-primary); font-size: 9.5px; font-style: normal; }
.dshc-d-rounds {
  display: flex; align-items: stretch; gap: 8px; margin: 12px 0 0; padding: 0 0 2px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dshc-d-round-tab {
  flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;
  padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  text-align: left; cursor: pointer; font: inherit;
}
.dshc-d-round-tab:hover { border-color: var(--dsw-alias-border-l2); }
.dshc-d-round-tab[data-current='true'] { border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, var(--dsw-alias-bg-layer-1)); }
.dshc-d-round-tab-line { display: flex; align-items: center; gap: 6px; }
.dshc-d-round-tab-line b { font-size: 11.5px; color: var(--dsw-alias-label-primary); }
.dshc-d-round-tab-line em {
  padding: 0 5px; border-radius: 4px; background: var(--dsw-alias-brand-primary);
  color: #fff; font-size: 9px; font-style: normal; line-height: 15px;
}
.dshc-d-round-tab-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.dshc-d-rounds-body { display: flex; flex-direction: column; }
.dshc-d-round { padding-top: 12px; }
.dshc-d-round + .dshc-d-round { margin-top: 4px; }
.dshc-d-round-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 0 7px; border-top: 1px solid var(--dsw-alias-border-l1);
}
.dshc-d-round[data-current='true'] .dshc-d-round-head { border-top-color: var(--dsw-alias-border-l2); }
.dshc-d-round-head-main { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.dshc-d-round-index { color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 700; }
.dshc-d-round-target { color: var(--dsw-alias-label-secondary); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshc-d-round-current { padding: 0 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-brand-primary); font-size: 9.5px; }
.dshc-d-round-head-right { display: flex; align-items: center; gap: 7px; flex: none; color: var(--dsw-alias-label-tertiary); font-size: 10px; }
.dshc-d-round-time { font-family: monospace; font-size: 10px; }
.dshc-d-round-acc { padding: 0 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-state-success-primary); font-size: 9.5px; font-weight: 600; }
.dshc-d-link { padding: 0; border: 0; background: none; color: var(--dsw-alias-brand-primary); font: inherit; font-size: 10.5px; cursor: pointer; }
.dshc-d-link:hover { text-decoration: underline; }
.dshc-d-round-summary { margin: 0 0 2px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshc-d-round-events { position: relative; margin-left: 4px; padding-left: 18px; }
/* 轮次时间线竖线：放在独立 pseudo 上，避免 border-l1 在深色主题里过淡到看不见。 */
.dshc-d-round-events::before {
  content: ""; position: absolute; left: 0; top: 2px; bottom: 2px; width: 1px;
  background: var(--dsw-alias-border-l2); pointer-events: none;
}
.dshc-d-round-ev { position: relative; padding: 10px 0 2px; }
.dshc-d-round-rail { position: absolute; left: -23px; top: 16px; width: 9px; height: 9px; display: grid; place-items: center; }
.dshc-d-round-rail span {
  width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary);
  box-shadow: 0 0 0 2px var(--dsw-alias-bg-layer-1);
}
.dshc-d-round-ev[data-kind='user'] .dshc-d-round-rail span { background: var(--dsw-alias-state-warn-primary); }
.dshc-d-round-ev[data-kind='dispatch'] .dshc-d-round-rail span { background: var(--dsw-alias-brand-primary); }
.dshc-d-round-ev[data-kind='session'] .dshc-d-round-rail span { background: var(--dsw-alias-label-secondary); }
.dshc-d-round-ev[data-kind='report'] .dshc-d-round-rail span,
.dshc-d-round-ev[data-kind='accept'] .dshc-d-round-rail span { background: var(--dsw-alias-state-success-primary); }
.dshc-d-round-ev-main { min-width: 0; }
.dshc-d-round-ev-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; color: var(--dsw-alias-label-tertiary); font-size: 10px; }
.dshc-d-round-ev-meta time { font-family: monospace; font-size: 10px; color: var(--dsw-alias-label-quaternary); }
.dshc-d-round-ev-kind { color: var(--dsw-alias-label-secondary); font-weight: 600; font-size: 10.5px; }
.dshc-d-round-source { padding: 0 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); font-size: 9px; }
.dshc-d-round-ev .dshc-d-round-target { margin-left: auto; }
.dshc-d-user-quote {
  margin: 6px 0 0; padding: 9px 12px 9px 30px; position: relative;
  border: 1px solid var(--dsw-alias-border-l1); border-left: 2px solid var(--dsw-alias-state-warn-primary);
  border-radius: 0 9px 9px 0; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere;
}
.dshc-d-user-quote::before { content: '“'; position: absolute; left: 9px; top: 2px; color: var(--dsw-alias-state-warn-primary); font-family: Georgia, serif; font-size: 22px; line-height: 1; opacity: .8; }
.dshc-d-brief-card { margin-top: 6px; padding: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-2); }
.dshc-d-brief-head { display: flex; align-items: center; gap: 7px; color: var(--dsw-alias-label-tertiary); font-size: 10px; }
.dshc-d-brief-head b { color: var(--dsw-alias-label-secondary); font-size: 10.5px; }
.dshc-d-brief-head .dshc-d-link { margin-left: auto; }
.dshc-d-brief {
  position: relative; margin: 7px 0 0; padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1); border-left: 2px solid var(--dsw-alias-brand-primary);
  border-radius: 0 7px 7px 0; background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 11px; line-height: 1.7;
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 8em; overflow: hidden;
}
.dshc-d-brief[data-open='true'] { max-height: none; }
.dshc-d-brief:not([data-open='true'])::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 24px;
  background: linear-gradient(transparent, var(--dsw-alias-bg-layer-1)); pointer-events: none;
}
.dshc-d-brief-empty { margin: 7px 0 0; color: var(--dsw-alias-label-quaternary); font-size: 10.5px; }
.dshc-d-brief-card .dshc-d-receipt { margin-top: 7px; }
.dshc-d-round-sessions { display: flex; flex-direction: column; gap: 0; }
.dshc-d-round-ok { color: var(--dsw-alias-state-success-primary); font-size: 9.5px; font-weight: 600; }
.dshc-d-round-text { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
.dshc-d-round-ev .dshc-d-conclusion { margin-top: 6px; }
.dshc-d-round-ev .dshc-d-check { margin-top: 6px; }
.dshc-d-pending-continue {
  margin: 12px 0 0; padding: 9px 11px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.dshc-d-pending-head { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 10.5px; }
.dshc-d-pending-head time { color: var(--dsw-alias-label-quaternary); font-family: monospace; font-size: 10px; }
.dshc-d-pending-continue p { margin: 4px 0 0; color: var(--dsw-alias-label-primary); font-size: 11.5px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.dshc-d-now { display: flex; align-items: flex-start; gap: 9px; margin: 14px 0 0; padding: 11px 0 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dshc-d-now-dot { width: 7px; height: 7px; margin-top: 5px; border-radius: 50%; background: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); }
.dshc-d-now-main strong { display: block; font-size: 11.5px; color: var(--dsw-alias-label-primary); }
.dshc-d-now-main p { margin: 1px 0 0; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.dshc-d-rework-head { display: flex; align-items: baseline; gap: 8px; }
.dshc-d-rework-head b { font-size: 11.5px; color: var(--dsw-alias-label-primary); }
.dshc-d-rework-head span { color: var(--dsw-alias-label-tertiary); font-size: 10px; }


/* 方案 A：报告级「依据与材料」（链接 / 文档 / 图片） */
.dshc-d-conclusion-sources {
  display: flex; align-items: center; gap: 8px;
  margin-top: 7px; padding-top: 6px;
  border-top: 1px dashed var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-tertiary); font-size: 10px;
}
.dshc-d-conclusion-sources > span { flex: 1; min-width: 0; }
.dshc-d-round-report-badges { display: inline-flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.dshc-d-round-mat, .dshc-d-mat-badge {
  display: inline-flex; align-items: center; gap: 3px;
  padding: 1px 5px; border-radius: 5px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary);
  font-size: 9.5px; white-space: nowrap;
}
.dshc-d-mat { margin-top: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; scroll-margin-top: 12px; }
.dshc-d-mat-head {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
  padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dshc-d-mat-title { color: var(--dsw-alias-label-primary); font-size: 10.5px; font-weight: 700; letter-spacing: .02em; }
.dshc-d-mat-count {
  min-width: 17px; height: 17px; padding: 0 5px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
  color: var(--dsw-alias-brand-primary); font-size: 9.5px; font-weight: 700;
}
.dshc-d-mat-sum { color: var(--dsw-alias-label-tertiary); font-size: 9.5px; }
.dshc-d-mat-toggle { margin-left: auto; font-size: 10px; }
.dshc-d-mat-body { padding: 8px 10px 9px; }
.dshc-d-mat-gallery { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.dshc-d-mat-gallery[data-count='1'] { grid-template-columns: 1fr; }
.dshc-d-mat-shot {
  min-width: 0; padding: 0; overflow: hidden; text-align: left; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); color: inherit;
}
.dshc-d-mat-shot:hover { border-color: var(--dsw-alias-border-l2); }
.dshc-d-mat-shot-img { position: relative; display: block; aspect-ratio: 16 / 10; overflow: hidden; background: #0b0c0e; }
.dshc-d-mat-shot-img img { width: 100%; height: 100%; display: block; object-fit: cover; object-position: top center; }
.dshc-d-mat-shot-zoom {
  position: absolute; right: 5px; bottom: 5px; width: 20px; height: 20px;
  display: grid; place-items: center; border-radius: 5px;
  background: rgba(10, 12, 16, .7); color: #fff; opacity: 0;
  transition: opacity .15s ease;
}
.dshc-d-mat-shot:hover .dshc-d-mat-shot-zoom { opacity: 1; }
.dshc-d-mat-shot-cap { display: block; padding: 5px 7px 6px; }
.dshc-d-mat-shot-cap b { display: block; color: var(--dsw-alias-label-primary); font-size: 10px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshc-d-mat-shot-cap small { display: block; margin-top: 1px; color: var(--dsw-alias-label-tertiary); font-size: 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshc-d-mat-list { margin: 7px 0 0; padding: 0; list-style: none; border-top: 1px solid var(--dsw-alias-border-l1); }
.dshc-d-mat-list li { border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshc-d-mat-row {
  width: 100%; display: flex; align-items: center; gap: 8px;
  padding: 6px 2px; border: 0; background: transparent; color: inherit;
  text-align: left; cursor: pointer;
}
.dshc-d-mat-row:hover { background: var(--dsw-alias-bg-layer-1); }
.dshc-d-mat-icon {
  width: 23px; height: 23px; flex: none; display: grid; place-items: center;
  border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
}
.dshc-d-mat-icon[data-kind='file'] { color: var(--dsw-alias-state-success-primary); }
.dshc-d-mat-icon[data-kind='image'] { color: var(--dsw-alias-brand-primary); }
.dshc-d-mat-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0; }
.dshc-d-mat-main b { color: var(--dsw-alias-label-primary); font-size: 10.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshc-d-mat-main small { color: var(--dsw-alias-label-tertiary); font-size: 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshc-d-mat-trail { flex: none; display: grid; place-items: center; color: var(--dsw-alias-label-quaternary); }
.dshc-d-mat-row:hover .dshc-d-mat-trail { color: var(--dsw-alias-brand-primary); }
.dshc-d-mat-more {
  width: 100%; height: 26px; margin-top: 5px;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  border: 1px solid transparent; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-tertiary); font-size: 9.5px; cursor: pointer;
}
.dshc-d-mat-more:hover { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }
.dshc-d-mat-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.dshc-d-mat-chip {
  display: inline-flex; align-items: center; gap: 3px;
  height: 20px; padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 9.5px; cursor: pointer;
}
.dshc-d-mat-chip:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dshc-d-mat-chip-more { display: inline-flex; align-items: center; padding: 0 4px; color: var(--dsw-alias-label-tertiary); font-size: 9.5px; }

/* 图片灯箱 */
.dshc-d-lb { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 18px; }
.dshc-d-lb-scrim { position: absolute; inset: 0; border: 0; background: rgba(0, 0, 0, .66); backdrop-filter: blur(3px); cursor: pointer; }
.dshc-d-lb-card { position: relative; z-index: 1; width: min(560px, 100%); max-height: calc(100vh - 36px); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: 16px; background: var(--dsw-alias-bg-layer-1); box-shadow: 0 28px 80px rgba(0, 0, 0, .55); }
.dshc-d-lb-head { display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshc-d-lb-count { padding: 1px 6px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); font-size: 9.5px; }
.dshc-d-lb-kicker { color: var(--dsw-alias-label-secondary); font-size: 10.5px; font-weight: 600; }
.dshc-d-lb-close { margin-left: auto; width: 24px; height: 24px; display: grid; place-items: center; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.dshc-d-lb-close:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dshc-d-lb-stage { position: relative; min-height: 0; display: grid; place-items: center; padding: 10px 34px; background: #0b0c0e; }
.dshc-d-lb-stage img { max-width: 100%; max-height: 52vh; display: block; border-radius: 6px; object-fit: contain; }
.dshc-d-lb-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 25px; height: 25px; display: grid; place-items: center; border: 1px solid rgba(255, 255, 255, .18); border-radius: 50%; background: rgba(20, 22, 27, .72); color: #fff; cursor: pointer; }
.dshc-d-lb-nav:hover { background: rgba(20, 22, 27, .95); }
.dshc-d-lb-nav.prev { left: 7px; }
.dshc-d-lb-nav.next { right: 7px; }
.dshc-d-lb-foot { display: flex; align-items: flex-end; gap: 10px; padding: 10px 12px 12px; }
.dshc-d-lb-copy { flex: 1; min-width: 0; }
.dshc-d-lb-copy b { display: block; color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshc-d-lb-copy small { display: block; margin-top: 1px; color: var(--dsw-alias-label-tertiary); font-size: 9.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshc-d-lb-actions { display: flex; gap: 6px; flex: none; }
.dshc-d-lb-btn { display: inline-flex; align-items: center; gap: 4px; height: 27px; padding: 0 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 10.5px; cursor: pointer; }
.dshc-d-lb-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dshc-d-lb-btn.primary { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-brand-primary); color: #fff; }

/* 本地文件动作单（先提供复制路径；系统打开后续接） */
.dshc-d-fs { position: fixed; inset: 0; z-index: 80; display: flex; align-items: flex-end; justify-content: center; }
.dshc-d-fs-scrim { position: absolute; inset: 0; border: 0; background: rgba(0, 0, 0, .52); cursor: pointer; }
.dshc-d-fs-card { position: relative; z-index: 1; width: min(440px, 100%); padding: 8px 16px 20px; border: 1px solid var(--dsw-alias-border-l2); border-bottom: 0; border-radius: 18px 18px 0 0; background: var(--dsw-alias-bg-layer-1); box-shadow: 0 -24px 70px rgba(0, 0, 0, .48); }
.dshc-d-fs-grip { display: block; width: 34px; height: 4px; margin: 0 auto 10px; border-radius: 999px; background: var(--dsw-alias-border-l2); }
.dshc-d-fs-head { display: flex; align-items: center; gap: 9px; }
.dshc-d-fs-main { flex: 1; min-width: 0; }
.dshc-d-fs-main b { display: block; color: var(--dsw-alias-label-primary); font-size: 12.5px; font-weight: 600; overflow-wrap: anywhere; }
.dshc-d-fs-main small { display: block; margin-top: 1px; color: var(--dsw-alias-label-tertiary); font-size: 9.5px; }
.dshc-d-fs-path { margin-top: 10px; padding: 7px 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-family: monospace; font-size: 9.5px; line-height: 1.5; overflow-wrap: anywhere; }
.dshc-d-fs-actions { display: flex; gap: 6px; margin-top: 10px; }
.dshc-d-fs-btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 30px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 10.5px; cursor: pointer; }
.dshc-d-fs-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dshc-d-fs-btn.primary { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-brand-primary); color: #fff; }
.dshc-d-fs-note { margin-top: 9px; color: var(--dsw-alias-label-tertiary); font-size: 9.5px; line-height: 1.5; }
@media (max-width: 720px) {
  .dshc-d-lb { padding: 12px; }
  .dshc-d-lb-foot { flex-wrap: wrap; align-items: flex-start; }
  .dshc-d-lb-actions { width: 100%; justify-content: flex-end; }
}

`
