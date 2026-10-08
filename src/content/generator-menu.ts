import { passwordStrengthBits } from "../core/credential-generator";
import { generatePassphrase, generatePassword, generatePin } from "../core/credential-generator";
import { countsToPasswordConfig, DEFAULT_GENERATOR_COUNTS, type GeneratorCounts, type FieldGeneratorMode } from "../core/generator-presets";
import { getUiLocale, initializeUiLocale, tr } from "../i18n/runtime";
import { setNativeValue } from "./dom";
import { generatorMirrorFields, generatorPasswordFields, generatorScopes } from "./generator-fields";
import { GENERATOR_STYLES } from "./generator-styles";
import { inlineMenuPosition } from "./inline-position";
import { loginFieldRole, loginFieldScope } from "./login-field-role";
import { createPromptI18n } from "./prompt-i18n";
import { promptIcon } from "./prompt-styles";
import { INLINE_AUTOFILL_ENABLED_KEY, inlineAutofillEnabled, readInlineAutofillEnabled } from "../autofill/inline-preferences";

/** 字段内图标用属性标记，面板用固定 id；两者都只往页面里挂 host 元素，不改动页面结构。 */
export const GENERATOR_ICON_ATTRIBUTE = "data-monica-password-generator";
export const GENERATOR_PANEL_HOST_ID = "monica-password-generator-panel";

const ICON_SIZE = 26;
const ICON_INSET = 6;
const PANEL_DESIRED_HEIGHT = 420;
const COUNTS_KEY = "monica.generator.counts";
const MODE_KEY = "monica.generator.mode";
const MODE_LABELS: Record<FieldGeneratorMode, string> = { SYMBOL: "密码", PASSWORD: "单词", PIN: "PIN", PASSPHRASE: "短语" };
const MODE_ORDER: FieldGeneratorMode[] = ["SYMBOL", "PASSWORD", "PIN", "PASSPHRASE"];
const COUNT_LABELS: Array<{ key: keyof GeneratorCounts; label: string }> = [
  { key: "uppercase", label: "大写" },
  { key: "lowercase", label: "小写" },
  { ...({ key: "digits" as keyof GeneratorCounts, label: "数字" }) },
  { key: "symbols", label: "符号" }
];

/**
 * 字段内密码生成器：只在新密码字段上出现。生成不读密码库、不联网、不记任何历史，
 * 因此密码库锁定时同样可用。开关沿用「表单旁自动填充」偏好，与内联菜单一致。
 */
