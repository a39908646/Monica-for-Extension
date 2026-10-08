import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORD_PASSWORD_WORDS } from "../core/credential-generator";
import { GENERATOR_ICON_ATTRIBUTE, GENERATOR_PANEL_HOST_ID, installPasswordGenerator } from "./generator-menu";

vi.mock("../i18n/runtime", () => ({
  tr: (source: string, params?: Record<string, unknown>) =>
    params ? source.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`)) : source,
  getUiLocale: () => "en",
  initializeUiLocale: async () => undefined,
  observeUiLocale: () => () => undefined
}));

const COUNTS_KEY = "monica.generator.counts";
const SETTINGS_KEY = "monica.generator.settings";
const MODE_KEY = "monica.generator.mode";
const ENABLED_KEY = "monica.autofill.inline.enabled";

let dom: JSDOM;
let controller: ReturnType<typeof installPasswordGenerator>;
let roots: ShadowRoot[];
let storage: Record<string, unknown>;
let changed: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;

const registrationPage = `<!doctype html><html><body><form id="register-form">
  <input id="email" type="email" autocomplete="email">
  <input id="password" type="password" autocomplete="new-password">
  <input id="confirm" type="password" autocomplete="new-password">
</form></body></html>`;

const loginPage = `<!doctype html><html><body><form id="login-form">
  <input id="user_login" type="text" autocomplete="username">
  <input id="user_password" type="password" autocomplete="current-password">
</form></body></html>`;

function field(id: string): HTMLInputElement {
  return dom.window.document.getElementById(id) as HTMLInputElement;
}

function iconHosts(): HTMLElement[] {
  return [...dom.window.document.querySelectorAll<HTMLElement>(`[${GENERATOR_ICON_ATTRIBUTE}]`)];
}

function panelRoot(): ShadowRoot | undefined {
  return roots.find((root) => (root.host as unknown as HTMLElement).id === GENERATOR_PANEL_HOST_ID);
}

function panelHosts(): HTMLElement[] {
  return [...dom.window.document.querySelectorAll<HTMLElement>(`#${GENERATOR_PANEL_HOST_ID}`)];
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text)!;
}

/** jsdom 的 dispatchEvent 无条件把 isTrusted 置 false；绕过包装层直接调用 impl 伪造受信点击。 */
function trustedClick(element: Element): void {
  const implSymbol = Object.getOwnPropertySymbols(element)[0];
  const event = new dom.window.MouseEvent("click", { bubbles: true });
  const eventImpl = (event as unknown as Record<symbol, { isTrusted: boolean }>)[Object.getOwnPropertySymbols(event)[0]];
  eventImpl.isTrusted = true;
  (element as unknown as Record<symbol, { _dispatch: (impl: unknown) => void }>)[implSymbol]._dispatch(eventImpl);
}

/** 同样的手法伪造受信的 pointerdown，用来断言面板没有阻止输入框的默认行为。 */
function trustedPointerDown(element: Element): boolean {
  const implSymbol = Object.getOwnPropertySymbols(element)[0];
  const event = new dom.window.MouseEvent("pointerdown", { bubbles: true, composed: true, cancelable: true, button: 0 });
  const eventImpl = (event as unknown as Record<symbol, { isTrusted: boolean }>)[Object.getOwnPropertySymbols(event)[0]];
  eventImpl.isTrusted = true;
  (element as unknown as Record<symbol, { _dispatch: (impl: unknown) => void }>)[implSymbol]._dispatch(eventImpl);
  return event.defaultPrevented;
}

function lengthInput(panel: ShadowRoot): HTMLInputElement {
  return panel.querySelector<HTMLInputElement>(".count-row.single input[type='number']")!;
}

function minimumInput(panel: ShadowRoot, key: string): HTMLInputElement {
  return panel.querySelector<HTMLInputElement>(`input[data-minimum="${key}"]`)!;
}

function minimumGroup(panel: ShadowRoot): HTMLElement {
  return panel.querySelector<HTMLElement>(".count-group")!;
}

function lengthCaption(panel: ShadowRoot): string {
  return panel.querySelector(".count-row.single .count-field > span")?.textContent || "";
}

/** 模拟用户在数字框里输入：默认只派发 input（真实点击「填充」前不会失焦，change 不会触发）。 */
function typeNumber(input: HTMLInputElement, value: string, kind: "input" | "change" = "input"): void {
  input.value = value;
  input.dispatchEvent(new dom.window.Event(kind, { bubbles: true }));
}

async function openPanel(): Promise<ShadowRoot> {
  await vi.waitFor(() => expect(iconHosts()).toHaveLength(2));
  const trigger = roots[0].querySelector<HTMLButtonElement>(".trigger")!;
  trustedClick(trigger);
  await vi.waitFor(() => expect(panelRoot()).toBeTruthy());
  return panelRoot()!;
}

function generatedValue(panel: ShadowRoot): string {
  return panel.querySelector("code")!.textContent || "";
}

beforeEach(() => {
  dom = new JSDOM(registrationPage, { url: "https://accounts.example.test/register", pretendToBeVisual: true });
  const prototype = dom.window.HTMLElement.prototype;
  vi.spyOn(prototype, "getBoundingClientRect").mockReturnValue({ left: 100, right: 400, top: 100, bottom: 144, width: 300, height: 44, x: 100, y: 100, toJSON() {} });
  Object.defineProperty(prototype, "checkVisibility", { configurable: true, value: () => true });
  roots = [];
  const attach = prototype.attachShadow;
  vi.spyOn(prototype, "attachShadow").mockImplementation(function (this: HTMLElement, options: ShadowRootInit) {
    const root = attach.call(this, options);
    roots.push(root);
    return root;
  });
  storage = {};
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    storage: {
      local: {
        get: vi.fn(async (key: string | string[]) => {
          const keys = typeof key === "string" ? [key] : key;
          const result: Record<string, unknown> = {};
          for (const k of keys) result[k] = storage[k];
          return result;
        }),
        set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(storage, values); })
      },
      onChanged: { addListener: vi.fn((listener: typeof changed) => { changed = listener; }), removeListener: vi.fn() }
    }
  });
  controller = installPasswordGenerator(dom.window.document);
});

