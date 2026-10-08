import { INLINE_AUTOFILL_ENABLED_KEY, inlineAutofillEnabled, readInlineAutofillEnabled } from "../autofill/inline-preferences";
import { DEFAULT_SYMBOLS, passwordStrengthBits } from "../core/credential-generator";
import {
  DEFAULT_GENERATOR_PREFERENCES,
  GENERATOR_PREFERENCES_STORAGE_KEY,
  GeneratorPreferencesStore,
  normalizeGeneratorPreferences,
  resolveAllowedSymbols,
  type GeneratorPreferences
} from "../core/generator-preferences";
import { FIELD_GENERATOR_MODES, fieldGeneratorMode, generateFromPreferences, type FieldGeneratorMode } from "../core/generator-presets";
import { getUiLocale, initializeUiLocale, tr } from "../i18n/runtime";
import { setNativeValue } from "./dom";
import { generatorMirrorFields, generatorPasswordFields, generatorScopes } from "./generator-fields";
import { GENERATOR_STYLES } from "./generator-styles";
import { inlineMenuPosition } from "./inline-position";
import { loginFieldRole, loginFieldScope } from "./login-field-role";
import { createPromptI18n } from "./prompt-i18n";
import { promptIcon } from "./prompt-styles";

/** 字段内图标用属性标记，面板用固定 id；两者都只往页面里挂 host 元素，不改动页面结构。 */
export const GENERATOR_ICON_ATTRIBUTE = "data-monica-password-generator";
export const GENERATOR_PANEL_HOST_ID = "monica-password-generator-panel";

const ICON_SIZE = 26;
const ICON_INSET = 6;
const PANEL_DESIRED_HEIGHT = 480;
const MODE_LABELS: Record<FieldGeneratorMode, string> = { SYMBOL: "密码", PASSWORD: "单词", PIN: "PIN", PASSPHRASE: "短语" };

/**
 * 字段内密码生成器：只在新密码字段上出现。生成不读密码库、不联网、不记任何历史，
 * 因此密码库锁定时同样可用。开关沿用「表单旁自动填充」偏好，与内联菜单一致。
 */
