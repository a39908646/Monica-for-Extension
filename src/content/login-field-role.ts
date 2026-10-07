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
 * 优先用表单属性与路径判断；属性不明确时再看文案，仍不明确则按注册处理。
 * 这样处理的原因是：把真实注册页当成“修改密码”会默认覆盖已有密码（静默丢失），
 * 而把重置或改密页当成注册页只会多出一条重复条目，用户可以手动合并或删除。
 */
export function loginPageIntent(scope: ParentNode, pageLocation?: Location): LoginPageIntent {
  const roles = Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    .map((input) => loginFieldRole(input, scope));
  if (!roles.includes("new-password")) return "login";
  const identity = scopeIdentitySemantics(scope, pageLocation);
  if (roles.includes("current-password") || PASSWORD_CHANGE_INTENT.test(identity)) return "password-change";
  const signup = SIGNUP_INTENT.test(identity);
  const reset = PASSWORD_RESET_INTENT.test(identity);
  if (reset && !signup) return "password-reset";
  if (signup) return "signup";
  const text = scopeTextSemantics(scope);
  if (PASSWORD_RESET_INTENT.test(text) && !SIGNUP_INTENT.test(text)) return "password-reset";
  return "signup";
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

/** 表单文案语义：页面/表单开头可见文本，只作为属性不明确时的补充信号。 */
function scopeTextSemantics(scope: ParentNode): string {
  const ownerDocument = "defaultView" in scope ? scope as Document : scope.ownerDocument;
  const view = ownerDocument?.defaultView;
  const element = view && scope instanceof view.Element ? scope : undefined;
  return (element?.textContent || "").slice(0, 500).toLocaleLowerCase().replace(/[^\p{L}\p{N}-]/gu, "");
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
