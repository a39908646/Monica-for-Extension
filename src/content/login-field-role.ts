import { elementByIdInRoot } from "./composed-dom";

export type LoginFieldRole = "username" | "current-password" | "new-password" | "totp" | "other";

const OTP_HINT = /^(totp|otp|2fa|twofa|mfa)(code|token|input|field|password)?$|^(code|token)(totp|otp|2fa|twofa|mfa)$|^(verification|verify|sms|auth|authentication|login)(code|token)$|^(动态|短信|登录|身份)验证码$/;
const AMBIGUOUS_CODE_HINT = /^(code|token|pin|securitycode|securitytoken|验证码|安全码|校验码)$/;
const NEW_PASSWORD_HINT = /(newpassword|confirmpassword|passwordconfirmation|createpassword|setpassword|新密码|确认密码|重复密码)/;
const NEW_PASSWORD_SCOPE = /(signup|sign-up|register|registration|createaccount|resetpassword|forgotpassword|changepassword|注册|创建账户|重置密码|修改密码|设置密码)/;
/** 表单意图：决定保存提示的默认动作，以及是否抑制内联菜单。 */
export type LoginPageIntent = "login" | "signup" | "password-change" | "password-reset";

// 注册与重置/改密必须分开：前者要另存为新项，后两者要更新已有密码。
const SIGNUP_INTENT = /(signup|sign-up|register|registration|createaccount|registerform|signupform|joinnow|新用户|注册|创建账户|创建帐号|创建账号|注册帐号|注册账号)/;
const PASSWORD_RESET_INTENT = /(resetpassword|passwordreset|resetpwd|forgotpassword|forgotpwd|forgot|重置密码|重设密码|找回密码|忘记密码)/;
const PASSWORD_CHANGE_INTENT = /(changepassword|change-password|updatepassword|update-password|passwordchange|修改密码|更改密码|变更密码)/;

/** 提交控件文案：用户按下它时正在做的事，判型的第一手信号。 */
const SIGNUP_ACTION = /(注册|创建账号|创建帐号|创建账户|sign.?up|register|create.?account|join)/;
const RESET_ACTION = /(重置密码|重设密码|找回密码|忘记密码|reset.?password|forgot)/;
const CHANGE_ACTION = /(修改密码|更改密码|变更密码|更新密码|change.?password|update.?password)/;
const LOGIN_ACTION = /(登录|登陆|登入|sign.?in|log.?in)/;

export function loginFieldRole(input: HTMLInputElement, fallbackRoot: ParentNode = input.ownerDocument): LoginFieldRole {
  const autocomplete = autocompleteTokens(input);
  const hints = inputHints(input);
  if (looksLikeOtpInput(input, autocomplete, hints)) return "totp";
  if (autocomplete.includes("new-password")) return "new-password";
  if (autocomplete.includes("current-password")) return "current-password";
  if (input.type === "password") {
    if (hints.some((hint) => NEW_PASSWORD_HINT.test(hint)) || likelyNewPasswordScope(loginFieldScope(input, fallbackRoot))) return "new-password";
    return "current-password";
  }
  if (autocomplete.some((token) => token === "username" || token === "email" || token === "tel")) return "username";
  if (input.type === "email" || input.type === "tel") return "username";
  if ((input.type === "text" || input.type === "search") && hints.some((hint) => /(user|login|email|phone|mobile|account|用户名|邮箱|手机|账号)/.test(hint))) return "username";
  if (hints.some((hint) => /(username|loginname|email|emailaddress|phone|phonenumber|mobile|accountname|用户名|邮箱|手机号|账号)/.test(hint))) return "username";
  if (input.type === "text" && isOnlyTextCandidateBeforePassword(input, fallbackRoot)) return "username";
  return "other";
}

export function loginFieldScope(input: HTMLInputElement, fallbackRoot: ParentNode = input.ownerDocument): ParentNode {
  if (input.form) return input.form;
  const semantic = input.closest<HTMLElement>('[role="form"],dialog,[aria-modal="true"]');
  if (semantic) return semantic;
  let current = input.parentElement;
  while (current && current !== input.ownerDocument.body) {
    if (current.querySelector('button[type="submit"],input[type="submit"]') && current.querySelector('input[type="password"]')) return current;
    current = current.parentElement;
  }
  return input.getRootNode() as ParentNode || fallbackRoot;
}

