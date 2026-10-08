import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { localeOptions } from "./i18n/locales";

const root = new URL("../", import.meta.url);

/** 原 manager.css 按职责拆成这些文件；它们共享同一条级联，顺序不可调整。 */
const MANAGER_CSS_FILES = [
  "src/manager-shell.css",
  "src/manager-dialog.css",
  "src/manager-editor.css",
  "src/manager-provider.css",
  "src/manager-provider-status.css",
  "src/manager-editor-controls.css",
  "src/manager-responsive.css",
  "src/manager-generator.css",
  "src/manager-steam.css"
];

/** 原 styles.css 按职责拆成这些分片，由 styles.css 按同样顺序 @import；顺序不可调整。 */
const GLOBAL_CSS_FILES = [
  "base.css",
  "auth.css",
  "shell.css",
  "appbar.css",
  "pages.css",
  "filters.css",
  "data-table.css",
  "list.css",
  "panels.css",
  "appearance.css",
  "motion.css",
  "breakpoints.css",
  "credential-list.css",
  "motion-reduce.css"
].map((file) => `src/${file}`);

describe("release-facing localization", () => {
  it.each(localeOptions.map((option) => option.manifest))("resolves every MV3 store string in %s", async (locale) => {
    const manifest = JSON.parse(await read("public/manifest.json")) as Record<string, any>;
    const messages = JSON.parse(await read(`public/_locales/${locale}/messages.json`)) as Record<string, { message: string; description?: string }>;

    expect(manifest.default_locale).toBe("en");
    for (const field of [manifest.name, manifest.description, manifest.action.default_title]) {
      expect(field).toMatch(/^__MSG_[A-Za-z0-9_]+__$/);
      const key = field.slice(6, -2);
      expect(messages[key]?.message, `missing locale key ${key}`).toBeTruthy();
      expect(messages[key]?.description, `missing translator context ${key}`).toBeTruthy();
    }
    expect(messages.extensionName.message.length).toBeLessThanOrEqual(45);
    expect(messages.extensionDescription.message.length).toBeLessThanOrEqual(132);
  });

  it("declares the supported interface languages and where to switch them", async () => {
    const [readme, localePolicy] = await Promise.all([read("README.md"), read("docs/LOCALIZATION.md")]);
    for (const option of localeOptions) expect(localePolicy).toContain(`\`${option.value}\``);
    expect(readme).toContain("8 种语言");
    expect(localePolicy).toContain("切换语言");
    expect(localePolicy).toContain("用户录入");
    expect(localePolicy).toContain("保持原样");
  });
});

describe("store-facing privacy and security artifacts", () => {
  it("documents every declared permission and host scope", async () => {
    const manifest = JSON.parse(await read("public/manifest.json")) as { permissions: string[]; host_permissions: string[] };
    const permissions = await read("docs/PERMISSIONS.md");
    for (const permission of [...manifest.permissions, ...manifest.host_permissions]) {
      expect(permissions, `missing permission disclosure for ${permission}`).toContain(`\`${permission}\``);
    }
    expect(permissions).toContain("MAIN world");
    expect(permissions).toContain("完整密码库");
  });

  it("discloses storage, exports, optional provider transmission and diagnostics consistently", async () => {
    const [privacy, dataSafety] = await Promise.all([read("docs/PRIVACY.md"), read("docs/DATA_SAFETY.md")]);
    const disclosure = `${privacy}\n${dataSafety}`;
    for (const term of ["IndexedDB", "chrome.storage.session", "WebDAV Basic Auth", "普通 ZIP", "Bitwarden", "明文", "加密整库备份", "脱敏诊断", "Passkey", "MAIN-world"]) {
      expect(disclosure, `missing disclosure: ${term}`).toContain(term);
    }
    expect(disclosure).toContain("不自动上传");
    expect(disclosure).not.toMatch(/零网络|不进行任何网络|no network transmission/i);
  });

  it("keeps listing metadata and security contact publishable", async () => {
    const [messages, listing, security] = await Promise.all([
      readJson<Record<string, { message: string }>>("public/_locales/zh_CN/messages.json"),
      read("docs/STORE_LISTING.zh-CN.md"),
      read("SECURITY.md")
    ]);
    expect(listing).toContain(messages.extensionName.message);
    expect(listing).toContain(messages.extensionDescription.message);
    expect(listing).toContain("zh-CN");
    expect(security).toContain("GitHub Security Advisories");
    expect(security).not.toMatch(/guarantee|保证在.*修复/i);
  });
});

describe("reproducible release contract", () => {
  it("keeps deterministic packaging and independent verification in the release gate", async () => {
    const [pkg, manifest, lockfile, workflow, releaseGuide, viteConfig, packager, verifier] = await Promise.all([
      readJson<{ version: string; scripts: Record<string, string> }>("package.json"),
      readJson<{ version: string }>("public/manifest.json"),
      readJson<{ version: string; packages: Record<string, { version: string }> }>("package-lock.json"),
      read(".github/workflows/ci.yml"),
      read("docs/RELEASE.md"),
      read("vite.config.ts"),
      read("scripts/package-release.mjs"),
      read("scripts/verify-release.mjs")
    ]);
    expect(pkg.version).toBe(manifest.version);
    // 版本号三处同步是硬性要求：上次只改了 package.json 导致 lockfile 漂移到 0.1.36，这里守住。
    expect(pkg.version).toBe(lockfile.version);
    expect(pkg.version).toBe(lockfile.packages[""].version);
    expect(pkg.scripts.build).toContain("verify-extension-pages.mjs");
    expect(pkg.scripts["package:verify"]).toContain("verify-release.mjs");
    expect(pkg.scripts["release:check"]).toContain("package:verify");
    expect(pkg.scripts["verify:supply-chain"]).toContain("verify:lockfile");
    expect(workflow).toContain("npm run package:verify");
    for (const term of ["SHA-256", "CycloneDX", "1980-01-01", "逐字节相同"]) expect(releaseGuide).toContain(term);
    expect(packager).toContain("RELEASE-METADATA.json");
    expect(packager).toContain("THIRD-PARTY-LICENSES.json");
    expect(packager).toContain("monica-extension-unpacked");
    expect(viteConfig).toContain("modulePreload: false");
    expect(verifier).toContain("byte-reproducible");
  });
});

