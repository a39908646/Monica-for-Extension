import { passwordStrengthBits } from "../core/credential-generator";
import {
  applyFieldGeneratorLength,
  applyFieldGeneratorMinimum,
  DEFAULT_FIELD_GENERATOR_SETTINGS,
  FIELD_GENERATOR_LENGTH_RANGE,
  fieldGeneratorSettingsFromCounts,
  generateFromFieldSettings,
  isFieldGeneratorMode,
  normalizeFieldGeneratorSettings,
  type FieldGeneratorMode,
  type FieldGeneratorSettings,
  type GeneratorMinimums
} from "../core/generator-presets";
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
/** 图标与字段之间的间隙。图标一律放在字段外面，绝不盖住站点自己的按钮。 */
const ICON_GAP = 6;
const PANEL_DESIRED_HEIGHT = 420;
const SETTINGS_KEY = "monica.generator.settings";
/** 0.1.39 及以前只存了四类数量（兼作总长度），读取时迁移成「长度 + 最少数量」。 */
const LEGACY_COUNTS_KEY = "monica.generator.counts";
const MODE_KEY = "monica.generator.mode";
const MODE_LABELS: Record<FieldGeneratorMode, string> = { SYMBOL: "密码", PASSWORD: "单词", PIN: "PIN", PASSPHRASE: "短语" };
/** 长度框的标签随模式变化：符号密码/单词密码是字符数，PIN 是位数，短语是单词数。 */
const MODE_LENGTH_LABELS: Record<FieldGeneratorMode, string> = { SYMBOL: "长度", PASSWORD: "单词密码长度", PIN: "PIN 长度", PASSPHRASE: "单词数" };
const MODE_ORDER: FieldGeneratorMode[] = ["SYMBOL", "PASSWORD", "PIN", "PASSPHRASE"];
const MINIMUM_LABELS: Array<{ key: keyof GeneratorMinimums; label: string; ariaLabel: string }> = [
  { key: "uppercase", label: "大写", ariaLabel: "大写最少数量" },
  { key: "lowercase", label: "小写", ariaLabel: "小写最少数量" },
  { key: "digits", label: "数字", ariaLabel: "数字最少数量" },
  { key: "symbols", label: "符号", ariaLabel: "符号最少数量" }
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
  let settings: FieldGeneratorSettings = normalizeFieldGeneratorSettings(DEFAULT_FIELD_GENERATOR_SETTINGS);
  let mode: FieldGeneratorMode = "SYMBOL";
  let panel: PanelState | undefined;
  let frame = 0;
  let scanTimer = 0;
  let observer: MutationObserver | undefined;

  interface IconHandle {
    host: HTMLElement;
    dispose: () => void;
    /** 相对字段右边缘 / 上边缘的偏移；只在字段尺寸变化或重新扫描时重算。 */
    offset?: { dx: number; dy: number };
    size?: { width: number; height: number };
  }

  interface PanelState {
    host: HTMLElement;
    field: HTMLInputElement;
    scope: ParentNode;
    value: string;
    i18n: ReturnType<typeof createPromptI18n>;
    output: HTMLElement;
    entropy: HTMLElement;
    status: HTMLElement;
    cleanups: Array<() => void>;
    /** 面板控件回填：skip 用来跳过用户正在编辑的那个输入框，避免光标被重置。 */
    controlSyncs: Array<(skip?: Element) => void>;
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
    const handle: IconHandle = { host, dispose: () => { i18n.dispose(); host.remove(); } };
    icons.set(field, handle);
    positionIcon(field, handle, true);
  }

  /** 落点上是否压着站点自己的可交互元素（排除我们挂的图标与面板）。 */
  function siteControlAt(x: number, y: number, host: HTMLElement): boolean {
    const fromPoint = (rootDocument as Document & { elementsFromPoint?: (x: number, y: number) => Element[] }).elementsFromPoint;
    // JSDOM 没有布局，也就没有命中测试；拿不到就当作空位。
    if (typeof fromPoint !== "function") return false;
    for (const node of fromPoint.call(rootDocument, x, y)) {
      if (node === host || node.hasAttribute(GENERATOR_ICON_ATTRIBUTE) || node.id === GENERATOR_PANEL_HOST_ID) continue;
      if (node === rootDocument.documentElement || node === rootDocument.body) continue;
      if (node.closest("button, a[href], input, select, textarea, label, [role='button'], [role='link'], [role='checkbox'], [role='switch'], [tabindex]:not([tabindex='-1'])")) return true;
      if (node instanceof view.HTMLElement && view.getComputedStyle(node).cursor === "pointer") return true;
    }
    return false;
  }

  function spotIsFree(left: number, top: number, host: HTMLElement): boolean {
    const middle = top + ICON_SIZE / 2;
    return !siteControlAt(left + 2, middle, host)
      && !siteControlAt(left + ICON_SIZE - 2, middle, host)
      && !siteControlAt(left + ICON_SIZE / 2, top + 2, host)
      && !siteControlAt(left + ICON_SIZE / 2, top + ICON_SIZE - 2, host);
  }

  /**
   * 站点经常把「显示密码」「下一步」这类按钮放在字段内部右侧，所以图标不再画在字段里：
   * 候选落点依次是字段右侧、右上、右下，逐个做命中测试，落点上压着站点控件就换下一个。
   * 右上/右下会对齐到字段右边缘，并夹进视口 —— 字段铺满整个宽度时靠这个才能留在屏幕上。
   */
  function chooseIconOffset(rect: { right: number; top: number; bottom: number; height: number }, host: HTMLElement): { dx: number; dy: number } {
    const maxLeft = Math.max(2, view.innerWidth - ICON_SIZE - 2);
    const maxTop = Math.max(2, view.innerHeight - ICON_SIZE - 2);
    const anchoredLeft = Math.max(2, Math.min(rect.right - ICON_SIZE, maxLeft));
    const candidates = [
      { left: rect.right + ICON_GAP, top: Math.round(rect.top + (rect.height - ICON_SIZE) / 2) },
      { left: anchoredLeft, top: Math.round(rect.top - ICON_SIZE - 4) },
      { left: anchoredLeft, top: Math.round(rect.bottom + 4) }
    ];
    const fits = ({ left, top }: { left: number; top: number }) => left >= 2 && top >= 2 && left <= maxLeft && top <= maxTop;
    const chosen = candidates.find((candidate) => fits(candidate) && spotIsFree(candidate.left, candidate.top, host))
      ?? candidates.find(fits)
      // 视口小到三个落点都放不下时的兼底：留在字段上边缘、至少不跑到屏幕外。
      ?? { left: anchoredLeft, top: Math.max(2, Math.min(Math.round(rect.top), maxTop)) };
    return { dx: chosen.left - rect.right, dy: chosen.top - rect.top };
  }

  function positionIcon(field: HTMLInputElement, handle: IconHandle, force = false): void {
    const rect = field.getBoundingClientRect();
    const onScreen = field.isConnected && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < view.innerHeight;
    setImportant(handle.host, "visibility", onScreen ? "visible" : "hidden");
    if (!onScreen) return;
    // 滚动时字段尺寸不变，直接复用上次算好的偏移，不再做命中测试。
    if (force || !handle.offset || handle.size?.width !== rect.width || handle.size?.height !== rect.height) {
      handle.size = { width: rect.width, height: rect.height };
      handle.offset = chooseIconOffset(rect, handle.host);
    }
    setImportant(handle.host, "left", `${Math.round(rect.right + handle.offset.dx)}px`);
    setImportant(handle.host, "top", `${Math.round(rect.top + handle.offset.dy)}px`);
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
      for (const [field, handle] of icons) positionIcon(field, handle);
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
    // 站点可能刚插入/移除了字段里的按钮，重新做一次落点判定。
    for (const [field, handle] of icons) positionIcon(field, handle, true);
  }

  function scheduleScan(delay = 0): void {
    if (disposed || !enabled || scanTimer) return;
    scanTimer = view.setTimeout(() => { scanTimer = 0; if (rootDocument.visibilityState !== "hidden") scan(); }, delay);
  }

  /** 任何长度或最少数量改动都走这里：夹紧、保存、重新生成，并同步面板控件。 */
  function applySettings(next: FieldGeneratorSettings, skip?: Element): void {
    settings = next;
    persistSettings();
    if (!panel) return;
    panel.value = generate();
    renderResult();
    for (const sync of panel.controlSyncs) sync(skip);
  }

  function commitLength(value: number, skip?: Element): void {
    applySettings(applyFieldGeneratorLength(settings, mode, value), skip);
  }

  function commitMinimum(key: keyof GeneratorMinimums, value: number, skip?: Element): void {
    const next = applyFieldGeneratorMinimum(settings, key, value);
    // 全为 0 时没有任何可用字符：保留原值并提示，否则生成器会直接报错。
    if (next === settings) {
      setStatus(tr('至少保留一种字符类型。'), "error");
      if (panel) for (const sync of panel.controlSyncs) sync(skip);
      return;
    }
    applySettings(next, skip);
  }

  function setMode(next: FieldGeneratorMode): void {
    mode = next;
    persistMode();
    if (panel) { panel.value = generate(); renderResult(); for (const sync of panel.controlSyncs) sync(); }
  }

  function persistSettings(): void {
    void chrome.storage.local.set({ [SETTINGS_KEY]: settings }).catch(() => undefined);
  }

  function persistMode(): void {
    void chrome.storage.local.set({ [MODE_KEY]: mode }).catch(() => undefined);
  }

  function generate(): string {
    return generateFromFieldSettings(settings, mode);
  }

  function renderResult(): void {
    const current = panel;
    if (!current) return;
    // 结果始终明文：用户必须核对生成的密码是否符合偏好。
    current.output.textContent = current.value;
    current.i18n.text(current.entropy, () => tr('约 {0} bit', { 0: passwordStrengthBits(current.value) }));
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

    // 长度框：总位数由它决定，标签和范围随模式变化（PIN 是位数，短语是单词数）。
    const lengthRow = element("div", "count-row single");
    const lengthField = element("label", "count-field");
    const lengthCaption = element("span", "");
    const lengthInput = rootDocument.createElement("input");
    lengthInput.type = "number";
    lengthInput.step = "1";
    lengthInput.inputMode = "numeric";
    lengthField.append(lengthCaption, lengthInput);
    lengthRow.append(lengthField);

    // 最少数量：只对「密码」模式生效，0 表示完全不使用该类型，其余位数随机填充。
    const minimumGroup = element("div", "count-group");
    const minimumCaption = element("span", "count-caption");
    i18n.text(minimumCaption, () => tr('最少数量'));
    const minimumRow = element("div", "count-row");
    const minimumInputs: Array<{ key: keyof GeneratorMinimums; input: HTMLInputElement }> = [];
    for (const { key, label, ariaLabel } of MINIMUM_LABELS) {
      const minimumField = element("label", "count-field");
      const caption = element("span", "");
      i18n.text(caption, () => tr(label));
      const input = rootDocument.createElement("input");
      input.type = "number";
      input.min = "0";
      input.max = String(FIELD_GENERATOR_LENGTH_RANGE.SYMBOL.maximum);
      input.step = "1";
      input.inputMode = "numeric";
      input.setAttribute("data-minimum", key);
      i18n.attribute(input, "aria-label", () => tr(ariaLabel));
      minimumField.append(caption, input);
      minimumInputs.push({ key, input });
      minimumRow.append(minimumField);
    }
    minimumGroup.append(minimumCaption, minimumRow);

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

    surface.append(head, result, modeBar, lengthRow, minimumGroup, actions, status);
    shadow.append(style, surface);
    rootDocument.documentElement.append(host);

    const cleanups: Array<() => void> = [() => i18n.dispose(), () => host.remove()];
    const controlSyncs: Array<(skip?: Element) => void> = [];
    panel = {
      host, field, scope,
      value: generate(),
      i18n, output, entropy, status,
      cleanups, controlSyncs
    };

    for (const [candidate, button] of modeButtons) {
      button.addEventListener("click", event => {
        if (!event.isTrusted || !panel || mode === candidate) return;
        setMode(candidate);
        for (const [entry, control] of modeButtons) control.setAttribute("aria-pressed", String(entry === candidate));
      });
    }

    // 输入过程中即时重生成（点「填充」前不会失焦，change 可能不触发），但不要回写用户正在编辑的输入框。
    const bindNumberInput = (input: HTMLInputElement, commit: (value: number, skip?: Element) => void) => {
      input.addEventListener("input", () => {
        const parsed = Number(input.value);
        if (input.value.trim() === "" || !Number.isFinite(parsed)) return;
        commit(parsed, input);
      });
      input.addEventListener("change", () => commit(Number(input.value)));
    };
    bindNumberInput(lengthInput, (value, skip) => commitLength(value, skip));
    for (const { key, input } of minimumInputs) bindNumberInput(input, (value, skip) => commitMinimum(key, value, skip));

    controlSyncs.push((skip?: Element) => {
      const range = FIELD_GENERATOR_LENGTH_RANGE[mode];
      // 重新登记一次，模式切换时标签和 aria 名称要立刻跟着换。
      i18n.text(lengthCaption, () => tr(MODE_LENGTH_LABELS[mode]));
      i18n.attribute(lengthInput, "aria-label", () => tr(MODE_LENGTH_LABELS[mode]));
      lengthInput.min = String(range.minimum);
      lengthInput.max = String(range.maximum);
      if (lengthInput !== skip) lengthInput.value = String(settings.lengths[mode]);
      minimumGroup.classList.toggle("is-hidden", mode !== "SYMBOL");
      for (const { key, input } of minimumInputs) {
        if (input !== skip) input.value = String(settings.minimums[key]);
      }
    });

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

    // 只有面板按钮需要阻止默认行为来保留页面字段焦点；数字框和结果文本必须保留聚焦、选择与原生步进。
    surface.addEventListener("pointerdown", event => {
      if (!event.isTrusted || event.button !== 0) return;
      const target = event.composedPath()[0];
      if (target instanceof view.HTMLElement && target.closest("button")) event.preventDefault();
    });

    for (const sync of controlSyncs) sync();
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
    let regenerated = false;
    if (changes[SETTINGS_KEY]?.newValue) {
      const next = normalizeFieldGeneratorSettings(changes[SETTINGS_KEY].newValue);
      // 面板自己写回的设置也会触发这里：值没变就不要重算，否则会打断正在输入的用户。
      if (JSON.stringify(next) !== JSON.stringify(settings)) { settings = next; regenerated = true; }
    }
    if (isFieldGeneratorMode(changes[MODE_KEY]?.newValue) && changes[MODE_KEY].newValue !== mode) {
      mode = changes[MODE_KEY].newValue as FieldGeneratorMode;
      regenerated = true;
    }
    if (regenerated && panel) {
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
    chrome.storage.local.get([SETTINGS_KEY, LEGACY_COUNTS_KEY, MODE_KEY]),
    readInlineAutofillEnabled(),
    initializeUiLocale()
  ]).then(([stored, inlineEnabled]) => {
    if (disposed) return;
    if (stored[SETTINGS_KEY]) {
      settings = normalizeFieldGeneratorSettings(stored[SETTINGS_KEY]);
    } else {
      // 旧版只存了四类数量：迁移成「长度 + 最少数量」并写回，避免每次重新推算。
      const migrated = fieldGeneratorSettingsFromCounts(stored[LEGACY_COUNTS_KEY]);
      if (migrated) {
        settings = migrated;
        void chrome.storage.local.set({ [SETTINGS_KEY]: migrated }).catch(() => undefined);
      }
    }
    if (isFieldGeneratorMode(stored[MODE_KEY])) mode = stored[MODE_KEY];
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
