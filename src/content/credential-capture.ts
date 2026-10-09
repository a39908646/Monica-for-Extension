import type { CredentialCaptureInput } from "../runtime/messages";
import { loginFieldRole, loginPageIntent } from "./login-field-role";

const USERNAME_SELECTORS = [
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[autocomplete="tel"]',
  'input[type="email"]',
  'input[type="tel"]',
  'input[name*="email" i]',
  'input[id*="email" i]',
  'input[name*="user" i]',
  'input[id*="user" i]',
  'input[name*="phone" i]',
  'input[id*="phone" i]',
  'input[name*="mobile" i]',
  'input[id*="mobile" i]',
  'input[type="text"]'
];

/**
 * 提交动作发生时同步记录的字段取值，按元素索引。
 *
 * 页面常在自己的 submit/click 处理器里改写密码框：Discuz 的 `pwmd5` 会把密码换成 32 位 MD5 摘要，
 * 另一些站点会把密码搬进隐藏字段后清空可见输入框。而捕获必须等事件分派结束才能判断 `defaultPrevented`
 * （AJAX 登录页靠 preventDefault 拦截提交），那时读到的已经不是用户输入的密码。
 * 记下提交瞬间的取值，才能既保留延迟判断，又拿到真实凭据。
 */
export type SubmittedFieldValues = ReadonlyMap<HTMLInputElement, string>;

export function snapshotSubmittedValues(root: ParentNode): SubmittedFieldValues {
  const values = new Map<HTMLInputElement, string>();
  for (const input of root.querySelectorAll<HTMLInputElement>("input")) {
    if (input.value) values.set(input, input.value);
  }
  return values;
}

/** 提交瞬间的值优先：页面在提交处理器里改写过的值不再代表用户输入。 */
function submittedValue(input: HTMLInputElement, submitted?: SubmittedFieldValues): string {
  return submitted?.get(input) || input.value;
}

export function captureCredentialInput(root: ParentNode, rootDocument: Document = document, pageLocation: Location = location, fallbackUsername = "", submittedValues?: SubmittedFieldValues): CredentialCaptureInput | null {
  const passwordInputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    .filter((input) => !input.disabled && !input.readOnly && submittedValue(input, submittedValues).length > 0 && loginFieldRole(input, root) !== "totp");
  if (!passwordInputs.length) return null;

  const newPasswordInputs = passwordInputs.filter((input) => loginFieldRole(input, root) === "new-password");
  const currentPasswordInputs = passwordInputs.filter((input) => loginFieldRole(input, root) === "current-password");
  // 注册表单同样带新密码字段，但默认动作是另存为新项，不能和修改密码混为一谈。
  const captureKind: CredentialCaptureInput["captureKind"] = newPasswordInputs.length
    ? (loginPageIntent(root, pageLocation) === "signup" ? "signup" : "password-change")
    : "login";
  const password = choosePassword((newPasswordInputs.length ? newPasswordInputs : currentPasswordInputs).map((input) => submittedValue(input, submittedValues)));
  if (!password) return null;
  if (isMaskedPassword(password)) return null;
  const username = findUsername(root, passwordInputs, submittedValues) || fallbackUsername;
  return {
    username: username.trim(),
    password,
    pageUrl: pageLocation.href,
    pageTitle: rootDocument.title,
    captureKind
  };
}

export function captureUsernameInput(root: ParentNode): string {
  return findUsername(root, []).trim();
}

export function captureRootForEvent(target: EventTarget | null, rootDocument: Document = document): ParentNode {
  if (target instanceof rootDocument.defaultView!.HTMLFormElement) return target;
  if (target instanceof rootDocument.defaultView!.Element) return target.closest("form") || rootDocument;
  return rootDocument;
}

function choosePassword(values: string[]): string {
  if (values.length === 1) return values[0];
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const confirmed = [...counts.entries()].find(([, count]) => count >= 2)?.[0];
  return confirmed || values[values.length - 1];
}

// 验证码刷新、表单重置等页面行为可能把密码框填成掩码圆点或星号；
// 这些值不是用户输入的真实密码，捕获它们只会产生无意义的更新提示。
const MASKED_PASSWORD_PATTERN = /^[\u2022\u25cf\u00b7\uff0a*\u2043\u2219\u2500-\u25ff\u2013\u2014-]+$/;

export function isMaskedPassword(password: string): boolean {
  return password.length >= 4 && MASKED_PASSWORD_PATTERN.test(password);
}

function findUsername(root: ParentNode, passwordInputs: HTMLInputElement[], submittedValues?: SubmittedFieldValues): string {
  for (const selector of USERNAME_SELECTORS) {
    const candidate = Array.from(root.querySelectorAll<HTMLInputElement>(selector)).find((input) =>
      !passwordInputs.includes(input) && !input.disabled && !input.readOnly && submittedValue(input, submittedValues).trim().length > 0 && loginFieldRole(input, root) === "username"
    );
    if (candidate) return submittedValue(candidate, submittedValues);
  }
  return "";
}
