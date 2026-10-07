import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { loginPageIntent } from "./login-field-role";

function scopeOf(html: string, url = "https://accounts.example.com/login") {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  return { dom, scope: dom.window.document.querySelector("form") || dom.window.document };
}

describe("login page intent", () => {
  it("reports a plain login form as login", () => {
    const { scope } = scopeOf('<form id="login"><input autocomplete="username"><input type="password" autocomplete="current-password"></form>');
    expect(loginPageIntent(scope)).toBe("login");
  });

  it("reports a registration form as signup", () => {
    const { scope } = scopeOf('<form id="register" action="/register"><input autocomplete="email"><input type="password" autocomplete="new-password"><input type="password" autocomplete="new-password"></form>');
    expect(loginPageIntent(scope)).toBe("signup");
  });

  it("reports an unannotated two-password form as signup instead of password-change", () => {
    // 两步式注册的第二页没有用户名与语义提示：宁可另存为新项，也不默认覆盖旧密码。
    const { scope } = scopeOf('<form><input type="password"><input type="password"></form>', "https://accounts.example.com/step-2");
    expect(loginPageIntent(scope)).toBe("signup");
  });

  it("reports a change-password form as password-change", () => {
    const current = scopeOf('<form><input type="password" autocomplete="current-password"><input type="password" autocomplete="new-password"></form>').scope;
    expect(loginPageIntent(current)).toBe("password-change");
    const hinted = scopeOf('<form id="changePassword"><input type="password"><input type="password"></form>').scope;
    expect(loginPageIntent(hinted)).toBe("password-change");
  });

  it("keeps password resets separate from signups", () => {
    const { scope } = scopeOf('<form action="/reset-password"><input type="password"><input type="password"></form>', "https://accounts.example.com/reset-password");
    expect(loginPageIntent(scope)).toBe("password-reset");
    const forgot = scopeOf('<form id="forgotPassword"><input type="password" autocomplete="new-password"></form>').scope;
    expect(loginPageIntent(forgot)).toBe("password-reset");
  });

  it("prefers the explicit reset wording only when signup wording is absent", () => {
    const { scope } = scopeOf('<form id="register" action="/signup"><input type="password"><input type="password"></form>');
    expect(loginPageIntent(scope)).toBe("signup");
  });

  it("ignores one-time-code fields when judging the form", () => {
    const { scope } = scopeOf('<form><input autocomplete="username"><input type="password" autocomplete="current-password"><input type="password" autocomplete="one-time-code"></form>');
    expect(loginPageIntent(scope)).toBe("login");
  });

  it("keeps the ghpym-shaped login form on login even though it links to 忘记密码", () => {
    const { scope } = scopeOf('<form id="login-form" class="member-form j-member-form" method="post"><label><input type="text" id="user_login" name="user_login" placeholder="请输入用户名/电子邮箱"></label><label><input type="password" id="user_password" name="user_password" placeholder="请输入登录密码"></label><label><input type="checkbox" id="remember"></label><a class="member-form-forgot" href="https://www.ghxi.com/losspass">忘记密码？</a><button type="submit">登录</button></form>', "https://www.ghxi.com/login");
    expect(loginPageIntent(scope)).toBe("login");
  });

  it("recognises the ghpym-shaped register form whose password labels say 登录密码", () => {
    const { scope } = scopeOf('<form id="register-form" class="member-form j-member-form" method="post"><div><label><input type="text" id="user_email" name="user_email" placeholder="请输入电子邮箱"></label></div><div><label><input type="password" id="user_pass" name="user_pass" placeholder="请输入登录密码"></label></div><div><label><input type="password" id="user_pass2" name="user_pass2" placeholder="请确认登录密码"></label></div><button type="submit">提交注册</button></form>', "https://www.ghxi.com/reg");
    expect(loginPageIntent(scope)).toBe("signup");
  });
});
