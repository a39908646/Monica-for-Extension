import { PROMPT_BASE_STYLES } from "./prompt-styles";

/** 字段内生成器：字段内小图标 + 弹出面板，沿用保存提示那套配色与可访问性约定。 */
export const GENERATOR_STYLES = `${PROMPT_BASE_STYLES}
  :host { font: 1rem/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  .trigger {
    width: 26px; height: 26px; min-height: 0; padding: 0;
    display: grid; place-items: center;
    border: 1px solid var(--monica-outline); border-radius: 6px;
    color: var(--monica-muted); background: var(--monica-surface);
  }
  .trigger:hover { color: var(--monica-text); background: var(--monica-surface-high); }
  .trigger svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .panel {
    pointer-events: auto;
    position: fixed; inset: auto;
    width: min(400px, calc(100vw - 16px));
    max-height: min(560px, calc(100vh - 16px));
    overflow: auto;
    display: grid; gap: 12px;
    padding: 16px;
    border: 1px solid var(--monica-outline); border-radius: 14px;
    color: var(--monica-text); background: var(--monica-surface);
    animation: monica-prompt-in 180ms cubic-bezier(.2,.8,.2,1);
  }
  .head { display: flex; align-items: center; gap: 8px; }
  .head strong { flex: 1; font-size: 1.0625rem; }
  .head .icon-button { width: 40px; min-height: 40px; }
  .result { display: flex; align-items: center; gap: 10px; padding: 12px; border-radius: 10px; background: var(--monica-surface-container); }
  .result code { flex: 1; font: 600 1.1875rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  .result .icon-button { width: 38px; min-height: 38px; }
  .result svg, .icon-button svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .entropy { margin: 0; color: var(--monica-muted); font-size: 0.8125rem; }
  .modes { display: flex; flex-wrap: wrap; gap: 6px; }
  .modes button { min-height: 40px; padding: 8px 14px; border: 1px solid var(--monica-outline); border-radius: 999px; background: transparent; font: inherit; font-size: 0.875rem; }
  .modes button[aria-pressed="true"] { color: var(--monica-on-primary); background: var(--monica-primary); border-color: transparent; }
  .options { display: grid; gap: 12px; }
  .options-group { min-width: 0; margin: 0; padding: 10px 12px; display: grid; gap: 8px; border: 1px solid var(--monica-outline); border-radius: 10px; }
  .options-group legend { padding: 0 6px; font-weight: 600; font-size: 0.8125rem; }
  .check-row { display: flex; align-items: center; gap: 8px; min-height: 32px; }
  .check-row input[type="checkbox"] { width: 18px; height: 18px; margin: 0; }
  .field-row { display: grid; gap: 6px; }
  .field-row > span { color: var(--monica-muted); font-size: 0.8125rem; }
  .field-row input[type="text"], .field-row input[type="number"] { min-height: 40px; border: 1px solid var(--monica-outline); border-radius: 8px; padding: 0 10px; color: var(--monica-text); background: var(--monica-surface); font: inherit; }
  .field-row input[type="range"] { width: 100%; accent-color: var(--monica-primary); }
  .symbol-grid { display: flex; flex-wrap: wrap; gap: 4px; }
  .symbol-chip { display: inline-flex; align-items: center; gap: 2px; min-height: 30px; padding: 0 6px; border-radius: 6px; background: var(--monica-surface-container); font: 500 0.9375rem/1 ui-monospace, monospace; cursor: pointer; }
  .symbol-chip input { width: 14px; height: 14px; margin: 0; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .actions button { flex: 1 1 7rem; min-height: 44px; font-size: 0.9375rem; }
  .actions .secondary { border: 1px solid var(--monica-outline); }
  .status { min-height: 20px; margin: 0; color: var(--monica-muted); font-size: 0.8125rem; text-align: center; }
  .status.success { color: var(--monica-success); }
  .status.error { color: var(--monica-error); }
  button { min-height: 0; padding: 0; }
  .panel button { cursor: pointer; }
  .panel button:focus-visible { outline: 3px solid var(--monica-primary); outline-offset: 2px; }
`;
