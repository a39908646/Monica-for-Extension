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

  it("keeps a Discuz-style login form on login whatever the page indentation", () => {
    // 3DM 这类 Discuz 表单把「注册」「找回密码」写成表单内的跳转链接。
    // 旧实现取 form.textContent 前 500 字符：缩进深时只能看到「手机/用户名」，
    // 压成一行时「注册」就落入窗口，判型随排版漂移。链接写的是“去哪儿”，不是表单用途。
    const discuzLogin = (indent: string) => [
      '<form id="loginform_LHB7P" name="login" action="member.php?mod=logging&amp;action=login&amp;loginsubmit=yes">',
      `${indent}<input type="text" name="username" id="username_LHB7P">`,
      `${indent}<input type="password" name="password" id="password3_LHB7P">`,
      `${indent}<a href="member.php?mod=register">注册</a>`,
      `${indent}<a href="javascript:;" title="找回密码">找回密码</a>`,
      `${indent}<button type="submit">登录</button>`,
      '</form>'
    ].join("\n");
    const url = "https://bbs.3dmgame.com/member.php?mod=logging&action=login";
    expect(loginPageIntent(scopeOf(discuzLogin("                                        "), url).scope)).toBe("login");
    expect(loginPageIntent(scopeOf(discuzLogin(""), url).scope)).toBe("login");
  });

  it("reads the surrounding panel heading when the form itself says nothing", () => {
    // 单密码框、表单内没有任何新密码提示：用途写在表单外面的容器标题里。
    const { scope } = scopeOf('<div class="panel"><h2>创建账户</h2><form id="step2" action="/submit"><input type="text" name="user"><input type="password" name="secret"><button type="submit">提交</button></form></div>');
    expect(loginPageIntent(scope)).toBe("signup");
  });

  it("does not borrow the intent of a sibling form on a login/register switch card", () => {
    const { scope } = scopeOf(`<div class="auth-card">
      <h2>账号登录</h2>
      <form id="login-form"><input autocomplete="username"><input type="password"><button type="submit">登录</button></form>
      <form id="signup-form"><h3>注册新账号</h3><input autocomplete="new-password"><input type="password" autocomplete="new-password"><button type="submit">注册</button></form>
    </div>`);
    expect(loginPageIntent(scope)).toBe("login");
  });

  it("still reports a registration panel as signup when the sibling login link is present", () => {
    const { scope } = scopeOf(`<div class="auth-card">
      <h2>注册新账号</h2>
      <form id="signup-form"><input autocomplete="username"><input type="password"><button type="submit">提交</button></form>
      <p>已有账号？<a href="/login">登录</a></p>
    </div>`);
    expect(loginPageIntent(scope)).toBe("signup");
  });

  it("lets the submit control outrank surrounding copy that mentions the other flow", () => {
    // 登录表单旁边写着“还没有账号？注册”很常见；按钮写的才是用户此刻在做的事。
    const { scope } = scopeOf('<form id="login-form"><label>还没有账号？注册</label><input autocomplete="username"><input type="password" autocomplete="new-password"><button type="submit">登录</button></form>', "https://accounts.example.com/login");
    expect(loginPageIntent(scope)).toBe("login");
  });

  it("falls back to the form identity when the submit control is neutral", () => {
    // Discuz 注册页的提交按钮就叫“提交”，只能靠表单自身的属性兜底。
    const { scope } = scopeOf('<form id="registerform" name="register" action="member.php?mod=register"><label>密码:</label><input type="password"><label>确认密码:</label><input type="password"><button type="submit">提交</button></form>', "https://bbs.3dmgame.com/member.php?mod=register");
    expect(loginPageIntent(scope)).toBe("signup");
  });

  it("reads a reset submit control even when the form attributes are generic", () => {
    const { scope } = scopeOf('<form id="step2" action="/submit"><input type="password"><button type="submit">重置密码</button></form>', "https://accounts.example.com/settings");
    expect(loginPageIntent(scope)).toBe("password-reset");
  });

  it("ignores type=button tabs when reading the form purpose", () => {
    // 登录/注册切换卡片：页签是 type=button，不属于表单用途。
    const { scope } = scopeOf(`<div class="auth-card">
      <button type="button">注册</button>
      <form id="step1" action="/submit"><input type="text" name="user"><input type="password" name="secret"><button type="submit">提交</button></form>
    </div>`);
    expect(loginPageIntent(scope)).toBe("login");
  });
});
