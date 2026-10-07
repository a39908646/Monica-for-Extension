import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import path from "node:path";

const BLOCK_PREFIX = "monica.content.block.";
const ORDER_FIELD = "monica.content.order";

/** 按 Android `PasswordContentBlocks.save` 逐字构造传输字段，避免用被测的实现自证。 */
function transport(id: string, envelope: Record<string, unknown>, options: { corrupt?: boolean } = {}) {
  const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
  const encoded = bytes.toString("base64");
  const chunks = encoded.match(/.{1,1600}/g) || [""];
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = { version: 1, encoding: "base64", parts: chunks.length, sha256 };
  const fields = [
    { name: BLOCK_PREFIX + id, value: JSON.stringify(manifest), protected: true },
    ...chunks.map((value, index) => ({ name: `${BLOCK_PREFIX}${id}.${String(index).padStart(4, "0")}`, value, protected: true }))
  ];
  if (options.corrupt) fields[1].value = fields[1].value.slice(0, 8);
  return fields;
}

async function launch(testInfo: { outputPath: (name: string) => string }): Promise<{ context: BrowserContext; page: Page; extensionId: string }> {
  const extensionPath = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("content-blocks-profile"), {
    channel: "chromium", headless: true, locale: "zh-CN", viewport: { width: 1280, height: 960 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "content blocks e2e password" }))).toMatchObject({ ok: true });
  return { context, page, extensionId };
}

async function upsert(page: Page, item: Record<string, unknown>) {
  expect(await page.evaluate(candidate => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item: candidate }), item)).toMatchObject({ ok: true });
}

async function reload(page: Page) {
  await page.reload();
  await expect(page.locator(".home-module").first()).toBeVisible();
}

async function openDetail(page: Page, title: string) {
  await page.locator("button.nav-item").filter({ hasText: "登录项" }).click();
  await page.getByRole("button", { name: `查看${title}详情`, exact: true }).click();
  const detail = page.getByRole("dialog", { name: new RegExp(title) });
  await expect(detail).toBeVisible();
  return detail;
}

/** 用测试侧的独立实现找出唯一可读的 API Key 块，避免用被测代码自证。 */
function readAddedBlock(fields: Array<{ name: string; value: string }>) {
  const ids = [...new Set(fields.filter(field => field.name.startsWith(BLOCK_PREFIX)).map(field => field.name.slice(BLOCK_PREFIX.length).split(".")[0]))];
  const readable = ids.flatMap(id => {
    try {
      const manifest = JSON.parse(fields.find(field => field.name === BLOCK_PREFIX + id)!.value) as { parts: number; sha256: string };
      const chunks = Array.from({ length: manifest.parts }, (_, index) => fields.find(field => field.name === `${BLOCK_PREFIX}${id}.${String(index).padStart(4, "0")}`)?.value);
      if (chunks.some(value => value === undefined)) return [];
      const bytes = Buffer.from(chunks.join(""), "base64");
      if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) return [];
      const envelope = JSON.parse(bytes.toString("utf8")) as { kind?: string; title: string; data: Record<string, string> };
      return envelope.kind === "API_KEY" ? [envelope] : [];
    } catch {
      return [];
    }
  });
  expect(readable).toHaveLength(1);
  return readable[0];
}

const ITEM_ID = "content-block-login";
const BLOCK_ID = "ffdba4b4-e793-4fd8-a62d-ef04ba5b5ff9";
const SECRET = "synthetic-block-secret";

function loginItem(customFields: Array<Record<string, unknown>>) {
  const now = new Date().toISOString();
  return {
    id: ITEM_ID, kind: "login", title: "Block Login", username: "block@example.test", password: "page-password",
    uris: ["https://block.example.test"], favorite: false, notes: "条目备注",
    createdAt: now, updatedAt: now, providerRefs: [], customFields
  };
}

test("内容块在详情里可读，原始传输字段不出现", async ({}, testInfo) => {
  const { context, page } = await launch(testInfo);
  try {
    await upsert(page, loginItem([
      { name: "Tenant", value: "acme", protected: false },
      ...transport(BLOCK_ID, { version: 1, id: BLOCK_ID, kind: "API_KEY", title: "示例密钥", data: { key: SECRET, url: "https://example.invalid/api", notes: "内容块备注" } }),
      { name: ORDER_FIELD, value: `BLOCK:${BLOCK_ID},NOTES`, protected: false }
    ]));
    await reload(page);
    const detail = await openDetail(page, "Block Login");

    await expect(detail.getByRole("heading", { name: "API Key · 示例密钥" })).toBeVisible();
    await expect(detail.getByText("内容块备注", { exact: true })).toBeVisible();
    await expect(detail.getByText("https://example.invalid/api", { exact: true })).toBeVisible();
    await expect(detail.getByText("Tenant", { exact: true })).toBeVisible();
    // 秘密默认隐藏，显式显示后才出现。
    await expect(detail.getByText(SECRET, { exact: true })).toHaveCount(0);
    await detail.getByRole("button", { name: "显示密钥" }).click();
    await expect(detail.getByText(SECRET, { exact: true })).toBeVisible();
    // manifest、分片与顺序字段都不再逐条暴露。
    expect(await detail.innerText()).not.toContain("monica.content.block");
    expect(await detail.innerText()).not.toContain("sha256");
  } finally {
    await context.close();
  }
});

