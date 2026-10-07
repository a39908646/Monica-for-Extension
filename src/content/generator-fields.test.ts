import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { generatorMirrorFields, generatorPasswordFields, generatorScopes, shouldOfferPasswordGenerator } from "./generator-fields";

function scopeOf(html: string, url = "https://accounts.example.com/reg") {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  const prototype = dom.window.HTMLElement.prototype;
  // display:none 的元素在真实浏览器里 rect 全为 0，这里按 id 模拟，便于验证可见性过滤。
  prototype.getBoundingClientRect = function (this: HTMLElement) {
    return this.id === "hidden"
      ? { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }
      : { left: 10, right: 310, top: 10, bottom: 54, width: 300, height: 44, x: 10, y: 10, toJSON() {} };
  };
  Object.defineProperty(prototype, "checkVisibility", { configurable: true, value: () => true });
  return { dom, form: dom.window.document.querySelector("form")! };
}

const signupForm = `<form id="register-form"><input id="email" type="text" autocomplete="email">
  <input id="password" type="password" autocomplete="new-password"><input id="confirm" type="password" autocomplete="new-password"></form>`;

describe("password generator offer policy", () => {
  it("offers the generator on a registration form", () => {
    const { dom, form } = scopeOf(signupForm);
    expect(shouldOfferPasswordGenerator(form)).toBe(true);
    expect(generatorPasswordFields(form, dom.window.document).map((input) => input.id)).toEqual(["password", "confirm"]);
  });

  it("does not offer the generator on a plain login form", () => {
    const { dom, form } = scopeOf('<form id="login-form"><input type="text" id="user_login"><input type="password" id="user_password"></form>', "https://accounts.example.com/login");
    expect(shouldOfferPasswordGenerator(form)).toBe(false);
    expect(generatorPasswordFields(form, dom.window.document)).toEqual([]);
  });

  it("ignores an identifier that a site mislabels as new-password", () => {
    // 镜像 Android StrongPasswordSuggestionPolicy：单框 new-password + 一个普通密码框时不上生成器。
    const { dom, form } = scopeOf('<form><input type="text" id="user" autocomplete="new-password"><input type="password" id="password"></form>');
    expect(shouldOfferPasswordGenerator(form)).toBe(false);
    expect(generatorPasswordFields(form, dom.window.document)).toEqual([]);
  });

  it("offers the generator on a change-password form with both new fields", () => {
    const { dom, form } = scopeOf('<form id="changePassword"><input type="password" id="current" autocomplete="current-password"><input type="password" id="password" autocomplete="new-password"><input type="password" id="confirm" autocomplete="new-password"></form>');
    expect(shouldOfferPasswordGenerator(form)).toBe(true);
    expect(generatorPasswordFields(form, dom.window.document).map((input) => input.id)).toEqual(["password", "confirm"]);
  });

  it("offers the generator for a single new-password field without a current password", () => {
    const { dom, form } = scopeOf('<form><input type="text" id="email" autocomplete="email"><input type="password" id="password" autocomplete="new-password"></form>');
    expect(shouldOfferPasswordGenerator(form)).toBe(true);
    expect(generatorPasswordFields(form, dom.window.document).map((input) => input.id)).toEqual(["password"]);
  });

  it("skips invisible or disabled fields", () => {
    const { dom, form } = scopeOf('<form id="register-form"><input id="password" type="password" autocomplete="new-password"><input id="confirm" type="password" autocomplete="new-password"><input id="hidden" type="password" autocomplete="new-password" style="display:none"></form>');
    const fields = generatorPasswordFields(form, dom.window.document).map((input) => input.id);
    expect(fields).not.toContain("hidden");
    expect(fields).toEqual(["password", "confirm"]);
    dom.window.document.getElementById("confirm")!.setAttribute("disabled", "");
    expect(generatorPasswordFields(form, dom.window.document).map((input) => input.id)).toEqual(["password"]);
  });

  it("mirrors the confirmation field only while it is empty or identical", () => {
    const { dom, form } = scopeOf(signupForm);
    const password = dom.window.document.getElementById("password") as HTMLInputElement;
    const confirm = dom.window.document.getElementById("confirm") as HTMLInputElement;
    expect(generatorMirrorFields(form, password, dom.window.document).map((input) => input.id)).toEqual(["confirm"]);
    password.value = "typed";
    confirm.value = "typed";
    expect(generatorMirrorFields(form, password, dom.window.document).map((input) => input.id)).toEqual(["confirm"]);
    confirm.value = "written-by-someone-else";
    expect(generatorMirrorFields(form, password, dom.window.document)).toEqual([]);
  });

  it("lists the scopes that need the generator", () => {
    const dom = new JSDOM(`<!doctype html><body>${signupForm}<form id="login-form"><input type="password"></form></body>`, { url: "https://accounts.example.com/reg", pretendToBeVisual: true });
    const scopes = generatorScopes(dom.window.document);
    expect(scopes.map((scope) => (scope as Element).id)).toEqual(["register-form"]);
  });
});
