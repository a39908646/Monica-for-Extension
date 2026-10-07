import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import type { CredentialCaptureInput } from "../runtime/messages";
import { installCredentialCapture, OPEN_SHADOW_ROOT_EVENT } from "./content-lifecycle";

function page(html = '<main id="app"></main>') {
  return new JSDOM(html, { url: "https://accounts.example.com/login", pretendToBeVisual: true });
}

function click(dom: JSDOM, element: Element): void {
  // 真实点击是可取消的；页面 JS 的 preventDefault 依赖这一点。
  element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));
}

function submit(dom: JSDOM, form: HTMLFormElement): void {
  form.dispatchEvent(new dom.window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
}

async function settle(dom: JSDOM): Promise<void> {
  await new Promise((resolve) => dom.window.setTimeout(resolve, 5));
}

describe("dynamic credential capture lifecycle", () => {
  it("releases removed shadow roots and resumes capture when the same host is reattached", async () => {
    const dom = page();
    const candidates: CredentialCaptureInput[] = [];
    const stop = installCredentialCapture({ rootDocument: dom.window.document, pageLocation: dom.window.location, onCandidate: (candidate) => { candidates.push(candidate); } });
    const host = dom.window.document.createElement("login-shell");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<form><input autocomplete="username" value="returning-user"><input type="password" value="returning-secret"></form>';
    dom.window.document.body.append(host);
    await settle(dom);
    submit(dom, shadow.querySelector("form")!);
    await settle(dom);
    expect(candidates).toHaveLength(1);
    host.remove();
    await settle(dom);
    submit(dom, shadow.querySelector("form")!);
    await settle(dom);
    expect(candidates).toHaveLength(1);
    dom.window.document.body.append(host);
    await settle(dom);
    submit(dom, shadow.querySelector("form")!);
    await settle(dom);
    expect(candidates).toHaveLength(2);
    stop();
    dom.window.close();
  });

  it("captures a form inserted after installation", async () => {
    const dom = page();
    const candidates: CredentialCaptureInput[] = [];
    const stop = installCredentialCapture({ rootDocument: dom.window.document, pageLocation: dom.window.location, onCandidate: (candidate) => { candidates.push(candidate); } });
    dom.window.document.querySelector("#app")!.innerHTML = '<form><input autocomplete="username" value="late-user"><input type="password" value="late-secret"><button type="submit">Login</button></form>';

    submit(dom, dom.window.document.querySelector("form")!);
    await settle(dom);
    expect(candidates).toEqual([expect.objectContaining({ username: "late-user", password: "late-secret" })]);
    stop();
  });

  it("captures a non-composed submit exactly once inside a dynamically added open shadow root", async () => {
    const dom = page();
    const candidates: CredentialCaptureInput[] = [];
    const stop = installCredentialCapture({ rootDocument: dom.window.document, pageLocation: dom.window.location, onCandidate: (candidate) => { candidates.push(candidate); } });
    const host = dom.window.document.createElement("login-shell");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<form><input autocomplete="username" value="shadow-user"><input type="password" value="shadow-secret"><button type="submit">Login</button></form>';
    dom.window.document.querySelector("#app")!.append(host);
    await settle(dom);

    submit(dom, shadow.querySelector("form")!);
    await settle(dom);
    expect(candidates).toEqual([expect.objectContaining({ username: "shadow-user", password: "shadow-secret" })]);
    stop();
  });

  it("instruments an open root attached later when the main-world bridge announces it", async () => {
    const dom = page('<login-shell id="host"></login-shell>');
    const candidates: CredentialCaptureInput[] = [];
    const stop = installCredentialCapture({ rootDocument: dom.window.document, pageLocation: dom.window.location, onCandidate: (candidate) => { candidates.push(candidate); } });
    const host = dom.window.document.querySelector("#host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<form><input autocomplete="username" value="announced-user"><input type="password" value="announced-secret"></form>';
    host.dispatchEvent(new dom.window.CustomEvent(OPEN_SHADOW_ROOT_EVENT, { bubbles: true, composed: true }));

    submit(dom, shadow.querySelector("form")!);
    await settle(dom);
    expect(candidates).toEqual([expect.objectContaining({ username: "announced-user", password: "announced-secret" })]);
    stop();
  });

  it("carries only a recent username across a username-first password-second SPA flow", async () => {
    const dom = page();
    const app = dom.window.document.querySelector("#app")!;
    const candidates: CredentialCaptureInput[] = [];
    const stop = installCredentialCapture({ rootDocument: dom.window.document, pageLocation: dom.window.location, onCandidate: (candidate) => { candidates.push(candidate); } });
    app.innerHTML = '<form><input autocomplete="username" value="two-step-user"><button type="button">Continue</button></form>';
    click(dom, app.querySelector("button")!);
    await settle(dom);

    app.innerHTML = '<form><input type="password" value="two-step-secret"><button type="button">Sign in</button></form>';
    click(dom, app.querySelector("button")!);
    await settle(dom);

    expect(candidates).toEqual([expect.objectContaining({ username: "two-step-user", password: "two-step-secret" })]);
    stop();
  });

  it("publishes username context once and clears it after producing a password candidate", async () => {
    const dom = page();
    const app = dom.window.document.querySelector("#app")!;
    const candidates: CredentialCaptureInput[] = [];
    const remembered: string[] = [];
    const stop = installCredentialCapture({
      rootDocument: dom.window.document,
      pageLocation: dom.window.location,
      onUsernameContext: (username) => { remembered.push(username); },
      onCandidate: (candidate) => { candidates.push(candidate); }
    });
    app.innerHTML = '<form><input autocomplete="username" value="first-user"><button type="button">Continue</button></form>';
    click(dom, app.querySelector("button")!);
    await settle(dom);
    app.innerHTML = '<form><input type="password" value="first-secret"><button type="button">Sign in</button></form>';
    click(dom, app.querySelector("button")!);
    await settle(dom);
    app.innerHTML = '<form><input type="password" value="second-secret"><button type="button">Sign in</button></form>';
    click(dom, app.querySelector("button")!);
    await settle(dom);

    expect(remembered).toEqual(["first-user"]);
    expect(candidates).toEqual([
      expect.objectContaining({ username: "first-user", password: "first-secret" }),
      expect.objectContaining({ username: "", password: "second-secret" })
    ]);
    stop();
  });

  it("does not reuse an expired username-step context", async () => {
    const dom = page();
    const app = dom.window.document.querySelector("#app")!;
    const candidates: CredentialCaptureInput[] = [];
    let clock = 1_000;
    const stop = installCredentialCapture({
      rootDocument: dom.window.document,
      pageLocation: dom.window.location,
      now: () => clock,
      usernameContextTtlMs: 500,
      onCandidate: (candidate) => { candidates.push(candidate); }
    });
    app.innerHTML = '<form><input autocomplete="username" value="expired-user"><button type="button">Continue</button></form>';
    click(dom, app.querySelector("button")!);
    await settle(dom);
    clock = 1_501;
    app.innerHTML = '<form><input type="password" value="fresh-secret"><button type="button">Sign in</button></form>';
    click(dom, app.querySelector("button")!);
    await settle(dom);

    expect(candidates).toEqual([expect.objectContaining({ username: "", password: "fresh-secret" })]);
    stop();
  });

  it("does not claim or instrument a closed shadow root", async () => {
    const dom = page('<login-shell id="host"></login-shell>');
    const candidates: CredentialCaptureInput[] = [];
    const stop = installCredentialCapture({ rootDocument: dom.window.document, pageLocation: dom.window.location, onCandidate: (candidate) => { candidates.push(candidate); } });
    const host = dom.window.document.querySelector("#host")!;
    const closed = host.attachShadow({ mode: "closed" });
    closed.innerHTML = '<form><input autocomplete="username" value="closed-user"><input type="password" value="closed-secret"></form>';
    host.dispatchEvent(new dom.window.CustomEvent(OPEN_SHADOW_ROOT_EVENT, { bubbles: true, composed: true }));
    await settle(dom);

    submit(dom, closed.querySelector("form")!);
    expect(candidates).toEqual([]);
    stop();
  });

  it("captures a clicked login button that also dispatches submit exactly once", async () => {
    const dom = page('<form><input autocomplete="username" value="single-user"><input type="password" value="single-secret"><button type="button">Login</button></form>');
    const candidates: CredentialCaptureInput[] = [];
    const stop = installCredentialCapture({ rootDocument: dom.window.document, pageLocation: dom.window.location, onCandidate: (candidate) => { candidates.push(candidate); } });
    const form = dom.window.document.querySelector("form")!;
    click(dom, form.querySelector("button")!);
    submit(dom, form);
    await settle(dom);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ username: "single-user", password: "single-secret" });
    stop();
  });

  it("does not recapture page credentials when a Monica prompt button is clicked", async () => {
    const dom = page('<form><input autocomplete="username" value="page-user"><input type="password" value="page-secret"></form><div id="monica-save-prompt-host"></div>');
    const candidates: CredentialCaptureInput[] = [];
    const host = dom.window.document.querySelector("#monica-save-prompt-host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<button type="button">保存密码</button>';
    const stop = installCredentialCapture({ rootDocument: dom.window.document, pageLocation: dom.window.location, onCandidate: (candidate) => { candidates.push(candidate); } });

    click(dom, shadow.querySelector("button")!);
    await settle(dom);

    expect(candidates).toEqual([]);
    stop();
  });

  it("still captures a login button click when the SPA prevents the submit", async () => {
    const dom = page('<form><input autocomplete="username" value="spa-user"><input type="password" value="spa-secret"><button type="submit">登录</button></form>');
    const candidates: CredentialCaptureInput[] = [];
    const stop = installCredentialCapture({ rootDocument: dom.window.document, pageLocation: dom.window.location, onCandidate: (candidate) => { candidates.push(candidate); } });
    const form = dom.window.document.querySelector("form")!;
    // AJAX 登录页的常态：submit 被页面 JS 拦截后自己 fetch。
    form.addEventListener("submit", (event) => event.preventDefault());
    click(dom, form.querySelector("button")!);
    form.dispatchEvent(new dom.window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await settle(dom);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ username: "spa-user", password: "spa-secret" });
    stop();
  });

  it("captures a prevented submit when the submitting control is the login button", async () => {
    const dom = page('<form><input autocomplete="username" value="enter-user"><input type="password" value="enter-secret"><button type="submit">登录</button></form>');
    const candidates: CredentialCaptureInput[] = [];
    const stop = installCredentialCapture({ rootDocument: dom.window.document, pageLocation: dom.window.location, onCandidate: (candidate) => { candidates.push(candidate); } });
    const form = dom.window.document.querySelector("form")!;
    form.addEventListener("submit", (event) => event.preventDefault());
    // 键盘 Enter 提交：submitter 是默认的登录按钮，同样算真实提交。
    const event = new dom.window.SubmitEvent("submit", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "submitter", { value: form.querySelector("button") });
    form.dispatchEvent(event);
    await settle(dom);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ username: "enter-user", password: "enter-secret" });
    stop();
  });

  it("ignores action buttons like captcha refresh instead of treating them as submission", async () => {
    const dom = page('<form><input autocomplete="username" value="captcha-user"><input type="password" value="captcha-secret"><button>重获图片</button><button type="button">刷新验证码</button><button type="button">获取短信验证码</button></form>');
    const candidates: CredentialCaptureInput[] = [];
    const stop = installCredentialCapture({ rootDocument: dom.window.document, pageLocation: dom.window.location, onCandidate: (candidate) => { candidates.push(candidate); } });
    const form = dom.window.document.querySelector("form")!;
    // 真实页面的验证码刷新会拦截 submit 自己处理；模拟这个行为。
    form.addEventListener("submit", (event) => event.preventDefault());
    const [regain, refresh, sms] = form.querySelectorAll("button");
    click(dom, regain!);
    click(dom, refresh!);
    click(dom, sms!);
    await settle(dom);

    expect(candidates).toEqual([]);
    stop();
  });

  it("still captures when a bare button labels the login action", async () => {
    const dom = page('<form><input autocomplete="username" value="bare-user"><input type="password" value="bare-secret"><button>登录</button></form>');
    const candidates: CredentialCaptureInput[] = [];
    const stop = installCredentialCapture({ rootDocument: dom.window.document, pageLocation: dom.window.location, onCandidate: (candidate) => { candidates.push(candidate); } });
    click(dom, dom.window.document.querySelector("form button")!);
    await settle(dom);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ username: "bare-user", password: "bare-secret" });
    stop();
  });
});