test("编辑内容块写回 Android 可读的传输，普通自定义字段保留", async ({}, testInfo) => {
  const { context, page } = await launch(testInfo);
  try {
    await upsert(page, loginItem([
      { name: "Tenant", value: "acme", protected: false },
      ...transport(BLOCK_ID, { version: 1, id: BLOCK_ID, kind: "API_KEY", title: "示例密钥", data: { key: SECRET, url: "", notes: "" } })
    ]));
    await reload(page);
    const detail = await openDetail(page, "Block Login");
    await detail.getByRole("button", { name: "编辑", exact: true }).click();
    const editor = page.getByRole("dialog", { name: /编辑登录项/ });
    await expect(editor).toBeVisible();

    const blocks = editor.locator(".content-block-editor");
    await expect(blocks.getByText("API Key", { exact: true })).toBeVisible();
    await expect(blocks.getByLabel("密钥")).toHaveValue(SECRET);
    expect(await editor.innerText()).not.toContain("monica.content.block");

    await blocks.getByLabel("密钥").fill("rotated-block-secret");
    await blocks.getByLabel("标题").fill("轮换后的密钥");
    await editor.getByRole("button", { name: "加密保存" }).click();
    await expect(editor).toHaveCount(0);

    await reload(page);
    const reopened = await openDetail(page, "Block Login");
    await expect(reopened.getByRole("heading", { name: "API Key · 轮换后的密钥" })).toBeVisible();
    await expect(reopened.getByText("Tenant", { exact: true })).toBeVisible();
    await reopened.getByRole("button", { name: "显示密钥" }).click();
    await expect(reopened.getByText("rotated-block-secret", { exact: true })).toBeVisible();

    // 写回的字段必须仍能被 Android 侧按原规则读取：分片顺序、数量与摘要都要自洽。
    const stored = await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_GET_ITEM", itemId: "content-block-login" })) as { data: { customFields: Array<{ name: string; value: string; protected: boolean }> } };
    const fields = stored.data.customFields;
    const manifest = JSON.parse(fields.find(field => field.name === BLOCK_PREFIX + BLOCK_ID)!.value) as { parts: number; sha256: string; version: number; encoding: string };
    expect(manifest).toMatchObject({ version: 1, encoding: "base64" });
    const chunks = Array.from({ length: manifest.parts }, (_, index) => fields.find(field => field.name === `${BLOCK_PREFIX}${BLOCK_ID}.${String(index).padStart(4, "0")}`)!.value);
    expect(chunks.every(value => value.length <= 1600)).toBe(true);
    const bytes = Buffer.from(chunks.join(""), "base64");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest.sha256);
    expect(JSON.parse(bytes.toString("utf8"))).toMatchObject({ version: 1, id: BLOCK_ID, kind: "API_KEY", title: "轮换后的密钥", data: { key: "rotated-block-secret" } });
    expect(fields.filter(field => field.name.startsWith(BLOCK_PREFIX)).every(field => field.protected)).toBe(true);
    expect(fields.find(field => field.name === "Tenant")?.value).toBe("acme");
  } finally {
    await context.close();
  }
});