describe("visual design contract", () => {
  it("uses solid Material surfaces without CSS gradients", async () => {
    const sources = await Promise.all([
      ...GLOBAL_CSS_FILES.map((file) => read(file)),
      ...MANAGER_CSS_FILES.map((file) => read(file)),
      read("src/popup/popup.css"),
      read("scripts/capture-store-assets.mjs")
    ]);
    expect(sources.join("\n")).not.toMatch(/(?:linear|radial|conic|repeating-linear|repeating-radial)-gradient\s*\(/i);
  });

  it("keeps the shared M3E shape and icon tokens stable", async () => {
    const tokens = await read("src/tokens.css");
    const base = await read("src/base.css");
    const popupStyles = await read("src/popup/popup.css");
    // 形状/图标令牌只在 tokens.css 定义一次。这里断言的是实际生效的值：旧断言写的是
    // styles.css 里的 --app-shape-card: 8px，而那个值一直被 nothing.css 的 12px 覆盖，
    // 等于把一个不生效的值锁进了契约。
    expect(tokens).toContain("--app-shape-card: 12px");
    expect(tokens).toContain("--app-shape-field: 8px");
    expect(tokens).toContain("--app-shape-dialog: 16px");
    expect(tokens).toContain("--app-shape-pill: 999px");
    expect(tokens).toContain("--app-icon-small: 20px");
    expect(tokens).toContain("--app-icon-medium: 24px");
    expect(base).toMatch(/m3e-icon\s*\{[^}]*--m3e-icon-size:\s*var\(--app-icon-medium\)/s);
    expect(base).toMatch(/m3e-icon-button\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s);
    expect(popupStyles).toMatch(/\.popup-shell m3e-button\s*\{[^}]*--m3e-button-icon-size:\s*var\(--app-icon-medium\)/s);
    expect(popupStyles).toMatch(/\.popup-shell m3e-icon-button\s*\{[^}]*--m3e-icon-button-icon-size:\s*var\(--app-icon-medium\)/s);

    // 页面 CSS 只消费令牌：形状与焦点令牌不允许在 tokens.css 之外再定义一次，
    // 否则又会回到「同一个值在两个文件各写一遍」的老路。
    for (const file of [...GLOBAL_CSS_FILES, ...MANAGER_CSS_FILES, "src/nothing.css", "src/home.css", "src/detail-layout.css", "src/responsive.css", "src/popup/popup.css"]) {
      const css = await read(file);
      expect(css, `${file} 不应重复定义形状/焦点令牌`).not.toMatch(/--app-shape-(?:card|field|dialog|pill)\s*:|--app-focus-(?:wash|shadow)\s*:/);
    }
  });

  it("imports the split manager stylesheets in cascade order", async () => {
    const main = await read("src/main.ts");
    const imported = [...main.matchAll(/import "\.\/(manager-[a-z-]+\.css)";/g)].map((match) => `src/${match[1]}`);
    // 这些文件是同一条级联的切片，顺序错了会改变同名选择器的胜负。
    expect(imported).toEqual(MANAGER_CSS_FILES);
  });

  it("imports the global stylesheet slices in cascade order", async () => {
    const barrel = await read("src/styles.css");
    const imported = [...barrel.matchAll(/@import "\.\/([a-z-]+\.css)";/g)].map((match) => `src/${match[1]}`);
    expect(imported).toEqual(GLOBAL_CSS_FILES);
  });

  it("keeps exactly one global reduced-motion override", async () => {
    // 以前 styles.css 和 nothing.css 各有一份 * 上的 !important 降级，后者静默盖掉前者。
    // 组件自己的降级（例如 popup 的 .spinner）不算全局，不在此列。
    for (const file of ["src/nothing.css", "src/home.css", "src/detail-layout.css", "src/responsive.css", ...MANAGER_CSS_FILES]) {
      expect(await read(file), `${file} 不应再定义全局 reduced-motion 降级`).not.toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*/);
    }
    expect(await read("src/motion-reduce.css")).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*/);
  });

  it("does not nest M3E cards in manager templates", async () => {
    const template = await read("src/App.vue");
    const tags = [...template.matchAll(/<\/?m3e-card\b[^>]*>/g)].map((match) => match[0]);
    let depth = 0;
    let maximumDepth = 0;
    for (const tag of tags) {
      depth += tag.startsWith("</") ? -1 : 1;
      maximumDepth = Math.max(maximumDepth, depth);
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    expect(maximumDepth).toBeLessThanOrEqual(1);
  });
});

async function read(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await read(path)) as T;
}
