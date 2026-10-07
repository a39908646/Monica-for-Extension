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

function effectiveUriRules(item: LoginItem): LoginUriRule[] {
  if (item.uriRules?.length) return item.uriRules;
  return item.uris.map((uri) => ({ uri, matchType: "base-domain" }));
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
