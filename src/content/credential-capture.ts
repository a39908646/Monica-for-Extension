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

export function captureCredentialInput(root: ParentNode, rootDocument: Document = document, pageLocation: Location = location, fallbackUsername = ""): CredentialCaptureInput | null {
  const passwordInputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    .filter((input) => !input.disabled && !input.readOnly && input.value.length > 0 && loginFieldRole(input, root) !== "totp");
  if (!passwordInputs.length) return null;

  const newPasswordInputs = passwordInputs.filter((input) => loginFieldRole(input, root) === "new-password");
  const currentPasswordInputs = passwordInputs.filter((input) => loginFieldRole(input, root) === "current-password");
  // 注册表单同样带新密码字段，但默认动作是另存为新项，不能和修改密码混为一谈。
  const captureKind: CredentialCaptureInput["captureKind"] = newPasswordInputs.length
    ? (loginPageIntent(root, pageLocation) === "signup" ? "signup" : "password-change")
    : "login";
  const password = choosePassword(newPasswordInputs.length ? newPasswordInputs : currentPasswordInputs);
  if (!password) return null;
  if (isMaskedPassword(password)) return null;
  const username = findUsername(root, passwordInputs)?.value || fallbackUsername;
  return {
    username: username.trim(),
    password,
    pageUrl: pageLocation.href,
    pageTitle: rootDocument.title,
    captureKind
  };
}

export function captureUsernameInput(root: ParentNode): string {
  return (findUsername(root, [])?.value || "").trim();
}

export function captureRootForEvent(target: EventTarget | null, rootDocument: Document = document): ParentNode {
  if (target instanceof rootDocument.defaultView!.HTMLFormElement) return target;
  if (target instanceof rootDocument.defaultView!.Element) return target.closest("form") || rootDocument;
  return rootDocument;
}

function choosePassword(inputs: HTMLInputElement[]): string {
  if (inputs.length === 1) return inputs[0].value;
  const counts = new Map<string, number>();
  for (const input of inputs) counts.set(input.value, (counts.get(input.value) || 0) + 1);
  const confirmed = [...counts.entries()].find(([, count]) => count >= 2)?.[0];
  return confirmed || inputs[inputs.length - 1].value;
}

// 验证码刷新、表单重置等页面行为可能把密码框填成掩码圆点或星号；
// 这些值不是用户输入的真实密码，捕获它们只会产生无意义的更新提示。
const MASKED_PASSWORD_PATTERN = /^[\u2022\u25cf\u00b7\uff0a*\u2043\u2219\u2500-\u25ff\u2013\u2014-]+$/;

export function isMaskedPassword(password: string): boolean {
  return password.length >= 4 && MASKED_PASSWORD_PATTERN.test(password);
}

function findUsername(root: ParentNode, passwordInputs: HTMLInputElement[]): HTMLInputElement | undefined {
  for (const selector of USERNAME_SELECTORS) {
    const candidate = Array.from(root.querySelectorAll<HTMLInputElement>(selector)).find((input) =>
      !passwordInputs.includes(input) && !input.disabled && !input.readOnly && input.value.trim().length > 0 && loginFieldRole(input, root) === "username"
    );
    if (candidate) return candidate;
  }
  return undefined;
}
