import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERATOR_ICON_ATTRIBUTE, GENERATOR_PANEL_HOST_ID, installPasswordGenerator } from "./generator-menu";

vi.mock("../i18n/runtime", () => ({
  tr: (source: string, params?: Record<string, unknown>) =>
    params ? source.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`)) : source,
  getUiLocale: () => "en",
  initializeUiLocale: async () => undefined,
  observeUiLocale: () => () => undefined
}));

const COUNTS_KEY = "monica.generator.counts";
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

  it("opens a panel with a plaintext password and fills both password fields", async () => {
    const panel = await openPanel();
    const output = panel.querySelector("code")!;
    const first = generatedValue(panel);
    // 结果始终明文，长度符合 counts 模型（2 大写 + 10 小写 + 4 数字 + 3 符号 = 19）。
    expect(first).toMatch(/^[A-Za-z0-9!@#$%^&*()_+\-=[\]{}|;:,.<>?]{19}$/);
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

  it("exposes count controls for each character type", async () => {
    const panel = await openPanel();
    const options = panel.querySelector(".count-row")!;
    expect(options.textContent).toContain("大写");
    expect(options.textContent).toContain("小写");
    expect(options.textContent).toContain("数字");
    expect(options.textContent).toContain("符号");
    // 默认 counts：2 大写 + 10 小写 + 4 数字 + 3 符号
    const inputs = [...options.querySelectorAll<HTMLInputElement>("input[type='number']")];
    expect(inputs).toHaveLength(4);
    expect(inputs.map((input) => Number(input.value))).toEqual([2, 10, 4, 3]);
  });

  it("persists count changes and regenerates with the new counts", async () => {
    const panel = await openPanel();
    const before = generatedValue(panel);
    // 把数字改为 0，改符号为 0，改大写为 0 → 密码应全为小写字母。
    const inputs = [...panel.querySelectorAll<HTMLInputElement>(".count-row input[type='number']")];
    for (const input of inputs) {
      const key = input.getAttribute("data-count");
      if (key !== "lowercase") {
        input.value = "0";
        input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      }
    }
    await vi.waitFor(() => {
      const value = generatedValue(panel);
      expect(value).toMatch(/^[a-z]+$/);
      expect(value.length).toBe(10);
    });
    expect((storage[COUNTS_KEY] as { lowercase: number }).lowercase).toBe(10);
    expect(before).not.toBe(generatedValue(panel));
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
