import type { CredentialCaptureInput } from "../runtime/messages";
import { captureCredentialInput, captureRootForEvent, captureUsernameInput } from "./credential-capture";
import { openShadowRoots } from "./composed-dom";
import { OPEN_SHADOW_ROOT_EVENT } from "./shadow-bridge";

export { OPEN_SHADOW_ROOT_EVENT } from "./shadow-bridge";

const USERNAME_CONTEXT_TTL_MS = 5 * 60 * 1_000;
const MONICA_UI_HOST_IDS = new Set(["monica-save-prompt-host", "monica-passkey-prompt-host", "monica-inline-autofill-host"]);

interface CaptureOptions {
  rootDocument?: Document;
  pageLocation?: Location;
  onCandidate: (candidate: CredentialCaptureInput, root: ParentNode) => void | Promise<void>;
  onUsernameContext?: (username: string) => void | Promise<void>;
  now?: () => number;
  usernameContextTtlMs?: number;
}

interface UsernameContext {
  origin: string;
  value: string;
  expiresAt: number;
  published: boolean;
}

export function installCredentialCapture(options: CaptureOptions): () => void {
  const rootDocument = options.rootDocument || document;
  const pageLocation = options.pageLocation || location;
  const view = rootDocument.defaultView;
  if (!view) return () => undefined;
  const now = options.now || Date.now;
  const usernameTtlMs = options.usernameContextTtlMs ?? USERNAME_CONTEXT_TTL_MS;
  const roots = new Set<Document | ShadowRoot>();
  const observers = new Map<Document | ShadowRoot, MutationObserver>();
  const handledEvents = new WeakSet<Event>();
  const clickTimers = new WeakMap<ParentNode, number>();
  const activeTimers = new Set<number>();
  let usernameContext: UsernameContext | undefined;
  let stopped = false;

  const rememberUsername = (root: ParentNode): void => {
    const value = captureUsernameInput(root);
    if (!value) return;
    const timestamp = now();
    if (usernameContext?.origin === pageLocation.origin && usernameContext.value === value && usernameContext.expiresAt >= timestamp) return;
    usernameContext = { origin: pageLocation.origin, value, expiresAt: timestamp + usernameTtlMs, published: false };
  };

  const recentUsername = (): string => {
    if (!usernameContext || usernameContext.origin !== pageLocation.origin || usernameContext.expiresAt < now()) {
      usernameContext = undefined;
      return "";
    }
    return usernameContext.value;
  };

  const capture = (root: ParentNode): void => {
    rememberUsername(root);
    const candidate = captureCredentialInput(root, rootDocument, pageLocation, recentUsername());
    if (candidate) {
      usernameContext = undefined;
      void options.onCandidate(candidate, root);
    } else if (usernameContext && !usernameContext.published) {
      usernameContext.published = true;
      void options.onUsernameContext?.(usernameContext.value);
    }
  };

  const clearClickFallback = (root: ParentNode): void => {
    const timer = clickTimers.get(root);
    if (timer === undefined) return;
    view.clearTimeout(timer);
    activeTimers.delete(timer);
    clickTimers.delete(root);
  };

  const onSubmit = (event: Event): void => {
    if (handledEvents.has(event)) return;
    if (isMonicaUiEvent(event, view)) {
      handledEvents.add(event);
      return;
    }
    // 捕获阶段 defaultPrevented 还未确定（页面 JS 在冒泡阶段 preventDefault 拦截 AJAX 动作）；
    // 延迟到事件分派完成后检查，被拦截的 submit（验证码刷新等）不做凭据捕获。
    handledEvents.add(event);
    const root = captureRootForEvent(deepestEventElement(event, view), rootDocument);
    clearClickFallback(root);
    const timer = view.setTimeout(() => {
      activeTimers.delete(timer);
      if (!stopped && !event.defaultPrevented) capture(root);
    }, 0);
    activeTimers.add(timer);
  };

  const onClick = (event: Event): void => {
    if (handledEvents.has(event)) return;
    if (isMonicaUiEvent(event, view)) {
      handledEvents.add(event);
      return;
    }
    const target = submissionControl(event, view);
    if (!target || !isCredentialSubmissionControl(target)) return;
    handledEvents.add(event);
    const root = captureRootForEvent(target, rootDocument);
    rememberUsername(root);
    clearClickFallback(root);
    const timer = view.setTimeout(() => {
      activeTimers.delete(timer);
      clickTimers.delete(root);
      if (!stopped) capture(root);
    }, 0);
    clickTimers.set(root, timer);
    activeTimers.add(timer);
  };

  const registerRoot = (root: Document | ShadowRoot): void => {
    if (stopped || roots.has(root) || (root instanceof view.ShadowRoot && !root.host.isConnected)) return;
    roots.add(root);
    root.addEventListener("submit", onSubmit, true);
    root.addEventListener("click", onClick, true);
    const observer = new view.MutationObserver((records) => {
      if (records.some((record) => record.removedNodes.length)) {
        for (const tracked of roots) {
          if (tracked instanceof view.ShadowRoot && !tracked.host.isConnected) {
            tracked.removeEventListener("submit", onSubmit, true);
            tracked.removeEventListener("click", onClick, true);
            observers.get(tracked)?.disconnect();
            observers.delete(tracked);
            roots.delete(tracked);
          }
        }
      }
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node.isConnected && (node instanceof view.Element || node instanceof view.DocumentFragment)) registerDescendantRoots(node);
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    observers.set(root, observer);
    registerDescendantRoots(root);
  };

  const registerDescendantRoots = (root: ParentNode): void => {
    for (const shadowRoot of openShadowRoots(root)) registerRoot(shadowRoot);
  };

  const onOpenShadowRoot = (event: Event): void => {
    const host = deepestEventElement(event, view);
    if (host?.shadowRoot) registerRoot(host.shadowRoot);
  };

  rootDocument.addEventListener(OPEN_SHADOW_ROOT_EVENT, onOpenShadowRoot, true);
  registerRoot(rootDocument);

  return () => {
    if (stopped) return;
    stopped = true;
    rootDocument.removeEventListener(OPEN_SHADOW_ROOT_EVENT, onOpenShadowRoot, true);
    for (const root of roots) {
      root.removeEventListener("submit", onSubmit, true);
      root.removeEventListener("click", onClick, true);
    }
    for (const observer of observers.values()) observer.disconnect();
    for (const timer of activeTimers) view.clearTimeout(timer);
    roots.clear();
    observers.clear();
    activeTimers.clear();
    usernameContext = undefined;
  };
}

function deepestEventElement(event: Event, view: Window & typeof globalThis): Element | null {
  return event.composedPath().find((node): node is Element => node instanceof view.Element)
    || (event.target instanceof view.Element ? event.target : null);
}

function submissionControl(event: Event, view: Window & typeof globalThis): Element | null {
  for (const node of event.composedPath()) {
    if (!(node instanceof view.Element)) continue;
    const control = node.closest('button,input[type="submit"],input[type="button"]');
    if (control) return control;
  }
  return event.target instanceof view.Element
    ? event.target.closest('button,input[type="submit"],input[type="button"]')
    : null;
}

function isCredentialSubmissionControl(target: Element): boolean {
  const type = target.getAttribute("type")?.toLowerCase();
  if (target.tagName === "INPUT") return type === "submit";
  if (type === "button" || type === "reset") {
    // 显式声明为普通按钮时，仅当 label 明确表达登录意图才视为提交（SPA 双步登录流程）。
    const label = controlLabel(target);
    return !ACTION_EXCLUSION_PATTERN.test(label) && SUBMISSION_LABEL_PATTERN.test(label);
  }
  if (type === "submit") return true;
  // 裸 <button> 在 HTML 里默认 type=submit，但大量页面用它做验证码刷新、图片重获等 AJAX 动作。
  // 只有 label 明确表达登录意图、且不含动作排除词时才视为提交控件。
  const label = controlLabel(target);
  return !ACTION_EXCLUSION_PATTERN.test(label) && SUBMISSION_LABEL_PATTERN.test(label);
}

const SUBMISSION_LABEL_PATTERN = /sign.?in|log.?in|登录|登入|继续|continue|submit|save|保存|更新|next|下一步|advance|approve/i;

// 验证码刷新、注册、找回密码等动作按钮绝不该触发凭据捕获；排除词优先于登录词。
const ACTION_EXCLUSION_PATTERN = /refresh|renew|regain|resend|reload|captcha|verif|code|image|picture|register|sign.?up|forgot|reset|获取|重获|重新|刷新|验证码|图片|注册|忘记|找回|重置|发送|换一|看不清|换张/i;

function controlLabel(target: Element): string {
  return `${target.textContent || ""} ${target.getAttribute("aria-label") || ""}`.toLowerCase();
}

function isMonicaUiEvent(event: Event, view: Window & typeof globalThis): boolean {
  return event.composedPath().some((node) => node instanceof view.Element && MONICA_UI_HOST_IDS.has(node.id));
}