afterEach(() => {
  controller.dispose();
  dom.window.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("in-field password generator", () => {
  it("attaches one icon per new-password field and none on a login form", async () => {
    await vi.waitFor(() => expect(iconHosts()).toHaveLength(2));
    expect(iconHosts().map((host) => host.style.visibility)).toEqual(["visible", "visible"]);

    dom.window.document.body.innerHTML = loginPage.replace(/^<!doctype html><html><body>|<\/body><\/html>$/g, "");
    field("user_password").dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }));
    await vi.waitFor(() => expect(iconHosts()).toHaveLength(0));
  });

  it("keeps the generator icon outside the field so site controls stay clickable", async () => {
    await vi.waitFor(() => expect(iconHosts()).toHaveLength(2));
    // 字段矩形固定为 left:100 right:400 top:100 bottom:144（见 beforeEach 里的 mock）。
    // 图标必须整个落在字段外面，否则会盖住站点自己的「显示密码」「下一步」按钮。
    for (const host of iconHosts()) {
      const left = Number.parseFloat(host.style.left);
      const top = Number.parseFloat(host.style.top);
      expect(left).toBeGreaterThanOrEqual(400);
      expect(top).toBeGreaterThanOrEqual(100);
      expect(top + 26).toBeLessThanOrEqual(144);
    }
  });

  it("moves the icon when the site already occupies the spot beside the field", async () => {
    await vi.waitFor(() => expect(iconHosts()).toHaveLength(2));
    const document = dom.window.document;
    const blocker = document.createElement("button");
    document.body.append(blocker);
    // 只把字段右侧那一列判为被占用，模拟站点自己放在那里的按钮。
    document.elementsFromPoint = (x: number) => (x > 400 ? [blocker] : []);
    controller.scan();
    await vi.waitFor(() => {
      for (const host of iconHosts()) {
        // 退到右上角：完全离开字段矩形（right=400 / top=100）。
        expect(Number.parseFloat(host.style.left) + 26).toBeLessThanOrEqual(400);
        expect(Number.parseFloat(host.style.top) + 26).toBeLessThanOrEqual(100);
      }
    });
  });

  it("opens a panel with a plaintext password and fills both password fields", async () => {
    const panel = await openPanel();
    const output = panel.querySelector("code")!;
    const first = generatedValue(panel);
    // 结果始终明文；默认总长度 20，最少数量只保证下限。
    expect(first).toMatch(/^[A-Za-z0-9!@#$%^&*()_+\-=[\]{}|;:,.<>?]{20}$/);
    expect(output.textContent).toBe(first);

    trustedClick(buttonByText(panel, "重新生成"));
    const second = generatedValue(panel);
    expect(second).not.toBe(first);

    const events = { password: 0, confirm: 0 };
    for (const id of ["password", "confirm"] as const) {
      field(id).addEventListener("input", () => { events[id] += 1; });
      field(id).addEventListener("change", () => { events[id] += 1; });
    }
    trustedClick(buttonByText(panel, "填充"));

    expect(field("password").value).toBe(second);
    expect(field("confirm").value).toBe(second);
    expect(events).toEqual({ password: 2, confirm: 2 });
    expect(panel.querySelector(".status")?.textContent).toBe("已填入密码框。");
    expect(dom.window.document.activeElement).toBe(field("password"));
  });

  it("exposes a total length control plus per-type minimums", async () => {
    const panel = await openPanel();
    expect(lengthCaption(panel)).toBe("长度");
    expect(lengthInput(panel).value).toBe("20");
    expect(lengthInput(panel).min).toBe("4");
    expect(lengthInput(panel).max).toBe("64");
    expect(minimumGroup(panel).textContent).toContain("最少数量");
    const inputs = [...minimumGroup(panel).querySelectorAll<HTMLInputElement>("input[type='number']")];
    expect(inputs).toHaveLength(4);
    // 默认每类至少 1 个，其余位数随机补足。
    expect(inputs.map((input) => Number(input.value))).toEqual([1, 1, 1, 1]);
    // 每个数字框都要能被标签、无障碍名称和焦点定位到。
    expect(inputs.map((input) => input.getAttribute("aria-label"))).toEqual(["大写最少数量", "小写最少数量", "数字最少数量", "符号最少数量"]);
  });

  it("keeps number inputs interactive and only blocks the panel buttons from stealing field focus", async () => {
    const panel = await openPanel();
    // 回归：曾经整块面板都阻止 pointerdown，导致数字框无法聚焦、无法选中、原生步进按钮失效。
    expect(trustedPointerDown(lengthInput(panel))).toBe(false);
    expect(trustedPointerDown(minimumInput(panel, "lowercase"))).toBe(false);
    expect(trustedPointerDown(buttonByText(panel, "填充"))).toBe(true);
  });

  it("uses the length for the total and keeps the minimums as a lower bound", async () => {
    const panel = await openPanel();
    typeNumber(lengthInput(panel), "12");
    expect(generatedValue(panel)).toHaveLength(12);
    expect(lengthInput(panel).value).toBe("12");

    // 每类下限只有 1 个：大写个数不应该总是 1（否则说明构成被写死了）。
    const uppercaseCounts = Array.from({ length: 10 }, () => {
      trustedClick(buttonByText(panel, "重新生成"));
      return [...generatedValue(panel)].filter((character) => /[A-Z]/.test(character)).length;
    });
    expect(Math.max(...uppercaseCounts)).toBeGreaterThan(1);
  });

  it("regenerates while typing a length and fills the fresh value without blurring", async () => {
    const panel = await openPanel();
    // 只有 input 事件（模拟还在输入框里打字，没有失焦）。
    typeNumber(lengthInput(panel), "8");
    expect(lengthInput(panel).value).toBe("8");
    expect(generatedValue(panel)).toHaveLength(8);

    // 点「填充」时不会失焦，所以必须已经用新长度生成结果。
    trustedClick(buttonByText(panel, "填充"));
    expect(field("password").value).toBe(generatedValue(panel));
    expect(field("password").value).toHaveLength(8);
  });

  it("raises the length to fit the minimums and refuses to go below them", async () => {
    const panel = await openPanel();
    typeNumber(minimumInput(panel, "uppercase"), "32", "change");
    // 1 + 1 + 1 + 32 = 35，长度必须抬到 35。
    expect(lengthInput(panel).value).toBe("35");
    expect(generatedValue(panel)).toHaveLength(35);

    typeNumber(lengthInput(panel), "10", "change");
    expect(lengthInput(panel).value).toBe("35");
    expect(generatedValue(panel)).toHaveLength(35);
  });

  it("excludes a type with minimum 0 but keeps at least one type enabled", async () => {
    const panel = await openPanel();
    typeNumber(minimumInput(panel, "symbols"), "0", "change");
    expect(generatedValue(panel)).toMatch(/^[A-Za-z0-9]{20}$/);

    // 把剩下三类也改成 0：最后一次会被拒绝，面板保留原值并提示。
    for (const key of ["uppercase", "lowercase"]) typeNumber(minimumInput(panel, key), "0", "change");
    typeNumber(minimumInput(panel, "digits"), "0", "change");
    expect(minimumInput(panel, "digits").value).toBe("1");
    expect(generatedValue(panel)).toMatch(/^[a-z0-9]{20}$/);
    expect(panel.querySelector(".status")?.textContent).toBe("至少保留一种字符类型。");
  });

  it("switches modes with their own length, range and controls", async () => {
    const panel = await openPanel();
    trustedClick(buttonByText(panel, "PIN"));
    await vi.waitFor(() => expect(storage[MODE_KEY]).toBe("PIN"));
    expect(lengthCaption(panel)).toBe("PIN 长度");
    expect(lengthInput(panel).value).toBe("6");
    expect(lengthInput(panel).min).toBe("4");
    expect(lengthInput(panel).max).toBe("32");
    expect(minimumGroup(panel).classList.contains("is-hidden")).toBe(true);
    expect(generatedValue(panel)).toMatch(/^[0-9]{6}$/);

    trustedClick(buttonByText(panel, "短语"));
    await vi.waitFor(() => expect(lengthCaption(panel)).toBe("单词数"));
    expect(lengthInput(panel).value).toBe("4");
    expect(lengthInput(panel).min).toBe("2");
    expect(generatedValue(panel).split("-")).toHaveLength(4);

    // 「单词」模式修回真正的单词密码（字母 + 补足的数字），不再是随机字符。
    trustedClick(buttonByText(panel, "单词"));
    await vi.waitFor(() => expect(lengthCaption(panel)).toBe("单词密码长度"));
    expect(lengthInput(panel).value).toBe("12");
    const wordPassword = generatedValue(panel);
    expect(wordPassword).toMatch(/^[a-z0-9]{12}$/);
    // 单词密码由词表单词拼成，可能再用数字补足；不再是随机大小写 + 符号。
    expect(DEFAULT_WORD_PASSWORD_WORDS.some((word) => wordPassword.startsWith(word))).toBe(true);

    trustedClick(buttonByText(panel, "密码"));
    await vi.waitFor(() => expect(lengthCaption(panel)).toBe("长度"));
    expect(lengthInput(panel).value).toBe("20");
    expect(minimumGroup(panel).classList.contains("is-hidden")).toBe(false);
  });

  it("persists length and minimum changes", async () => {
    const panel = await openPanel();
    const before = generatedValue(panel);
    typeNumber(lengthInput(panel), "16", "change");
    typeNumber(minimumInput(panel, "symbols"), "0", "change");
    await vi.waitFor(() => {
      const saved = storage[SETTINGS_KEY] as { lengths: { SYMBOL: number }; minimums: { symbols: number } };
      expect(saved.lengths.SYMBOL).toBe(16);
      expect(saved.minimums.symbols).toBe(0);
    });
    expect(generatedValue(panel)).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(before).not.toBe(generatedValue(panel));
  });

  it("migrates the legacy per-type counts into a length plus minimums", async () => {
    controller.dispose();
    storage[COUNTS_KEY] = { uppercase: 2, lowercase: 10, digits: 4, symbols: 3 };
    controller = installPasswordGenerator(dom.window.document);
    const panel = await openPanel();
    // 旧的四类数量当作最少数量，长度取默认 20 与合计 19 的较大值。
    expect(lengthInput(panel).value).toBe("20");
    expect(["uppercase", "lowercase", "digits", "symbols"].map((key) => Number(minimumInput(panel, key).value))).toEqual([2, 10, 4, 3]);
    expect(generatedValue(panel)).toHaveLength(20);
    await vi.waitFor(() => expect((storage[SETTINGS_KEY] as { minimums: { lowercase: number } }).minimums.lowercase).toBe(10));
  });

  it("switches between password and PIN modes and persists the selection", async () => {
    const panel = await openPanel();
    trustedClick(buttonByText(panel, "PIN"));
    await vi.waitFor(() => expect((storage[MODE_KEY] as string)).toBe("PIN"));
    expect(generatedValue(panel)).toMatch(/^[0-9]+$/);

    trustedClick(buttonByText(panel, "密码"));
    await vi.waitFor(() => expect((storage[MODE_KEY] as string)).toBe("SYMBOL"));
    expect(generatedValue(panel).length).toBeGreaterThanOrEqual(4);
  });

  it("removes the icons and closes the panel when the inline preference is switched off", async () => {
    const panel = await openPanel();
    expect(panelHosts()).toHaveLength(1);
    changed({ [ENABLED_KEY]: { newValue: false } }, "local");
    await vi.waitFor(() => expect(iconHosts()).toHaveLength(0));
    expect(panelHosts()).toHaveLength(0);
  });
});
