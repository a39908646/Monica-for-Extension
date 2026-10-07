import { PROMPT_BASE_STYLES } from "./prompt-styles";

/** 字段内生成器：字段内小图标 + 弹出面板，沿用保存提示那套配色与可访问性约定。 */
export const GENERATOR_STYLES = `${PROMPT_BASE_STYLES}
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
    width: min(320px, calc(100vw - 16px));
    max-height: min(420px, calc(100vh - 16px));
    overflow: auto;
    display: grid; gap: 10px;
    padding: 14px;
    border: 1px solid var(--monica-outline); border-radius: 14px;
    color: var(--monica-text); background: var(--monica-surface);
    animation: monica-prompt-in 180ms cubic-bezier(.2,.8,.2,1);
  }
  .head { display: flex; align-items: center; gap: 8px; }
  .head strong { flex: 1; font-size: 0.9375rem; }
  .head .icon-button { width: 36px; min-height: 36px; }
  .result { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 8px; background: var(--monica-surface-container); }
  .result code { flex: 1; font: 500 0.9375rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  .result .icon-button { width: 36px; min-height: 36px; }
  .result svg, .icon-button svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .modes { display: flex; flex-wrap: wrap; gap: 6px; }
  .modes button { min-height: 34px; padding: 6px 12px; border: 1px solid var(--monica-outline); border-radius: 999px; background: transparent; font-size: 0.75rem; font-weight: 500; }
  .modes button[aria-pressed="true"] { color: var(--monica-on-primary); background: var(--monica-primary); border-color: transparent; }
  .length { display: flex; align-items: center; gap: 8px; color: var(--monica-muted); font-size: 0.75rem; }
  .length button { width: 36px; min-height: 36px; padding: 0; display: grid; place-items: center; border: 1px solid var(--monica-outline); border-radius: 8px; background: transparent; }
  .length button:disabled { cursor: default; }
  .length span { flex: 1; text-align: center; font-variant-numeric: tabular-nums; }
  .entropy { margin: 0; color: var(--monica-muted); font-size: 0.75rem; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .actions button { flex: 1 1 6rem; min-height: 40px; font-size: 0.8125rem; }
  .actions .primary { color: var(--monica-on-primary); background: var(--monica-primary); }
  .actions .secondary { border: 1px solid var(--monica-outline); }
`;
