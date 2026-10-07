import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
/**
 * 自用/不上架时的加载目录刷新：把 dist/ 与 LICENSE 写进 release/monica-extension-unpacked/，
 * 不生成 ZIP、SBOM、许可证清单和发布凭证（那四样只有 package-release.mjs 才产出）。
 *
 * 与 package-release.mjs 的差别只有两点：
 * 1. 不产出版本化产物，因此不会在 release/ 顶层堆积 zip/JSON；
 * 2. 目录内多一个 DEV-BUILD.json 标记，写明版本、源 commit、工作树是否干净和生成时间，
 *    免得再出现「加载目录是哪个版本的代码」说不清的情况。正式打包会先清空该目录，标记随之消失。
 */
const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const releaseDir = resolve(root, "release");
const target = resolve(releaseDir, "monica-extension-unpacked");
const REQUIRED = ["manifest.json", "background.js", "content.js", "main-world.js", "index.html", "popup.html"];

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(dist, "manifest.json"), "utf8").catch(() => "null"));
if (!manifest) throw new Error("缺少 dist/manifest.json，请先运行 npm run build。");
if (manifest.version !== packageJson.version) throw new Error(`dist 版本 ${manifest.version} 与 package.json ${packageJson.version} 不一致，请重新运行 npm run build。`);

const entries = new Map();
for (const path of (await readdir(dist, { recursive: true })).map(path => path.replaceAll("\\", "/")).sort(compareText)) {
  const absolute = resolve(dist, ...path.split("/"));
  if (!(await stat(absolute)).isFile()) continue;
  entries.set(relative(dist, absolute).replaceAll("\\", "/"), new Uint8Array(await readFile(absolute)));
}
for (const required of REQUIRED) {
  if (!entries.has(required)) throw new Error(`dist 缺少 ${required}，请重新运行 npm run build。`);
}
entries.set("LICENSE", new Uint8Array(await readFile(resolve(root, "LICENSE"))));
entries.set("DEV-BUILD.json", jsonBytes({
  schemaVersion: 1,
  product: packageJson.name,
  version: packageJson.version,
  manifestVersion: manifest.manifest_version,
  source: "dev:sync",
  commit: git("rev-parse", "HEAD"),
  trackedWorktreeClean: git("status", "--porcelain", "--untracked-files=no") === "",
  builtAt: new Date().toISOString(),
  note: "本地自用开发包：只用于浏览器加载，不含 ZIP、SBOM、许可证清单与发布凭证。需要存档或分享时运行 node scripts/package-release.mjs --allow-dirty。"
}));

await rm(target, { recursive: true, force: true });
for (const [name, bytes] of [...entries.entries()].sort(([left], [right]) => compareText(left, right))) {
  const file = resolve(target, ...name.split("/"));
  assertInside(target, file, true);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

const marker = JSON.parse(new TextDecoder().decode(entries.get("DEV-BUILD.json")));
console.log(`Refreshed ${target} with ${entries.size} files (version ${manifest.version}, commit ${String(marker.commit).slice(0, 7)}, worktree ${marker.trackedWorktreeClean ? "clean" : "dirty"}).`);
console.log("Reload the extension in the browser, then reload the page you are testing.");

function jsonBytes(value) {
  return new Uint8Array(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function assertInside(parent, child, allowFile = false) {
  const path = relative(parent, child);
  const valid = path && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  if (!valid) throw new Error(`${allowFile ? "文件" : "目录"}必须留在 ${parent} 内：${child}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