export function installPasswordGenerator(rootDocument: Document = document) {
  const view = rootDocument.defaultView!;
  const icons = new Map<HTMLInputElement, IconHandle>();
  let disposed = false;
  let enabled = false;
  let counts: GeneratorCounts = { ...DEFAULT_GENERATOR_COUNTS };
  let mode: FieldGeneratorMode = "SYMBOL";
  let panel: PanelState | undefined;
  let frame = 0;
  let scanTimer = 0;
  let observer: MutationObserver | undefined;

  interface IconHandle { host: HTMLElement; dispose: () => void; }

  interface PanelState {
    host: HTMLElement;
    field: HTMLInputElement;
    scope: ParentNode;
    value: string;
    i18n: ReturnType<typeof createPromptI18n>;
    output: HTMLElement;
    entropy: HTMLElement;
    status: HTMLElement;
    options: HTMLElement;
    modeLabel: HTMLElement;
    cleanups: Array<() => void>;
    controlSyncs: Array<() => void>;
    refresh: () => void;
  }

  function setImportant(node: HTMLElement, property: string, value: string): void {
    if (node.style.getPropertyValue(property) !== value) node.style.setProperty(property, value, "important");
  }

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
    const node = rootDocument.createElement(tag);
    if (className) node.className = className;
    return node;
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
    setImportant(host, "visibility", onScreen ? "visible" : "hidden");
    if (!onScreen) return;
    const left = Math.round(Math.max(0, Math.min(rect.right - ICON_SIZE - ICON_INSET, view.innerWidth - ICON_SIZE - 2)));
    const styles = { left: `${left}px`, top: `${Math.round(rect.top + (rect.height - ICON_SIZE) / 2)}px` };
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
    const styles = {
      left: `${position.left}px`,
      top: `${position.top}px`,
      width: `${position.width}px`,
      "max-height": `${position.maxHeight}px`
    };
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

  /** 任何数量改动都走这里：夹紧、保存、重新生成，并同步面板控件。 */
  function commitCount(key: keyof GeneratorCounts, value: number): void {
    counts = { ...counts, [key]: Math.max(0, Math.min(32, Math.round(value) || 0)) };
    persistCounts();
    if (panel) { panel.value = generate(); renderResult(); for (const sync of panel.controlSyncs) sync(); }
  }

  function setMode(next: FieldGeneratorMode): void {
    mode = next;
    persistMode();
    if (panel) { panel.value = generate(); renderResult(); for (const sync of panel.controlSyncs) sync(); }
  }

  function persistCounts(): void {
    void chrome.storage.local.set({ [COUNTS_KEY]: counts }).catch(() => undefined);
  }

  function persistMode(): void {
    void chrome.storage.local.set({ [MODE_KEY]: mode }).catch(() => undefined);
  }

  function generate(): string {
    if (mode === "PIN") return generatePin(counts.digits || 6);
    if (mode === "PASSPHRASE") return generatePassphrase({ length: counts.lowercase || 4, delimiter: "-" });
    return generatePassword(countsToPasswordConfig(counts));
  }

  function totalLength(): number {
    return counts.uppercase + counts.lowercase + counts.digits + counts.symbols;
  }

  function renderResult(): void {
    const current = panel;
    if (!current) return;
    // 结果始终明文：用户必须核对生成的密码是否符合偏好。
    current.output.textContent = current.value;
    current.i18n.text(current.entropy, () => tr('约 {0} bit', { 0: passwordStrengthBits(current.value) }));
    current.i18n.text(current.modeLabel, () => tr('长度：{0}', { 0: totalLength() }));
  }

  function copyResult(): void {
    if (!panel) return;
    navigator.clipboard.writeText(panel.value).then(() => {
      setStatus(tr('已复制到剪贴板。'), "success");
    }).catch(() => {
      setStatus(tr('复制失败，请手动选择内容。'), "error");
    });
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

  function closePanel(): void {
    const current = panel;
    panel = undefined;
    if (!current) return;
    for (const cleanup of current.cleanups) cleanup();
  }

  async function openPanel(field: HTMLInputElement): Promise<void> {
    closePanel();
    await initializeUiLocale();
    if (disposed || !enabled || !field.isConnected) return;
    const scope = loginFieldScope(field, rootDocument);
    if (loginFieldRole(field, scope) !== "new-password") return;
    const i18n = createPromptI18n();
    const host = rootDocument.createElement("div");
    host.id = GENERATOR_PANEL_HOST_ID;
    host.style.cssText = "all:initial!important;position:fixed!important;inset:auto!important;margin:0!important;padding:0!important;border:0!important;z-index:2147483647!important;display:block!important;box-sizing:border-box!important;pointer-events:none!important;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = rootDocument.createElement("style");
    style.textContent = GENERATOR_STYLES;

    const surface = element("section", "panel");
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

    // 结果始终明文：用户必须核对生成的密码是否符合偏好。
    const result = element("div", "result");
    const output = element("code", "value");
    const entropy = element("small", "");
    result.append(output, entropy);

    const modeBar = element("div", "modes");
    modeBar.setAttribute("role", "group");
    i18n.attribute(modeBar, "aria-label", () => tr('生成类型'));
    const modeButtons = new Map<FieldGeneratorMode, HTMLButtonElement>();
    for (const candidate of MODE_ORDER) {
      const button = element("button", "mode") as HTMLButtonElement;
      button.type = "button";
      button.setAttribute("aria-pressed", String(candidate === mode));
      i18n.text(button, () => tr(MODE_LABELS[candidate]));
      modeButtons.set(candidate, button);
      modeBar.append(button);
    }

    const countRow = element("div", "count-row");
    const countInputs: Array<{ key: keyof GeneratorCounts; input: HTMLInputElement }> = [];
    for (const { key, label } of COUNT_LABELS) {
      const label_el = element("span", "count-label");
      i18n.text(label_el, () => tr(label));
      const input = rootDocument.createElement("input");
      input.type = "number";
      input.min = "0";
      input.max = "32";
      input.value = String(counts[key]);
      input.setAttribute("data-count", key);
      countInputs.push({ key, input });
      countRow.append(label_el, input);
    }
    const modeLabel = element("span", "mode-length");
    i18n.text(modeLabel, () => tr('长度：{0}', { 0: totalLength() }));

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

    surface.append(head, result, modeBar, countRow, actions, status);
    shadow.append(style, surface);
    rootDocument.documentElement.append(host);

    const cleanups: Array<() => void> = [() => i18n.dispose(), () => host.remove()];
    const controlSyncs: Array<() => void> = [];
    panel = {
      host, field, scope,
      value: generate(),
      i18n, output, entropy, status, options: countRow, modeLabel,
      cleanups, controlSyncs,
      refresh: () => {
        for (const sync of controlSyncs) sync();
        renderResult();
      }
    };

    for (const [candidate, button] of modeButtons) {
      button.addEventListener("click", event => {
        if (!event.isTrusted || !panel || mode === candidate) return;
        setMode(candidate);
        for (const [entry, control] of modeButtons) control.setAttribute("aria-pressed", String(entry === candidate));
        renderResult();
      });
    }

    for (const { key, input } of countInputs) {
      input.addEventListener("change", () => commitCount(key, Number(input.value)));
      controlSyncs.push(() => { input.value = String(counts[key]); });
    }

    regenerateButton.addEventListener("click", event => {
      if (!event.isTrusted || !panel) return;
      panel.value = generate();
      renderResult();
    });
    copyButton.addEventListener("click", event => { if (event.isTrusted) copyResult(); });
    fillButton.addEventListener("click", event => { if (event.isTrusted) fillResult(); });
    close.addEventListener("click", event => { if (event.isTrusted) closePanel(); });

    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.isTrusted || event.key !== "Escape" || !panel) return;
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!event.isTrusted || !panel) return;
      const path = event.composedPath();
      if (path.includes(panel.host) || path.some(node => node instanceof view.Element && node.hasAttribute(GENERATOR_ICON_ATTRIBUTE))) return;
      closePanel();
    };
    rootDocument.addEventListener("keydown", onKeyDown, true);
    rootDocument.addEventListener("pointerdown", onPointerDown, true);
    cleanups.push(
      () => rootDocument.removeEventListener("keydown", onKeyDown, true),
      () => rootDocument.removeEventListener("pointerdown", onPointerDown, true)
    );

    // 面板按钮不夺走字段焦点，用户可以继续在页面里打字。
    surface.addEventListener("pointerdown", event => { if (event.isTrusted && event.button === 0) event.preventDefault(); });

    renderResult();
    positionPanel();
    fillButton.focus();
  }

  function applyEnabled(next: boolean): void {
    enabled = next;
    if (!enabled) { closePanel(); clearIcons(); return; }
    scheduleScan();
  }

  function preferenceChanged(changes: Record<string, chrome.storage.StorageChange>, area: string): void {
    if (area !== "local") return;
    if (changes[INLINE_AUTOFILL_ENABLED_KEY]) applyEnabled(inlineAutofillEnabled(changes[INLINE_AUTOFILL_ENABLED_KEY].newValue));
    if (changes[COUNTS_KEY]?.newValue) counts = { ...DEFAULT_GENERATOR_COUNTS, ...(changes[COUNTS_KEY].newValue as GeneratorCounts) };
    if (changes[MODE_KEY]?.newValue) mode = changes[MODE_KEY].newValue as FieldGeneratorMode;
    if (panel) {
      panel.value = generate();
      renderResult();
      for (const sync of panel.controlSyncs) sync();
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

  void Promise.all([
    chrome.storage.local.get([COUNTS_KEY, MODE_KEY]),
    readInlineAutofillEnabled(),
    initializeUiLocale()
  ]).then(([stored, inlineEnabled]) => {
    if (disposed) return;
    if (stored[COUNTS_KEY]) counts = { ...DEFAULT_GENERATOR_COUNTS, ...(stored[COUNTS_KEY] as GeneratorCounts) };
    if (stored[MODE_KEY]) mode = stored[MODE_KEY] as FieldGeneratorMode;
    applyEnabled(inlineEnabled);
  }).catch(() => applyEnabled(true));

  return {
    scan: () => scheduleScan(),
    dispose() {
      if (disposed) return;
      disposed = true;
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
