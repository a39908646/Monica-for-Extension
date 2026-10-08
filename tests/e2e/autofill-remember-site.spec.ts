import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import path from "node:path";

const page = `<!doctype html><title>Remember site</title>
  <form id="login_form" action="javascript:void(0);" method="POST">
    <label for="email">邮箱</label><input id="email" type="text" autocomplete="email">
    <label for="passwd">密码</label><input id="passwd" type="password" autocomplete="current-password">
    <button type="submit">登录</button>
  </form>
  <script>document.querySelector("form").addEventListener("submit", (event) => event.preventDefault())</script>`;

test("弹窗对不匹配的条目先确认，确认后填充并把当前网站写入该条目", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("remember-site-profile"), {
      channel: "chromium", headless: true, locale: "zh-CN", viewport: { width: 390, height: 760 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    await context.route("https://remember.example.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: page }));

    const target = await context.newPage();
    await target.goto("https://remember.example.test/v2/login");
    await target.locator("#email").focus();

    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "remember site password" }))).toMatchObject({ ok: true });
    const now = new Date().toISOString();
    const itemId = "remember-site-login";
    expect(await manager.evaluate(async (item) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), {
      id: itemId, kind: "login", title: "百变小樱", favorite: false, notes: "", createdAt: now, updatedAt: now,
      providerRefs: [], username: "a39908646@gmail.com", password: "remember-secret",
      uris: ["https://other.example"], uriRules: [{ uri: "https://other.example", matchType: "base-domain" }], customFields: []
    })).toMatchObject({ ok: true });

    await target.bringToFront();
    await target.locator("#email").focus();
    const popup = await context.newPage();
    await target.bringToFront();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    // 网址不匹配的条目只出现在「全部登录项」，并且卡片上写明原因。
    await expect(popup.getByText("全部登录项", { exact: true })).toBeVisible();
    await expect(popup.getByText("与当前网站不匹配", { exact: false })).toBeVisible();
    await expect(popup.getByText("匹配的登录项", { exact: true })).toHaveCount(0);

    // 第一次点击不填充，只展开确认条；此时页面仍为空。
    await popup.getByRole("button", { name: /百变小樱/ }).click();
    await expect(popup.getByText("填充后会把 https://remember.example.test 加入该条目，之后自动匹配。", { exact: true })).toBeVisible();
    await expect(target.locator("#email")).toHaveValue("");

    await popup.getByRole("button", { name: "确认填充并记住" }).click();
    await expect(target.locator("#email")).toHaveValue("a39908646@gmail.com");
    await expect(target.locator("#passwd")).toHaveValue("remember-secret");

    // 确认后当前网站已写入条目：uriRules 追加一条 base-domain，uris 同步镜像。
    const stored = await manager.evaluate(async (id) => chrome.runtime.sendMessage({ type: "VAULT_GET_ITEM", itemId: id }), itemId) as { data: { uris: string[]; uriRules: Array<{ uri: string; matchType: string }> } };
    expect(stored.data.uriRules).toEqual([
      { uri: "https://other.example", matchType: "base-domain" },
      { uri: "https://remember.example.test", matchType: "base-domain" }
    ]);
    expect(stored.data.uris).toEqual(["https://other.example", "https://remember.example.test"]);

    // 列表随之刷新：该条目现在匹配这个网站，出现在「匹配的登录项」里。
    await expect(popup.getByText("匹配的登录项", { exact: true })).toBeVisible();
    await expect(popup.getByText("已把 https://remember.example.test 加入该条目", { exact: false })).toBeVisible();
  } finally {
    await context?.close();
  }
});
