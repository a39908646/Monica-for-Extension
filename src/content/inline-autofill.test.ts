import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installInlineAutofill, INLINE_AUTOFILL_HOST_ID } from "./inline-autofill";
import type { InlineAutofillResult } from "../autofill/inline-contract";
import { INLINE_AUTOFILL_ENABLED_KEY } from "../autofill/inline-preferences";

vi.mock("../i18n/runtime", () => ({
  tr: (source: string) => source, getUiLocale: () => "en", initializeUiLocale: async () => undefined, observeUiLocale: () => () => undefined
}));

let dom: JSDOM;
let controller: ReturnType<typeof installInlineAutofill>;
let changed: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
let query: ReturnType<typeof vi.fn<(id: string) => Promise<InlineAutofillResult>>>;
let fill: ReturnType<typeof vi.fn<(sessionId: string, itemId: string) => Promise<unknown>>>;
let openManager: ReturnType<typeof vi.fn<(sessionId: string) => Promise<unknown>>>;
let editItem: ReturnType<typeof vi.fn<(sessionId: string, itemId: string) => Promise<unknown>>>;
let shadow: ShadowRoot | undefined;
const result = (id: string, title = "account"): InlineAutofillResult => ({ sessionId: id, enabled: true, status: "unlocked", total: 1, candidates: [{ id: "item", title, username: "synthetic-user", hasTotp: false, allowLockedAutofill: false }] });
const input = (id = "user") => dom.window.document.getElementById(id) as HTMLInputElement;
const host = () => dom.window.document.getElementById(INLINE_AUTOFILL_HOST_ID);
// jsdom 的 dispatchEvent 会无条件把 isTrusted 置 false（规范行为）；
// 绕过包装层直接调用 impl 的 _dispatch 以伪造受信事件。
const trustedClick = (element: Element): void => {
  const implSymbol = Object.getOwnPropertySymbols(element)[0];
  const event = new dom.window.MouseEvent("click", { bubbles: true });
  const eventImpl = (event as unknown as Record<symbol, { isTrusted: boolean }>)[Object.getOwnPropertySymbols(event)[0]];
  eventImpl.isTrusted = true;
  (element as unknown as Record<symbol, { _dispatch: (impl: unknown) => void }>)[implSymbol]._dispatch(eventImpl);
};

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><form><input id="user" autocomplete="username"><input id="password" type="password" autocomplete="current-password"></form><button id="outside">Outside</button></body></html>', { url: "https://example.test/login", pretendToBeVisual: true });
  const prototype = dom.window.HTMLElement.prototype;
  vi.spyOn(prototype, "getBoundingClientRect").mockReturnValue({ left: 100, right: 400, top: 100, bottom: 144, width: 300, height: 44, x: 100, y: 100, toJSON() {} });
  Object.defineProperty(prototype, "checkVisibility", { configurable: true, value: () => true });
  Object.defineProperty(dom.window, "ResizeObserver", { value: class { observe() {} disconnect() {} } });
  const attach = prototype.attachShadow;
  vi.spyOn(prototype, "attachShadow").mockImplementation(function (this: HTMLElement, options) { shadow = attach.call(this, options); return shadow; });
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` }, storage: {
    local: { get: vi.fn(async () => ({})) },
    onChanged: { addListener: vi.fn(listener => { changed = listener; }), removeListener: vi.fn() }
  } });
  query = vi.fn(async id => result(id));
  fill = vi.fn(async () => undefined);
  openManager = vi.fn(async () => undefined);
  editItem = vi.fn(async () => undefined);
  controller = installInlineAutofill({ query, fill, openManager, editItem }, dom.window.document);
});
afterEach(() => { controller.dispose(); dom.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); shadow = undefined; });

describe("inline menu lifecycle and request boundaries", () => {
  it("queries only with an opaque field session and ignores script-generated selections", async () => {
    input("password").value = "must-not-leave-the-field";
    input("password").focus();
    await vi.waitFor(() => expect(host()).toBeTruthy());
    expect(query.mock.calls[0]).toEqual([expect.stringMatching(/^[a-f0-9-]{36}$/)]);
    expect(JSON.stringify(query.mock.calls)).not.toContain("must-not-leave-the-field");
    (shadow!.querySelector(".suggestion") as HTMLButtonElement).click();
    expect(fill).not.toHaveBeenCalled();
    expect(controller.applyCredential(query.mock.calls[0][0], { password: "unauthorized" })).toMatchObject({ ok: false });
    expect(input("password").value).toBe("must-not-leave-the-field");
  });
  it("discards a delayed response when focus moves away", async () => {
    let release!: (value: InlineAutofillResult) => void;
    query.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    input().focus();
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    dom.window.document.getElementById("outside")!.focus();
    release(result(query.mock.calls[0][0], "stale summary"));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(host()).toBeNull();
    expect(await controller.fieldContext(query.mock.calls[0][0])).toBeUndefined();
  });
  it("discards pending candidates when the switch is disabled and permits a fresh session after re-enabling", async () => {
    let release!: (value: InlineAutofillResult) => void;
    query.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    input().focus();
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    changed({ [INLINE_AUTOFILL_ENABLED_KEY]: { newValue: false } }, "local");
    release(result(query.mock.calls[0][0]));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(host()).toBeNull();
    input("password").focus();
    expect(query).toHaveBeenCalledOnce();
    changed({ [INLINE_AUTOFILL_ENABLED_KEY]: { newValue: true } }, "local");
    input().focus();
    await vi.waitFor(() => expect(host()).toBeTruthy());
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).not.toBe(query.mock.calls[1][0]);
  });
  it("invalidates a pending menu on lock without reopening it after the reply", async () => {
    let release!: (value: InlineAutofillResult) => void;
    query.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    input().focus();
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    controller.dismiss();
    release(result(query.mock.calls[0][0], "unlocked account"));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(host()).toBeNull();
  });
  it("removes the menu when its field disappears and releases observers on disposal", async () => {
    input().focus();
    await vi.waitFor(() => expect(host()).toBeTruthy());
    input().remove();
    await vi.waitFor(() => expect(host()).toBeNull());
    controller.dispose();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledWith(changed);
    input("password").focus();
    expect(query).toHaveBeenCalledOnce();
  });
  it("offers a per-item edit entry when unlocked and opens the manager with that item", async () => {
    input().focus();
    await vi.waitFor(() => expect(host()).toBeTruthy());
    const menu = shadow!;
    expect(menu.querySelector("header")).toBeNull();
    expect(menu.querySelector(".open-manager")).toBeNull();
    const edit = menu.querySelector(".edit") as HTMLButtonElement;
    expect(edit).toBeTruthy();
    expect(edit.textContent).toBeTruthy();
    const fillButton = menu.querySelector(".suggestion") as HTMLButtonElement;
    fillButton.click();
    expect(fill).not.toHaveBeenCalled();
    // act() 要求输入框仍持有焦点（valid() 守卫）；jsdom 合成点击不会走 pointerdown 阻止默认的焦点转移。
    input().focus();
    trustedClick(edit);
    await vi.waitFor(() => expect(editItem).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9-]{36}$/), "item"));
  });
  it("omits the edit entry when locked and keeps only the unlock action", async () => {
    query.mockImplementation(async id => ({ ...result(id), status: "locked" as const }));
    input().focus();
    await vi.waitFor(() => expect(host()).toBeTruthy());
    const menu = shadow!;
    expect(menu.querySelector(".edit")).toBeNull();
    const open = menu.querySelector(".open-manager") as HTMLButtonElement;
    expect(open).toBeTruthy();
    input().focus();
    trustedClick(open);
    await vi.waitFor(() => expect(openManager).toHaveBeenCalledOnce());
  });
});