test("新增二维码内容块并主动查看，损坏块只提示且不被改写", async ({}, testInfo) => {
  const { context, page } = await launch(testInfo);
  try {
    const damagedId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await upsert(page, loginItem([
      ...transport(BLOCK_ID, { version: 1, id: BLOCK_ID, kind: "QR_CODE", title: "登录二维码", data: { content: "%TITLE%|%PASSWORD%", mode: "template", templateVersion: "1", notes: "" } }),
      ...transport(damagedId, { version: 1, id: damagedId, kind: "GPG_KEY", title: "未来块", data: { fingerprint: "x" } }, { corrupt: true })
    ]));
    await reload(page);

    const detail = await openDetail(page, "Block Login");
    await expect(detail.getByRole("heading", { name: "二维码 · 登录二维码" })).toBeVisible();
    await expect(detail.locator("img.detail-qr")).toHaveCount(0);
    await detail.getByRole("button", { name: "查看二维码" }).click();
    await expect(detail.locator("img.detail-qr")).toBeVisible();
    await expect(detail.locator("img.detail-qr")).toHaveAttribute("src", /^data:image\/png;base64,/);

    const damaged = detail.getByRole("heading", { name: "暂无法解析的内容" });
    await expect(damaged).toBeVisible();
    await expect(detail.getByText("原始内容已保留，请使用兼容版本编辑。", { exact: true })).toBeVisible();

    // 损坏块在编辑器里只读：没有删除按钮，保存也不改写它。
    await detail.getByRole("button", { name: "编辑", exact: true }).click();
    const editor = page.getByRole("dialog", { name: /编辑登录项/ });
    await expect(editor.locator(".content-block-damaged")).toContainText("原始内容已保留，请使用兼容版本编辑。");
    const cards = editor.locator(".content-block-card");
    await expect(cards).toHaveCount(1);

    // 只读的损坏块没有删除入口；可读块可以删除，删掉后重新新增一个。
    await expect(editor.locator(".content-block-damaged").getByRole("button")).toHaveCount(0);
    await cards.getByRole("button", { name: "删除内容块" }).click();
    await expect(cards).toHaveCount(0);
    await editor.locator(".content-block-add").getByRole("button", { name: "API Key", exact: true }).click();
    await expect(cards).toHaveCount(1);
    await cards.getByLabel("密钥").fill("added-in-editor");
    await cards.getByLabel("标题").fill("扩展新增");
    await editor.getByRole("button", { name: "加密保存" }).click();
    await expect(editor).toHaveCount(0);

    const stored = await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_GET_ITEM", itemId: "content-block-login" })) as { data: { customFields: Array<{ name: string; value: string }> } };
    const names = stored.data.customFields.map(field => field.name);
    // 删除的二维码块连同分片一起消失。
    expect(names.filter(name => name.startsWith(`${BLOCK_PREFIX}${BLOCK_ID}`))).toEqual([]);
    // 损坏块与它的分片保持原样，扩展不覆盖、不删除。
    expect(names).toContain(`${BLOCK_PREFIX}${damagedId}`);
    expect(stored.data.customFields.find(field => field.name === `${BLOCK_PREFIX}${damagedId}.0000`)!.value).toHaveLength(8);
    // 顺序字段只留下新增块的令牌。
    const order = stored.data.customFields.find(field => field.name === ORDER_FIELD)?.value || "";
    expect(order.split(",").filter(token => token.startsWith("BLOCK:"))).toHaveLength(1);
    expect(readAddedBlock(stored.data.customFields)).toMatchObject({ title: "扩展新增", data: { key: "added-in-editor" } });
  } finally {
    await context.close();
  }
});

test("内容块分区在 320px 与 200% 字号下可用", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("content-blocks-narrow"), {
    channel: "chromium", headless: true, locale: "zh-CN", reducedMotion: "reduce", viewport: { width: 320, height: 480 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "content blocks narrow password" }))).toMatchObject({ ok: true });
    await upsert(page, loginItem([
      ...transport(BLOCK_ID, { version: 1, id: BLOCK_ID, kind: "API_KEY", title: "示例密钥", data: { key: SECRET, url: "https://example.invalid/api", notes: "内容块备注" } }),
      ...transport("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", { version: 1, id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", kind: "QR_CODE", title: "访客 Wi-Fi", data: { content: "WIFI:T:WPA;S:%TITLE%;P:%PASSWORD%;H:false;;", mode: "template", templateVersion: "1", notes: "" } })
    ]));
    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await expect(page.locator(".home-module").first()).toBeVisible();
    // 窄屏下侧边栏收进抽屉，先打开导航再进入登录项列表。
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.locator(".sidebar .nav-item").filter({ hasText: "登录项" }).click();
    await page.getByRole("button", { name: "查看Block Login详情", exact: true }).click();
    const detail = page.getByRole("dialog", { name: /Block Login/ });
    await expect(detail.getByRole("heading", { name: "API Key · 示例密钥" })).toBeVisible();
    await detail.getByRole("button", { name: "编辑", exact: true }).click();
    const editor = page.getByRole("dialog", { name: /编辑登录项/ });
    const blocks = editor.locator(".content-block-editor");
    await blocks.scrollIntoViewIfNeeded();
    // 二维码块在窄屏与 200% 字号下也要能展开预览。
    await blocks.getByRole("button", { name: "查看二维码" }).click();
    await expect(blocks.locator("img.detail-qr")).toBeVisible();
    const problems = await blocks.evaluate((root) => {
      const issues: string[] = [];
      const viewport = document.documentElement.clientWidth;
      if (document.documentElement.scrollWidth > viewport + 1) issues.push("页面出现横向滚动");
      for (const control of root.querySelectorAll<HTMLElement>("button, m3e-button, m3e-icon-button, input, select, textarea, p")) {
        const box = control.getBoundingClientRect();
        if (box.width < 2 || box.height < 2 || getComputedStyle(control).visibility === "hidden") continue;
        const name = control.getAttribute("aria-label") || control.textContent?.trim().slice(0, 60) || control.tagName;
        if (box.left < -1 || box.right > viewport + 1) issues.push(`超出窗口: ${name}`);
        if (control.matches("button, m3e-button, m3e-icon-button") && (box.width < 43.5 || box.height < 43.5)) issues.push(`点击目标过小: ${name}`);
      }
      return issues;
    });
    expect(problems).toEqual([]);
  } finally {
    await context.close();
  }
});
