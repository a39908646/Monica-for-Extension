import { chromium, expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

const ICON_SELECTOR = "[data-monica-password-generator]";
const PANEL_SELECTOR = "#monica-password-generator-panel";

interface ListedLogin {
  id: string;
  username: string;
  password: string;
}

const signupPage = `<!doctype html><title>Signup Example</title>
  <form id="register" action="/register">
    <label>Email <input id="email" type="email" autocomplete="email"></label>
    <label>Password <input id="password" type="password" autocomplete="new-password"></label>
    <label>Confirm <input id="confirm" type="password" autocomplete="new-password"></label>
    <button type="submit">创建账户</button>
  </form>
  <script>document.querySelector("form").addEventListener("submit", event => event.preventDefault())</script>`;

const loginPage = `<!doctype html><title>Login Example</title>
  <form id="login" action="/login">
    <label>Email <input id="user_login" type="text" autocomplete="username"></label>
    <label>Password <input id="user_password" type="password" autocomplete="current-password"></label>
    <button type="submit">登录</button>
  </form>
  <script>document.querySelector("form").addEventListener("submit", event => event.preventDefault())</script>`;

// 站点把登录标识符错标成 new-password，同时还留着一个普通密码框：Android 策略要求此时不上生成器。
const mislabeledPage = `<!doctype html><title>Mislabeled</title>
  <form id="login" action="/login">
    <label>Email <input id="identifier" type="text" autocomplete="new-password"></label>
    <label>Password <input id="user_password" type="password"></label>
    <button type="submit">登录</button>
  </form>`;

async function launchExtension(testInfo: TestInfo, profileName: string, viewport = { width: 1280, height: 900 }): Promise<{ context: BrowserContext; manager: Page }> {
  const extensionPath = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath(profileName), {
    channel: "chromium", headless: true, locale: "zh-CN", viewport,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  expect(await manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "in-field generator e2e password" }))).toMatchObject({ ok: true });
  return { context, manager };
}

async function listItems(manager: Page): Promise<ListedLogin[]> {
  const response = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { ok: boolean; data?: ListedLogin[]; error?: string };
  expect(response, response.error).toMatchObject({ ok: true });
  return response.data || [];
}

async function routePage(context: BrowserContext, pathName: string, body: string): Promise<void> {
  await context.route(`https://generator.example.test${pathName}`, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body }));
}

test("注册页：字段内图标生成密码并填入两个框，提交后保存的正是该密码", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "generator-signup");
    context = launched.context;
    await routePage(context, "/register", signupPage);
    const page = await context.newPage();
    await page.goto("https://generator.example.test/register");

    const icons = page.locator(ICON_SELECTOR);
    await expect(icons).toHaveCount(2);
    const firstIcon = await icons.first().boundingBox();
    const passwordBox = await page.locator("#password").boundingBox();
    // 图标贴在密码框内部右侧。
    expect(firstIcon!.x).toBeGreaterThan(passwordBox!.x + passwordBox!.width / 2);
    expect(firstIcon!.x + firstIcon!.width).toBeLessThanOrEqual(passwordBox!.x + passwordBox!.width + 1);

    await icons.first().click();
    const panel = page.locator(PANEL_SELECTOR);
    await expect(panel).toHaveCount(1);
    const panelBox = await panel.boundingBox();
    const confirmBox = await page.locator("#confirm").boundingBox();
    expect(Math.abs(panelBox!.x - passwordBox!.x)).toBeLessThan(2);
    expect(panelBox!.y).toBeGreaterThanOrEqual(confirmBox!.y + confirmBox!.height - 1);

    // 面板默认把焦点放在「填充」上：闭包 shadow 里用键盘走真实交互路径。
    await expect.poll(() => panel.evaluate((host) => document.activeElement === host)).toBe(true);
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator("#password").inputValue()).not.toBe("");
    const generated = await page.locator("#password").inputValue();
    expect(await page.locator("#confirm").inputValue()).toBe(generated);
    expect(generated.length).toBeGreaterThanOrEqual(12);

    // 提交后保存提示出现，落到密码库里的就是生成的密码。
    await page.locator("#register button").click();
    const prompt = page.locator("#monica-save-prompt-host");
    await expect(prompt).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(() => prompt.evaluate((host) => document.activeElement === host)).toBe(true);
    await page.keyboard.press("Enter");
    await expect(prompt).toHaveCount(0, { timeout: 20_000 });

    const items = await listItems(launched.manager);
    expect(items).toHaveLength(1);
    expect(items[0].password).toBe(generated);
  } finally {
    await context?.close();
  }
});

test("登录页与误标 new-password 的表单都不显示生成器图标", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "generator-login");
    context = launched.context;
    await routePage(context, "/login", loginPage);
    await routePage(context, "/mislabeled", mislabeledPage);
    const page = await context.newPage();

    await page.goto("https://generator.example.test/login");
    await page.locator("#user_password").click();
    await page.waitForTimeout(300);
    await expect(page.locator(ICON_SELECTOR)).toHaveCount(0);
    await expect(page.locator(PANEL_SELECTOR)).toHaveCount(0);

    await page.goto("https://generator.example.test/mislabeled");
    await page.locator("#user_password").click();
    await page.waitForTimeout(300);
    await expect(page.locator(ICON_SELECTOR)).toHaveCount(0);
  } finally {
    await context?.close();
  }
});

test("长度输入框可以用鼠标聚焦后手动输入并填充", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "generator-counts");
    context = launched.context;
    await routePage(context, "/register", signupPage);
    const page = await context.newPage();
    await page.goto("https://generator.example.test/register");
    await page.locator(ICON_SELECTOR).first().click();
    const panel = page.locator(PANEL_SELECTOR);
    await expect(panel).toHaveCount(1);

    // 面板在闭包 shadow 里，坐标只能按固定布局推算：16px 内边距 + 头部/结果/模式三行之后是「长度」输入框。
    // 以前整块面板阻止 pointerdown，鼠标点不进去，这里会填出默认 20 位。
    const origin = await panel.evaluate((host) => ({ left: parseFloat(host.style.left), top: parseFloat(host.style.top) }));
    await page.mouse.click(origin.left + 144, origin.top + 214);
    await page.keyboard.press("Control+a");
    await page.keyboard.type("12");

    // 从长度框 Tab 过四个最少数量框到「填充」并回车。
    for (let index = 0; index < 7; index += 1) await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator("#password").inputValue()).not.toBe("");
    expect(await page.locator("#password").inputValue()).toHaveLength(12);
  } finally {
    await context?.close();
  }
});

test("窄屏与 200% 字号下面板与图标都在窗口内", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "generator-narrow", { width: 320, height: 640 });
    context = launched.context;
    await routePage(context, "/register", signupPage);
    const page = await context.newPage();
    await page.goto("https://generator.example.test/register");
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });

    const icons = page.locator(ICON_SELECTOR);
    await expect(icons).toHaveCount(2);
    for (const box of await icons.all()) {
      const bounds = await box.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    }

    await icons.first().click();
    const panel = page.locator(PANEL_SELECTOR);
    await expect(panel).toHaveCount(1);
    const bounds = await panel.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(8);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(312);
    expect(bounds!.y).toBeGreaterThanOrEqual(8);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(632);
    expect(await page.locator("body").evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  } finally {
    await context?.close();
  }
});
