import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { captureCredentialInput, captureRootForEvent } from "./credential-capture";

function page(html: string) {
  return new JSDOM(html, { url: "https://accounts.example.com/login", pretendToBeVisual: true });
}

describe("credential submit capture", () => {
  it("captures a standard login form", () => {
    const dom = page('<title>Example</title><form id="login"><input type="email" value="joy@example.com"><input type="password" autocomplete="current-password" value="secret"></form>');
    const form = dom.window.document.querySelector("form")!;
    expect(captureCredentialInput(form, dom.window.document, dom.window.location)).toEqual({
      username: "joy@example.com",
      password: "secret",
      pageUrl: "https://accounts.example.com/login",
      pageTitle: "Example",
      captureKind: "login"
    });
  });

  it("chooses the confirmed new password on password-change forms", () => {
    const dom = page(`<form><input autocomplete="username" value="joy"><input type="password" autocomplete="current-password" value="old">
      <input type="password" autocomplete="new-password" value="new-secret"><input type="password" autocomplete="new-password" value="new-secret"></form>`);
    expect(captureCredentialInput(dom.window.document.querySelector("form")!, dom.window.document, dom.window.location)).toMatchObject({ username: "joy", password: "new-secret", captureKind: "password-change" });
  });

  it("supports button-driven SPA forms and ignores empty passwords", () => {
    const dom = page('<form><input id="user" value="joy"><input type="password" value=""><button id="login">Login</button></form>');
    const button = dom.window.document.querySelector("button")!;
    expect(captureRootForEvent(button, dom.window.document)).toBe(button.closest("form"));
    expect(captureCredentialInput(button.closest("form")!, dom.window.document, dom.window.location)).toBeNull();
  });

  it("tells the ghpym-shaped register form apart from its login form", () => {
    const login = new JSDOM('<form id="login-form" class="member-form j-member-form" method="post"><input type="text" id="user_login" name="user_login" placeholder="请输入用户名/电子邮箱" value="joy@example.com"><input type="password" id="user_password" name="user_password" placeholder="请输入登录密码" value="login-secret"><a class="member-form-forgot" href="/losspass">忘记密码？</a><button type="submit">登录</button></form>', { url: "https://www.ghxi.com/login", pretendToBeVisual: true });
    expect(captureCredentialInput(login.window.document.querySelector("form")!, login.window.document, login.window.location)).toMatchObject({
      username: "joy@example.com", password: "login-secret", captureKind: "login"
    });
    const register = new JSDOM('<form id="register-form" class="member-form j-member-form" method="post"><input type="text" id="user_email" name="user_email" placeholder="请输入电子邮箱" value="new@example.com"><input type="password" id="user_pass" name="user_pass" placeholder="请输入登录密码" value="brand-new"><input type="password" id="user_pass2" name="user_pass2" placeholder="请确认登录密码" value="brand-new"><button type="submit">提交注册</button></form>', { url: "https://www.ghxi.com/reg", pretendToBeVisual: true });
    expect(captureCredentialInput(register.window.document.querySelector("form")!, register.window.document, register.window.location)).toMatchObject({
      username: "new@example.com", password: "brand-new", captureKind: "signup"
    });
  });

  it("captures phone-number usernames used by mobile login forms", () => {
    const dom = page('<form><label>手机号码<input type="tel" value="13800000000"></label><input type="password" value="secret"></form>');
    expect(captureCredentialInput(dom.window.document.querySelector("form")!, dom.window.document, dom.window.location)).toMatchObject({ username: "13800000000", password: "secret" });
  });

  it("does not treat a masked OTP as a password candidate", () => {
    const dom = page('<form><input autocomplete="username" value="joy"><input type="password" autocomplete="one-time-code" value="123456"></form>');
    expect(captureCredentialInput(dom.window.document.querySelector("form")!, dom.window.document, dom.window.location)).toBeNull();
  });

  it("does not capture a masked verification_code as the submitted password", () => {
    const dom = page('<form><input autocomplete="username" value="joy"><input type="password" name="verification_code" inputmode="numeric" maxlength="6" value="123456"></form>');
    expect(captureCredentialInput(dom.window.document.querySelector("form")!, dom.window.document, dom.window.location)).toBeNull();
  });

  it("marks an unannotated two-password registration form as a signup capture", () => {
    const dom = page('<form id="register"><input autocomplete="username" value="joy"><input type="password" value="new-secret"><input type="password" value="new-secret"></form>');
    expect(captureCredentialInput(dom.window.document.querySelector("form")!, dom.window.document, dom.window.location)).toMatchObject({ password: "new-secret", captureKind: "signup" });
  });

  it("keeps password resets on the password-change kind so they update the stored login", () => {
    const dom = new JSDOM('<form action="/reset-password"><input type="password" value="new-secret"><input type="password" value="new-secret"></form>', { url: "https://accounts.example.com/reset-password", pretendToBeVisual: true });
    expect(captureCredentialInput(dom.window.document.querySelector("form")!, dom.window.document, dom.window.location)).toMatchObject({ password: "new-secret", captureKind: "password-change" });
  });

  it("ignores passwords filled with mask bullets left by captcha refresh or form reset", () => {
    const dom = page('<form><input autocomplete="username" value="joy"><input type="password" value="\u25cf\u25cf\u25cf\u25cf\u25cf\u25cf\u25cf\u25cf"></form>');
    expect(captureCredentialInput(dom.window.document.querySelector("form")!, dom.window.document, dom.window.location)).toBeNull();
  });

  it("keeps short asterisk-free passwords and short real passwords", () => {
    const dom = page('<form><input autocomplete="username" value="joy"><input type="password" value="a*b"></form>');
    expect(captureCredentialInput(dom.window.document.querySelector("form")!, dom.window.document, dom.window.location)).toMatchObject({ password: "a*b" });
  });
});
