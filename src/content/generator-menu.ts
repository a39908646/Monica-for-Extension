import { INLINE_AUTOFILL_ENABLED_KEY, inlineAutofillEnabled, readInlineAutofillEnabled } from "../autofill/inline-preferences";
import { passwordStrengthBits } from "../core/credential-generator";
import {
  DEFAULT_GENERATOR_PREFERENCES,
  GENERATOR_PREFERENCES_STORAGE_KEY,
  GeneratorPreferencesStore,
  normalizeGeneratorPreferences,
  type GeneratorPreferences
} from "../core/generator-preferences";
import {
  FIELD_GENERATOR_LENGTH_RANGE,
  FIELD_GENERATOR_MODES,
  fieldGeneratorLength,
  fieldGeneratorMode,
  generateFromPreferences,
  withFieldGeneratorLength,
  type FieldGeneratorMode
} from "../core/generator-presets";
import { getUiLocale, initializeUiLocale, tr } from "../i18n/runtime";
import { setNativeValue } from "./dom";
import { generatorMirrorFields, generatorPasswordFields, generatorScopes } from "./generator-fields";
import { GENERATOR_STYLES } from "./generator-styles";
import { inlineMenuPosition } from "./inline-position";
import { loginFieldRole, loginFieldScope } from "./login-field-role";
import { createPromptI18n } from "./prompt-i18n";
import { promptIcon } from "./prompt-styles";

/** 字段内图标用属性标记，面板用固定 id；两者都在页面里只挂 host 元素，不改动页面结构。 */
export const GENERATOR_ICON_ATTRIBUTE = "data-monica-password-generator";
export const GENERATOR_PANEL_HOST_ID = "monica-password-generator-panel";

const ICON_SIZE = 26;
const ICON_INSET = 6;
const PANEL_DESIRED_HEIGHT = 300;
const MODE_LABELS: Record<FieldGeneratorMode, string> = { SYMBOL: "密码", PASSWORD: "单词", PIN: "PIN", PASSPHRASE: "短语" };

/**
 * 字段内密码生成器：只在新密码字段上出现，生成过程不读密码库、不联网、不写任何历史，
 * 因此密码库锁定时同样可用。开关沿用「表单旁自动填充」偏好，与内联菜单一致。
 */