export function inputHints(input: HTMLInputElement): string[] {
  const labelledBy = (input.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
    .map((id) => elementByIdInRoot(input, id)?.textContent);
  return [input.id, input.name, input.getAttribute("aria-label"), input.placeholder, ...labelledBy, ...Array.from(input.labels || []).map((label) => label.textContent)]
    .map((value) => normalizeHint(value || ""))
    .filter(Boolean);
}

export function normalizeHint(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function autocompleteTokens(input: HTMLInputElement): string[] {
  return input.autocomplete.toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

function likelyNewPasswordScope(root: ParentNode): boolean {
  const passwords = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    .filter((input) => !looksLikeOtpInput(input, autocompleteTokens(input), inputHints(input)));
  const hasCurrent = passwords.some((input) => autocompleteTokens(input).includes("current-password"));
  if (passwords.length >= 2 && !hasCurrent) return true;
  return NEW_PASSWORD_SCOPE.test(`${scopeIdentitySemantics(root)} ${scopeTextSemantics(root)}`);
}

/**
 * 表单意图：只有一个新密码字段的表单可能是注册、重置或修改密码，三者默认动作不同。
 *
 * 优先级：提交控件文案 > 表单属性与路径 > 周边文案。
 * 按钮是用户此刻在做的事，比标题和说明文字直接得多；
 * 属性与路径是开发者写死的用途，按钮文案中性时（Discuz 注册页的按钮就叫「提交」）靠它兜底。
 * 仍不明确则按注册处理：把真实注册页当成“修改密码”会默认覆盖已有密码（静默丢失），
 * 而把重置或改密页当成注册页只会多出一条重复条目，用户可以手动合并或删除。
 */
export function loginPageIntent(scope: ParentNode, pageLocation?: Location): LoginPageIntent {
  const roles = Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    .map((input) => loginFieldRole(input, scope));
  if (!roles.includes("new-password")) return "login";
  const identity = scopeIdentitySemantics(scope, pageLocation);
  if (roles.includes("current-password") || PASSWORD_CHANGE_INTENT.test(identity)) return "password-change";
  // 按钮已经指名道姓时不必再猜：“注册并登录”按注册处理，另存为新项不会丢数据。
  const action = submitActionIntent(scope);
  if (action) return action;
  const signup = SIGNUP_INTENT.test(identity);
  const reset = PASSWORD_RESET_INTENT.test(identity);
  if (reset && !signup) return "password-reset";
  if (signup) return "signup";
  const text = scopeTextSemantics(scope);
  if (PASSWORD_RESET_INTENT.test(text) && !SIGNUP_INTENT.test(text)) return "password-reset";
  return "signup";
}

/**
 * 提交控件说的动作。绝大多数站点把“这次操作是什么”写在按钮上，所以它排在标题和说明文字前面。
 * 只认提交控件：页签、验证码刷新这类 `type="button"` 的按钮写的是“去哪儿”，不是这个表单在做什么。
 */
function submitActionIntent(scope: ParentNode): LoginPageIntent | undefined {
  const base = semanticScope(scope);
  if (!base) return undefined;
  const labels = Array.from(base.querySelectorAll<HTMLElement>(SUBMIT_CONTROL_SELECTOR))
    .filter((control) => !control.closest(NAVIGATION_SELECTOR))
    .map((control) => normalizeHint(`${control.textContent || ""} ${control.getAttribute("aria-label") || ""} ${control.getAttribute("value") || ""}`))
    .filter(Boolean)
    .join(" ");
  if (!labels) return undefined;
  if (SIGNUP_ACTION.test(labels)) return "signup";
  if (RESET_ACTION.test(labels)) return "password-reset";
  if (CHANGE_ACTION.test(labels)) return "password-change";
  // 按钮写着登录：说明这个“新密码”字段只是被页面文案误导，不该当注册处理。
  if (LOGIN_ACTION.test(labels)) return "login";
  return undefined;
}

/** 表单身份语义：路径与表单自身的标识属性，不含页面文案。 */
function scopeIdentitySemantics(scope: ParentNode, pageLocation?: Location): string {
  const ownerDocument = "defaultView" in scope ? scope as Document : scope.ownerDocument;
  const view = ownerDocument?.defaultView;
  const element = view && scope instanceof view.Element ? scope : undefined;
  const documentPath = pageLocation?.pathname || ownerDocument?.location?.pathname || "";
  return [documentPath, element?.id, element?.getAttribute("name"), element?.getAttribute("action"), element?.getAttribute("aria-label")]
    .filter(Boolean).join(" ").toLocaleLowerCase().replace(/[^\p{L}\p{N}-]/gu, "");
}

/**
 * 表单文案语义：表单自身与它周围容器的**用途文案**，作为属性不明确时的补充信号。
 *
 * 这里不取 form.textContent 的开头若干字符，原因有两个：
 * 1. 缩进空白会吃掉长度窗口 —— 同样一个 Discuz 登录表单，缩进深的页面只能看到“手机/用户名”，
 *    压成一行后“注册”就落入窗口，判型随排版漂移；
 * 2. 表单里的跳转链接不是表单用途 —— 「没有帐号？注册」「找回密码」是导航，不是这个表单在做什么。
 * 所以只统计表达用途的语义元素（标题/图例/标签/提交控件）与容器的直接文本，并跳过链接子树。
 */
/** 只认提交控件：页签、验证码刷新这类 type="button" 的按钮是导航，不是表单用途。 */
const SUBMIT_CONTROL_SELECTOR = 'button:not([type="button"]):not([type="reset"]),input[type="submit"]';
const SEMANTIC_TEXT_SELECTOR = `h1,h2,h3,h4,h5,h6,legend,label,caption,dt,th,summary,${SUBMIT_CONTROL_SELECTOR}`;
const NAVIGATION_SELECTOR = "a,script,style,noscript,template";
/** 向上找多少层容器：够拿到卡片/面板标题，又不至于把整站导航算进来。 */
const SURROUNDING_DEPTH = 6;
const MAX_SEMANTIC_TEXT = 500;

function scopeTextSemantics(scope: ParentNode): string {
  const base = semanticScope(scope);
  if (!base) return "";
  const ownerDocument = base.ownerDocument;
  const ownForm = base.closest("form");
  const parts = [semanticText(base, ownForm)];
  let node: Element | null = base;
  for (let depth = 0; depth < SURROUNDING_DEPTH; depth += 1) {
    const container: Element | null = node.parentElement;
    if (!container || container === ownerDocument.body || container === ownerDocument.documentElement) break;
    parts.push(semanticText(container, ownForm), directText(container));
    node = container;
  }
  // 先归一化再拼：长度预算花在真实文案上，而不是页面缩进上。
  return parts.map(normalizeHint).filter(Boolean).join(" ").slice(0, MAX_SEMANTIC_TEXT);
}

/** 语义文本的基准元素：传入表单/容器就用它，传入文档或 ShadowRoot 时用密码框所在的容器。 */
function semanticScope(scope: ParentNode): Element | undefined {
  const ownerDocument = "defaultView" in scope ? scope as Document : scope.ownerDocument;
  const view = ownerDocument?.defaultView;
  if (view && scope instanceof view.Element) return scope;
  const anchor = scope.querySelector<HTMLInputElement>('input[type="password"]');
  if (!anchor) return undefined;
  return anchor.closest<HTMLElement>('form,[role="form"],dialog,[aria-modal="true"]') || anchor.parentElement || undefined;
}

/** 只收表达用途的元素，并跳过导航链接：链接写的是“去哪儿”，不是“这是什么表单”。 */
function semanticText(root: ParentNode, ownForm: Element | null): string {
  const parts: string[] = [];
  for (const element of root.querySelectorAll<HTMLElement>(SEMANTIC_TEXT_SELECTOR)) {
    if (element.closest(NAVIGATION_SELECTOR)) continue;
    // 同页的另一个表单（比如登录/注册切换卡片）不属于本表单的用途。
    const owner = element.closest("form");
    if (owner && owner !== ownForm) continue;
    parts.push(element.textContent || "");
    if (element.tagName === "INPUT") parts.push((element as HTMLInputElement).value || "");
  }
  return parts.join(" ");
}

function directText(element: Element): string {
  return Array.from(element.childNodes)
    // Node.TEXT_NODE：只取容器自己的文本，避免把子元素（含链接）的内容重复算一遍。
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent || "")
    .join(" ");
}

function isOnlyTextCandidateBeforePassword(input: HTMLInputElement, fallbackRoot: ParentNode): boolean {
  const scope = loginFieldScope(input, fallbackRoot);
  const inputs = Array.from(scope.querySelectorAll<HTMLInputElement>("input"));
  const passwordIndex = inputs.findIndex((candidate) => candidate.type === "password"
    && !autocompleteTokens(candidate).includes("new-password")
    && !looksLikeOtpInput(candidate, autocompleteTokens(candidate), inputHints(candidate)));
  const inputIndex = inputs.indexOf(input);
  if (passwordIndex < 0 || inputIndex < 0 || inputIndex > passwordIndex) return false;
  const candidates = inputs.slice(0, passwordIndex).filter((candidate) =>
    !candidate.disabled
    && !candidate.readOnly
    && (candidate.type === "text" || candidate.type === "search" || candidate.type === "email" || candidate.type === "tel")
    && !inputHints(candidate).some((hint) => OTP_HINT.test(hint) || AMBIGUOUS_CODE_HINT.test(hint))
  );
  return candidates.length === 1 && candidates[0] === input;
}

function looksLikeOtpInput(input: HTMLInputElement, autocomplete = autocompleteTokens(input), hints = inputHints(input)): boolean {
  if (autocomplete.includes("one-time-code") || hints.some((hint) => OTP_HINT.test(hint))) return true;
  if (!hints.some((hint) => AMBIGUOUS_CODE_HINT.test(hint))) return false;
  const numeric = input.inputMode === "numeric"
    || input.inputMode === "decimal"
    || input.inputMode === "tel"
    || /\\d|0-9/.test(input.pattern);
  return numeric && input.maxLength >= 4 && input.maxLength <= 10;
}
