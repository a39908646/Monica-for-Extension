import safeRegex from "safe-regex2";
import { getDomain } from "tldts";
import type { LoginItem, LoginUriRule } from "./model";

const MAX_REGEX_LENGTH = 512;

export function normalizeHost(value: string): string {
  const candidate = value.trim();
  if (!candidate) return "";
  try {
    return normalizeHostname(new URL(candidate.includes("://") ? candidate : `https://${candidate}`).hostname);
  } catch {
    return normalizeHostname(candidate.split("/")[0] || "");
  }
}

export function loginMatchScore(item: LoginItem, pageUrl: string): number {
  if (item.deletedAt || item.archivedAt) return 0;
  if (item.loginType && item.loginType !== "PASSWORD" && item.loginType !== "SSO") return 0;
  const page = parsePageUrl(pageUrl);
  if (!page) return 0;
  const rules = effectiveUriRules(item);
  return rules.reduce((score, rule) => Math.max(score, uriRuleMatchScore(rule, page)), 0);
}

export function matchingLogins(items: LoginItem[], pageUrl: string): LoginItem[] {
  return items
    .map((item) => ({ item, score: loginMatchScore(item, pageUrl) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || Number(right.item.favorite) - Number(left.item.favorite) || left.item.title.localeCompare(right.item.title))
    .map(({ item }) => item);
}

export function effectiveUriRules(item: LoginItem): LoginUriRule[] {
  if (item.uriRules?.length) return item.uriRules;
  return item.uris.map((uri) => ({ uri, matchType: "base-domain" }));
}

/**
 * 用户在弹窗里明确确认「仍然填充并记住此网站」后使用：把当前站点的 origin 追加为该条目的匹配规则。
 * origin 必须由后台从实际目标 frame 推导，不接受调用方传入，否则等于让调用方给自己授权。
 * `uriRules` 是权威字段（匹配与编辑器都以它为准），`uris` 按编辑器的方式同步镜像。
 */
export function withLoginSiteUri<T extends LoginItem>(item: T, origin: string): T {
  const uri = siteOrigin(origin);
  if (!uri) return item;
  const rules = effectiveUriRules(item);
  const host = normalizeHost(uri);
  const existing = rules.find((rule) => normalizeHost(rule.uri) === host);
  if (existing && existing.matchType !== "never") return item;
  // 同主机已有的「永不匹配」规则会被这条确认替换掉：否则管理页会同时显示两条互相矛盾的规则。
  const uriRules: LoginUriRule[] = existing
    ? rules.map((rule) => (rule === existing ? { uri, matchType: "base-domain" as const } : rule))
    : [...rules, { uri, matchType: "base-domain" }];
  return { ...item, uriRules, uris: uriRules.map((rule) => rule.uri) };
}

/** 只接受 http/https 的 origin，路径、查询串与伪协议一律归一化掉或拒绝。 */
function siteOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function uriRuleMatchScore(rule: LoginUriRule, page: URL): number {
  const stored = rule.uri.trim();
  if (!stored || rule.matchType === "never") return 0;
  if (rule.matchType === "host-port") {
    const storedAuthority = comparableAuthority(stored);
    return storedAuthority && storedAuthority === page.host.toLocaleLowerCase() ? 130 : 0;
  }
  if (rule.matchType === "exact") return comparableUrl(stored) === page.href ? 140 : 0;
  if (rule.matchType === "starts-with") return page.href.startsWith(comparableUrl(stored, false)) ? 120 : 0;
  if (rule.matchType === "regex") return matchesSafeRegex(stored, page.href) ? 115 : 0;

  const storedHost = normalizeHost(stored);
  const pageHost = normalizeHostname(page.hostname);
  if (!storedHost || !pageHost) return 0;
  // IP 字面量没有可注册域名，端口是区分同一主机上不同服务的唯一依据。
  // 规则显式写了端口时按“主机:端口”比较，避免 192.168.1.122:4000 命中 :9208。
  if (isIpLiteral(storedHost) && hasExplicitPort(stored)) {
    const storedAuthority = comparableAuthority(stored);
    if (!storedAuthority || storedAuthority !== page.host.toLocaleLowerCase()) return 0;
    return rule.matchType === "domain" ? 110 : 100;
  }
  if (rule.matchType === "domain") {
    if (storedHost === pageHost) return 110;
    return pageHost.endsWith(`.${storedHost}`) ? 90 : 0;
  }

  if (storedHost === pageHost) return 100;
  return registrableDomain(storedHost) === registrableDomain(pageHost) ? 80 : 0;
}

function parsePageUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function comparableUrl(value: string, ensureTrailingSlash = true): string {
  const candidate = value.trim();
  if (!candidate.includes("://")) return candidate;
  try {
    const url = new URL(candidate);
    if (!ensureTrailingSlash && url.pathname === "/" && !/[/?#]$/.test(candidate)) return url.href.slice(0, -1);
    return url.href;
  } catch {
    return candidate;
  }
}

function comparableAuthority(value: string): string {
  const candidate = value.trim();
  if (!candidate) return "";
  try {
    return new URL(candidate.includes("://") ? candidate : `https://${candidate}`).host.toLocaleLowerCase();
  } catch {
    return "";
  }
}

function hasExplicitPort(value: string): boolean {
  try {
    return new URL(value.trim().includes("://") ? value.trim() : `https://${value.trim()}`).port !== "";
  } catch {
    return false;
  }
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function matchesSafeRegex(pattern: string, value: string): boolean {
  if (pattern.length > MAX_REGEX_LENGTH || !safeRegex(pattern)) return false;
  try {
    return new RegExp(pattern, "i").test(value);
  } catch {
    return false;
  }
}

function registrableDomain(host: string): string {
  return getDomain(host, { allowPrivateDomains: true }) || host;
}

function normalizeHostname(host: string): string {
  return host.toLocaleLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}