export function installPasswordGenerator(rootDocument: Document = document) {
  const view = rootDocument.defaultView!;
  const store = new GeneratorPreferencesStore();
  const icons = new Map<HTMLInputElement, IconHandle>();
  let disposed = false;
  let enabled = false;
  let preferences: GeneratorPreferences = DEFAULT_GENERATOR_PREFERENCES;
  let panel: PanelState | undefined;
  let frame = 0;
  let scanTimer = 0;
  let observer: MutationObserver | undefined;
  let preferenceRevision = 0;

  function applyEnabled(next: boolean): void {
    enabled = next;
    if (!enabled) { closePanel(); clearIcons(); return; }
    scheduleScan();
  }

  interface IconHandle { host: HTMLElement; dispose: () => void; }

  interface PanelState {
    host: HTMLElement;
    field: HTMLInputElement;
    scope: ParentNode;
    mode: FieldGeneratorMode;
    value: string;
    i18n: ReturnType<typeof createPromptI18n>;
    output: HTMLElement;
    entropy: HTMLElement;
    status: HTMLElement;
    options: HTMLElement;
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

  /** 任何偏好改动都走这里：规范化、保存、重新生成，并同步面板控件。 */
  function commit(key: keyof GeneratorPreferences, value: unknown): void {
    preferences = normalizeGeneratorPreferences({ ...preferences, [key]: value });
    persist();
    regenerate();
    if (panel) for (const sync of panel.controlSyncs) sync();
  }

  function persist(): void {
    void store.save(preferences).catch(() => undefined);
  }

  function regenerate(): void {
    if (!panel) return;
    panel.value = generateFromPreferences(preferences, panel.mode);
    renderResult();
    positionPanel();
  }

  function renderResult(): void {
    const current = panel;
    if (!current) return;
    // 结果始终明文：用户必须核对生成的密码是否符合偏好。
    current.output.textContent = current.value;
    const value = current.value;
    current.i18n.text(current.entropy, () => tr('约 {0} bit', { 0: passwordStrengthBits(value) }));
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

    const result = element("div", "result");
    const output = element("code", "value");
    const entropy = element("small", "");
    result.append(output, entropy);

    const modeBar = element("div", "modes");
    modeBar.setAttribute("role", "group");
    i18n.attribute(modeBar, "aria-label", () => tr('模式'));
    const mode = fieldGeneratorMode(preferences.selectedGenerator);
    const modeButtons = new Map<FieldGeneratorMode, HTMLButtonElement>();
    for (const candidate of FIELD_GENERATOR_MODES) {
      const button = element("button", "mode") as HTMLButtonElement;
      button.type = "button";
      button.setAttribute("aria-pressed", String(candidate === mode));
      i18n.text(button, () => tr(MODE_LABELS[candidate]));
      modeButtons.set(candidate, button);
      modeBar.append(button);
    }

    const options = element("div", "options");

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

    surface.append(head, result, modeBar, options, actions, status);
    shadow.append(style, surface);
    rootDocument.documentElement.append(host);

    const cleanups: Array<() => void> = [() => i18n.dispose(), () => host.remove()];
    const controlSyncs: Array<() => void> = [];
    panel = {
      host, field, scope, mode,
      value: generateFromPreferences(preferences, mode),
      i18n, output, entropy, status, options,
      cleanups, controlSyncs,
      refresh: () => { for (const sync of controlSyncs) sync(); }
    };

    for (const [candidate, button] of modeButtons) {
      button.addEventListener("click", event => {
        if (!event.isTrusted || !panel || panel.mode === candidate) return;
        preferences = normalizeGeneratorPreferences({ ...preferences, selectedGenerator: candidate });
        persist();
        panel.mode = candidate;
        for (const [entry, control] of modeButtons) control.setAttribute("aria-pressed", String(entry === candidate));
        rebuildOptions();
        regenerate();
      });
    }

    regenerateButton.addEventListener("click", event => { if (event.isTrusted) regenerate(); });
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

    /** 当前模式的控件清单：直接读写共享偏好，任何改动都会重新生成并保存。 */
    function optionControls(activeMode: FieldGeneratorMode): Array<{ element: HTMLElement; sync: () => void }> {
      if (activeMode === "SYMBOL") {
        return [
          rangeRow("symbolLength", 4, 64),
          fieldset('字符类型', [
            checkRow('大写字母', "includeUppercase"),
            checkRow('小写字母', "includeLowercase"),
            checkRow('数字', "includeNumbers"),
            checkRow('符号', "includeSymbols")
          ]),
          fieldset('最少数量', [
            minRow('大写最少数量', "uppercaseMin", "includeUppercase", '大写'),
            minRow('小写最少数量', "lowercaseMin", "includeLowercase", '小写'),
            minRow('数字最少数量', "numbersMin", "includeNumbers", '数字'),
            minRow('符号最少数量', "symbolsMin", "includeSymbols", '符号')
          ]),
          symbolSourceControls(),
          fieldset('可读性', [
            checkRow('排除 0 O l 1 I', "excludeSimilar"),
            checkRow('排除模糊符号', "excludeAmbiguous")
          ])
        ];
      }
      if (activeMode === "PASSWORD") {
        return [
          rangeRow("passwordLength", 4, 128),
          fieldset('选项', [
            checkRow('首字母大写', "firstLetterUppercase"),
            checkRow('附加数字', "includeNumbersInPassword"),
            checkRow('分隔符计入长度', "separatorCountsTowardsLength")
          ]),
          textRow('自定义分隔符（可选）', "customSeparator", 8),
          rangeRow("segmentLength", 0, 20, '分段长度：{0}')
        ];
      }
      if (activeMode === "PIN") return [numberRow('PIN 长度', "pinLength", 1, 128)];
      return [
        numberRow('单词数', "passphraseWordCount", 1, 32),
        textRow('分隔符', "passphraseDelimiter", 8),
        textRow('自定义单词（可选）', "passphraseCustomWord", 256),
        fieldset('选项', [
          checkRow('首字母大写', "passphraseCapitalize"),
          checkRow('附加数字', "passphraseIncludeNumber")
        ])
      ];
    }

    /** 同步面板里随偏好变化的控件（长度标签、勾选状态、禁用联动等）。 */
    function renderLength(): void {
      if (!panel) return;
      for (const sync of panel.controlSyncs) sync();
    }

    // ---- 控件工厂：直接读写共享偏好，任何改动都会重新生成并保存 ----
    function checkRow(label: string, key: keyof GeneratorPreferences): { element: HTMLElement; sync: () => void } {
      const row = element("label", "check-row");
      const input = rootDocument.createElement("input");
      input.type = "checkbox";
      input.checked = preferences[key] === true;
      const text = element("span", "");
      i18n.text(text, () => tr(label));
      row.append(input, text);
      input.addEventListener("change", () => commit(key, input.checked));
      const sync = () => { input.checked = preferences[key] === true; };
      controlSyncs.push(sync);
      return { element: row, sync };
    }

    function minRow(label: string, key: keyof GeneratorPreferences, dependsOn: keyof GeneratorPreferences, dependsText: string): { element: HTMLElement; sync: () => void } {
      const row = element("label", "check-row");
      const input = rootDocument.createElement("input");
      input.type = "number";
      input.min = "0";
      input.max = "32";
      input.value = String(preferences[key]);
      input.addEventListener("change", () => commit(key, input.value));
      const text = element("span", "");
      i18n.text(text, () => tr(dependsText));
      row.append(input, text);
      const sync = () => { input.value = String(preferences[key]); input.disabled = preferences[dependsOn] !== true; };
      controlSyncs.push(sync);
      return { element: row, sync };
    }

    function numberRow(label: string, key: keyof GeneratorPreferences, min: number, max: number): { element: HTMLElement; sync: () => void } {
      const row = element("label", "check-row");
      const span = element("span", "");
      i18n.text(span, () => tr(label));
      const input = rootDocument.createElement("input");
      input.type = "number";
      input.min = String(min);
      input.max = String(max);
      input.value = String(preferences[key]);
      row.append(span, input);
      input.addEventListener("change", () => commit(key, input.value));
      const sync = () => { input.value = String(preferences[key]); };
      controlSyncs.push(sync);
      return { element: row, sync };
    }

    function textRow(label: string, key: keyof GeneratorPreferences, maxlength: number): { element: HTMLElement; sync: () => void } {
      const row = element("label", "field-row");
      const span = element("span", "");
      i18n.text(span, () => tr(label));
      const input = rootDocument.createElement("input");
      input.type = "text";
      input.maxLength = maxlength;
      input.value = String(preferences[key] ?? "");
      row.append(span, input);
      input.addEventListener("change", () => commit(key, input.value));
      const sync = () => { input.value = String(preferences[key] ?? ""); };
      controlSyncs.push(sync);
      return { element: row, sync };
    }

    function rangeRow(key: keyof GeneratorPreferences, min: number, max: number, label?: string): { element: HTMLElement; sync: () => void } {
      const row = element("label", "field-row");
      const span = element("span", "");
      const input = rootDocument.createElement("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.value = String(preferences[key]);
      if (label) {
        input.setAttribute("aria-label", tr(label));
      } else {
        input.setAttribute("data-length-input", String(key));
        span.setAttribute("data-length-label", String(key));
      }
      const sync = () => {
        input.value = String(preferences[key]);
        span.textContent = tr('长度：{0}', { 0: preferences[key] });
      };
      controlSyncs.push(sync);
      row.append(span, input);
      input.addEventListener("input", () => commit(key, input.value));
      return { element: row, sync };
    }

    function fieldset(legend: string, controls: Array<{ element: HTMLElement; sync: () => void }>): { element: HTMLElement; sync: () => void } {
      const box = element("fieldset", "options-group");
      const title = element("legend", "");
      i18n.text(title, () => tr(legend));
    box.append(title);
      const syncs: Array<() => void> = [];
      for (const control of controls) {
        box.append(control.element);
        syncs.push(control.sync);
      }
      return { element: box, sync: () => { for (const sync of syncs) sync(); } };
    }

    function symbolSourceControls(): { element: HTMLElement; sync: () => void } {
      const box = element("div", "options-group");
      const legend = element("p", "options-legend");
      i18n.text(legend, () => tr('符号来源'));
      box.append(legend);
      const exclusion = element("label", "check-row");
      const exclusionInput = rootDocument.createElement("input");
      exclusionInput.type = "radio";
      exclusionInput.name = "monica-symbol-source";
      exclusionInput.checked = preferences.useSymbolExclusionMode;
      exclusion.append(exclusionInput);
      i18n.text(exclusion, () => tr('排除默认符号'));
      const custom = element("label", "check-row");
      const customInput = rootDocument.createElement("input");
      customInput.type = "radio";
      customInput.name = "monica-symbol-source";
      customInput.checked = !preferences.useSymbolExclusionMode;
      custom.append(customInput);
      i18n.text(custom, () => tr('自定义符号集'));
      const grid = element("div", "symbol-grid");
      for (const symbol of [...DEFAULT_SYMBOLS]) {
        const chip = element("label", "symbol-chip");
        const input = rootDocument.createElement("input");
        input.type = "checkbox";
        input.checked = !preferences.excludedSymbols.includes(symbol);
        i18n.attribute(input, "aria-label", () => tr('使用符号 {0}', { 0: symbol }));
        input.addEventListener("change", () => {
          const excluded = new Set(preferences.excludedSymbols);
          if (input.checked) excluded.delete(symbol);
          else excluded.add(symbol);
          commit("excludedSymbols", [...excluded].join(""));
        });
        chip.append(input);
        i18n.text(chip, () => symbol);
        grid.append(chip);
      }
      const customSet = textRow('自定义符号集', "customSymbols", 256);
      box.append(exclusion, custom, grid, customSet.element);
      const sync = () => {
        grid.hidden = preferences.useSymbolExclusionMode;
        customSet.element.hidden = preferences.useSymbolExclusionMode;
        for (const chip of grid.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
          const symbol = chip.closest("label")?.textContent || "";
          chip.checked = !preferences.excludedSymbols.includes(symbol);
        }
      };
      controlSyncs.push(sync);
      return { element: box, sync };
    }

    function rebuildOptions(): void {
      if (!panel) return;
      panel.options.replaceChildren();
      for (const control of optionControls(panel.mode)) panel.options.append(control.element);
      renderLength();
    }


    rebuildOptions();
    renderResult();
    positionPanel();
    fillButton.focus();
  }

  function setPreference(key: keyof GeneratorPreferences, value: unknown): void {
    preferences = normalizeGeneratorPreferences({ ...preferences, [key]: value });
    persist();
    regenerate();
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