export function installPasswordGenerator(rootDocument: Document = document) {
  const view = rootDocument.defaultView!;
  const store = new GeneratorPreferencesStore();
  const icons = new Map<HTMLInputElement, { host: HTMLElement; dispose: () => void }>();
  let disposed = false;
  let enabled = false;
  let preferences: GeneratorPreferences = DEFAULT_GENERATOR_PREFERENCES;
  let panel: PanelState | undefined;
  let frame = 0;
  let scanTimer = 0;
  let observer: MutationObserver | undefined;
  let preferenceRevision = 0;

  interface PanelState {
    host: HTMLElement;
    field: HTMLInputElement;
    scope: ParentNode;
    mode: FieldGeneratorMode;
    value: string;
    revealed: boolean;
    i18n: ReturnType<typeof createPromptI18n>;
    output: HTMLElement;
    entropy: HTMLElement;
    status: HTMLElement;
    lengthLabel: HTMLElement;
    revealButton: HTMLButtonElement;
    modeButtons: Map<FieldGeneratorMode, HTMLButtonElement>;
    decrease: HTMLButtonElement;
    increase: HTMLButtonElement;
    cleanups: Array<() => void>;
  }

  function attachIcon(field: HTMLInputElement): void {
    if (icons.has(field) || field.closest(`[${GENERATOR_ICON_ATTRIBUTE}]`)) return;
    const host = rootDocument.createElement("div");
    host.setAttribute(GENERATOR_ICON_ATTRIBUTE, "");
    host.style.cssText = "all:initial!important;position:fixed!important;inset:auto!important;margin:0!important;padding:0!important;border:0!important;z-index:2147483647!important;display:block!important;box-sizing:border-box!important;pointer-events:auto!important;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = rootDocument.createElement("style");
    style.textContent = GENERATOR_STYLES;
    const i18n = createPromptI18n();
    const trigger = rootDocument.createElement("button");
    trigger.type = "button";
    trigger.className = "trigger";
    trigger.innerHTML = promptIcon("key");
    i18n.attribute(trigger, "aria-label", () => tr('生成密码'));
    i18n.attribute(trigger, "title", () => tr('生成密码'));
    // 不夺走字段焦点，用户可以边输入边用生成器。
    trigger.addEventListener("pointerdown", event => { if (event.isTrusted && event.button === 0) event.preventDefault(); });
    trigger.addEventListener("click", event => { if (event.isTrusted) void openPanel(field); });
    shadow.append(style, trigger);
    rootDocument.documentElement.append(host);
    icons.set(field, { host, dispose: () => { i18n.dispose(); host.remove(); } });
    positionIcon(field, host);
  }

  function positionIcon(field: HTMLInputElement, host: HTMLElement): void {
    const rect = field.getBoundingClientRect();
    const onScreen = field.isConnected && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < view.innerHeight;
    // 内联样式里的 inset:auto 带 !important，定位必须同样用 important 才会生效。
    const left = Math.round(Math.max(0, Math.min(rect.right - ICON_SIZE - ICON_INSET, view.innerWidth - ICON_SIZE - 2)));
    const styles = onScreen
      ? { visibility: "visible", left: `${left}px`, top: `${Math.round(rect.top + (rect.height - ICON_SIZE) / 2)}px` }
      : { visibility: "hidden" };
    for (const [property, value] of Object.entries(styles)) setImportant(host, property, value);
  }

  function positionPanel(): void {
    if (!panel) return;
    if (!panel.field.isConnected) return closePanel();
    const rect = panel.field.getBoundingClientRect();
    const position = inlineMenuPosition(rect, {
      left: view.visualViewport?.offsetLeft || 0,
      top: view.visualViewport?.offsetTop || 0,
      width: view.visualViewport?.width || view.innerWidth,
      height: view.visualViewport?.height || view.innerHeight
    }, PANEL_DESIRED_HEIGHT);
    if (!position) return closePanel();
    const styles = { left: `${position.left}px`, top: `${position.top}px`, width: `${position.width}px`, "max-height": `${position.maxHeight}px` };
    for (const [property, value] of Object.entries(styles)) setImportant(panel.host, property, value);
  }

  function schedulePosition(): void {
    if (frame || disposed) return;
    frame = view.requestAnimationFrame(() => {
      frame = 0;
      for (const [field, handle] of icons) positionIcon(field, handle.host);
      positionPanel();
    });
  }

  function pruneIcons(): void {
    for (const [field, handle] of icons) {
      if (field.isConnected) continue;
      handle.dispose();
      icons.delete(field);
      if (panel?.field === field) closePanel();
    }
  }

  function clearIcons(): void {
    for (const handle of icons.values()) handle.dispose();
    icons.clear();
  }

  function scan(): void {
    if (disposed || !enabled) return;
    pruneIcons();
    for (const scope of generatorScopes(rootDocument)) {
      for (const field of generatorPasswordFields(scope, rootDocument)) attachIcon(field);
    }
  }

  function scheduleScan(delay = 0): void {
    if (disposed || !enabled || scanTimer) return;
    scanTimer = view.setTimeout(() => { scanTimer = 0; if (rootDocument.visibilityState !== "hidden") scan(); }, delay);
  }

  async function openPanel(field: HTMLInputElement): Promise<void> {
    closePanel();
    await initializeUiLocale();
    if (disposed || !enabled || !field.isConnected) return;
    const scope = loginFieldScope(field, rootDocument);
    if (loginFieldRole(field, scope) !== "new-password") return;
    const mode = fieldGeneratorMode(preferences.selectedGenerator);
    const i18n = createPromptI18n();
    const host = rootDocument.createElement("div");
    host.id = GENERATOR_PANEL_HOST_ID;
    host.style.cssText = "all:initial!important;position:fixed!important;inset:auto!important;margin:0!important;padding:0!important;border:0!important;z-index:2147483647!important;display:block!important;box-sizing:border-box!important;pointer-events:none!important;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = rootDocument.createElement("style");
    style.textContent = GENERATOR_STYLES;
    const surface = rootDocument.createElement("section");
    surface.className = "panel";
    surface.setAttribute("role", "dialog");
    surface.setAttribute("aria-modal", "false");
    i18n.attribute(surface, "aria-label", () => tr('生成密码'));
    i18n.attribute(surface, "lang", getUiLocale);

    const head = element("header", "head");
    const heading = element("strong", "");
    i18n.text(heading, () => tr('生成密码'));
    const close = element("button", "icon-button") as HTMLButtonElement;
    close.type = "button";
    close.innerHTML = promptIcon("close");
    i18n.attribute(close, "aria-label", () => tr('关闭'));
    head.append(heading, close);

    const result = element("div", "result");
    const output = element("code", "value");
    const revealButton = element("button", "icon-button") as HTMLButtonElement;
    revealButton.type = "button";
    result.append(output, revealButton);

    const entropy = element("p", "entropy");

    const modes = element("div", "modes");
    modes.setAttribute("role", "group");
    i18n.attribute(modes, "aria-label", () => tr('模式'));
    const modeButtons = new Map<FieldGeneratorMode, HTMLButtonElement>();
    for (const candidate of FIELD_GENERATOR_MODES) {
      const button = element("button", "") as HTMLButtonElement;
      button.type = "button";
      button.setAttribute("aria-pressed", String(candidate === mode));
      i18n.text(button, () => tr(MODE_LABELS[candidate]));
      button.addEventListener("click", event => {
        if (!event.isTrusted || !panel) return;
        preferences = { ...preferences, selectedGenerator: candidate };
        persist();
        panel.mode = candidate;
        for (const [entry, control] of panel.modeButtons) control.setAttribute("aria-pressed", String(entry === candidate));
        regenerate();
      });
      modeButtons.set(candidate, button);
      modes.append(button);
    }

    const length = element("div", "length");
    const decrease = element("button", "icon-button") as HTMLButtonElement;
    decrease.type = "button";
    decrease.innerHTML = promptIcon("minus");
    i18n.attribute(decrease, "aria-label", () => tr('缩短一个字符'));
    const lengthLabel = element("span", "");
    const increase = element("button", "icon-button") as HTMLButtonElement;
    increase.type = "button";
    increase.innerHTML = promptIcon("plus");
    i18n.attribute(increase, "aria-label", () => tr('加长一个字符'));
    length.append(decrease, lengthLabel, increase);
    const adjust = (delta: number) => {
      if (!panel) return;
      preferences = withFieldGeneratorLength(preferences, panel.mode, fieldGeneratorLength(preferences, panel.mode) + delta);
      persist();
      regenerate();
    };
    decrease.addEventListener("click", event => { if (event.isTrusted) adjust(-1); });
    increase.addEventListener("click", event => { if (event.isTrusted) adjust(1); });

    const actions = element("footer", "actions");
    const regenerateButton = element("button", "secondary") as HTMLButtonElement;
    regenerateButton.type = "button";
    regenerateButton.innerHTML = promptIcon("refresh");
    i18n.text(regenerateButton, () => tr('重新生成'));
    const copyButton = element("button", "secondary") as HTMLButtonElement;
    copyButton.type = "button";
    i18n.text(copyButton, () => tr('复制'));
    const fillButton = element("button", "primary") as HTMLButtonElement;
    fillButton.type = "button";
    i18n.text(fillButton, () => tr('填充'));
    actions.append(regenerateButton, copyButton, fillButton);

    const status = element("p", "status");
    status.setAttribute("role", "status");
    surface.append(head, result, entropy, modes, length, actions, status);
    shadow.append(style, surface);
    rootDocument.documentElement.append(host);

    // 清理回调先建好再放进状态：面板关闭时逐个执行，避免监听器泄漏。
    const cleanups: Array<() => void> = [() => i18n.dispose(), () => host.remove()];
    panel = { host, field, scope, mode, value: generateFromPreferences(preferences, mode), revealed: false, i18n, output, entropy, status, lengthLabel, revealButton, modeButtons, decrease, increase, cleanups };

    revealButton.addEventListener("click", event => {
      if (!event.isTrusted || !panel) return;
      panel.revealed = !panel.revealed;
      renderResult();
    });
    regenerateButton.addEventListener("click", event => { if (event.isTrusted) regenerate(); });
    copyButton.addEventListener("click", event => { if (event.isTrusted) void copyResult(); });
    fillButton.addEventListener("click", event => { if (event.isTrusted) fillResult(); });
    close.addEventListener("click", event => { if (event.isTrusted) closePanel(); });
    // 面板按钮不夺走字段焦点，用户可以继续在页面里打字。
    surface.addEventListener("pointerdown", event => { if (event.isTrusted && event.button === 0) event.preventDefault(); });

    const onPointerDown = (event: PointerEvent) => {
      if (!event.isTrusted || !panel) return;
      const path = event.composedPath();
      if (path.includes(panel.host) || path.some(node => node instanceof view.Element && node.hasAttribute(GENERATOR_ICON_ATTRIBUTE))) return;
      closePanel();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.isTrusted || event.key !== "Escape" || !panel) return;
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    };
    rootDocument.addEventListener("pointerdown", onPointerDown, true);
    rootDocument.addEventListener("keydown", onKeyDown, true);
    cleanups.push(
      () => rootDocument.removeEventListener("pointerdown", onPointerDown, true),
      () => rootDocument.removeEventListener("keydown", onKeyDown, true)
    );

    renderResult();
    positionPanel();
    fillButton.focus();
  }

  function renderResult(): void {
    if (!panel) return;
    const { value, revealed } = panel;
    panel.output.textContent = revealed ? value : "•".repeat(Math.min(24, Math.max(8, value.length)));
    panel.revealButton.innerHTML = promptIcon(revealed ? "eye-off" : "eye");
    panel.i18n.attribute(panel.revealButton, "aria-label", () => revealed ? tr('隐藏') : tr('显示'));
    panel.i18n.text(panel.entropy, () => tr('约 {0} bit', { 0: passwordStrengthBits(value) }));
    const bounds = FIELD_GENERATOR_LENGTH_RANGE[panel.mode];
    const current = fieldGeneratorLength(preferences, panel.mode);
    panel.i18n.text(panel.lengthLabel, () => tr('长度：{0}', { 0: current }));
    panel.decrease.disabled = current <= bounds.minimum;
    panel.increase.disabled = current >= bounds.maximum;
  }

  function regenerate(): void {
    if (!panel) return;
    panel.value = generateFromPreferences(preferences, panel.mode);
    panel.revealed = false;
    setStatus("", "");
    renderResult();
    positionPanel();
  }

  async function copyResult(): Promise<void> {
    if (!panel) return;
    try {
      await navigator.clipboard.writeText(panel.value);
      setStatus(tr('已复制到剪贴板。'), "success");
    } catch {
      setStatus(tr('复制失败，请手动选择内容。'), "error");
    }
  }

  function fillResult(): void {
    const current = panel;
    if (!current) return;
    const targets = [current.field, ...generatorMirrorFields(current.scope, current.field, rootDocument)];
    const filled = targets.filter(target => setNativeValue(target, current.value)).length;
    if (!filled) return setStatus(tr('无法填入此密码框。'), "error");
    setStatus(tr('已填入密码框。'), "success");
    current.field.focus({ preventScroll: true });
    view.setTimeout(() => closePanel(), 700);
  }

  function setStatus(text: string, kind: "success" | "error" | ""): void {
    if (!panel) return;
    panel.status.textContent = text;
    panel.status.className = `status${kind ? ` ${kind}` : ""}`;
  }

  function persist(): void {
    void store.save(preferences).catch(() => undefined);
  }

  function closePanel(): void {
    const current = panel;
    panel = undefined;
    if (!current) return;
    for (const cleanup of current.cleanups) cleanup();
  }

  function setImportant(element: HTMLElement, property: string, value: string): void {
    if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value, "important");
  }

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
    const node = rootDocument.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function applyEnabled(next: boolean): void {
    enabled = next;
    if (!enabled) {
      closePanel();
      clearIcons();
      return;
    }
    scheduleScan();
  }

  function preferenceChanged(changes: Record<string, chrome.storage.StorageChange>, area: string): void {
    if (area !== "local") return;
    if (changes[INLINE_AUTOFILL_ENABLED_KEY]) applyEnabled(inlineAutofillEnabled(changes[INLINE_AUTOFILL_ENABLED_KEY].newValue));
    if (changes[GENERATOR_PREFERENCES_STORAGE_KEY]) {
      preferences = normalizeGeneratorPreferences(changes[GENERATOR_PREFERENCES_STORAGE_KEY].newValue);
      if (panel) regenerate();
    }
  }

  const onFocusIn = () => scheduleScan();
  const onScroll = () => { schedulePosition(); scheduleScan(120); };
  rootDocument.addEventListener("focusin", onFocusIn, true);
  rootDocument.addEventListener("scroll", onScroll, true);
  rootDocument.addEventListener("visibilitychange", () => scheduleScan());
  view.addEventListener("resize", schedulePosition);
  view.visualViewport?.addEventListener("resize", schedulePosition);
  view.visualViewport?.addEventListener("scroll", schedulePosition);
  chrome.storage.onChanged.addListener(preferenceChanged);
  const MutationObserverCtor = view.MutationObserver;
  if (MutationObserverCtor) {
    observer = new MutationObserverCtor(() => scheduleScan(250));
    observer.observe(rootDocument.documentElement, { childList: true, subtree: true });
  }

  const revision = preferenceRevision;
  void Promise.all([readInlineAutofillEnabled(), store.load()]).then(([preference, stored]) => {
    if (disposed || revision !== preferenceRevision) return;
    preferences = stored;
    applyEnabled(preference);
  }).catch(() => undefined);
  void initializeUiLocale().then(() => { if (enabled) scheduleScan(); }).catch(() => undefined);

  return {
    scan: () => scheduleScan(),
    dispose() {
      if (disposed) return;
      disposed = true;
      preferenceRevision += 1;
      closePanel();
      clearIcons();
      if (frame) view.cancelAnimationFrame(frame);
      if (scanTimer) view.clearTimeout(scanTimer);
      observer?.disconnect();
      chrome.storage.onChanged.removeListener(preferenceChanged);
      rootDocument.removeEventListener("focusin", onFocusIn, true);
      rootDocument.removeEventListener("scroll", onScroll, true);
      view.removeEventListener("resize", schedulePosition);
      view.visualViewport?.removeEventListener("resize", schedulePosition);
      view.visualViewport?.removeEventListener("scroll", schedulePosition);
    }
  };
}
