export interface WebPageSenderContext {
  tabId: number;
  frameId: number;
  documentId: string;
  url: string;
  origin: string;
}

export function assertTrustedExtensionPage(
  sender: chrome.runtime.MessageSender,
  runtimeId: string,
  extensionRoot: string
): void {
  if (sender.id !== runtimeId || !sender.url?.startsWith(extensionRoot)) {
    throw new Error("此命令只允许 Monica 插件页面调用。");
  }
}

export function assertTrustedManagerPage(
  sender: chrome.runtime.MessageSender,
  runtimeId: string,
  extensionRoot: string,
  managerPath = "/index.html"
): void {
  assertTrustedExtensionPage(sender, runtimeId, extensionRoot);
  const actual = new URL(sender.url || "");
  const manager = new URL(`${extensionRoot}${managerPath.replace(/^\//, "")}`);
  if (actual.origin !== manager.origin || actual.pathname !== manager.pathname) {
    throw new Error("此命令只允许 Monica 管理页调用。");
  }
}

export function requireTrustedWebPageSender(sender: chrome.runtime.MessageSender, runtimeId: string): WebPageSenderContext {
  const url = sender.url || "";
  const parsed = new URL(url);
  const frameId = sender.frameId ?? 0;
  const documentId = sender.documentId || "";
  if (
    sender.id !== runtimeId ||
    sender.tab?.id === undefined ||
    !Number.isInteger(sender.tab.id) ||
    sender.tab.id < 0 ||
    !Number.isInteger(frameId) ||
    frameId < 0 ||
    !/^[0-9a-f-]{16,64}$/i.test(documentId) ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    (sender.origin !== undefined && sender.origin !== parsed.origin)
  ) {
    throw new Error("此命令只允许 Monica 网页内容脚本调用。");
  }
  return { tabId: sender.tab.id, frameId, documentId, url: parsed.toString(), origin: parsed.origin };
}

export function isSecureSensitivePageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === "https:" || (url.protocol === "http:" && isLanHost(url.hostname));
}

// 局域网网段放行：IPv4 回环 + RFC1918 私有网段 + 链路本地，IPv6 唯一本地（ULA）+ 链路本地。
export function isLanHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((value) => value > 255)) return false;
    const [a, b] = octets;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 回环
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地
    return false;
  }
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fd00::/8 唯一本地
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10 链路本地
  return false;
}
