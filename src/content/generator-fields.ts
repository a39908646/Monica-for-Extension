import { loginFieldRole, loginFieldScope } from "./login-field-role";

/**
 * 页面内密码生成器的触发策略，镜像 Android 的 autofill_ng StrongPasswordSuggestionPolicy：
 * 表单必须有新密码字段，且（没有当前密码字段 或 新密码字段不少于两个）。
 * 这样站点把登录标识符错标成 new-password 时，生成器不会出现在标识符上。
 */
export function shouldOfferPasswordGenerator(scope: ParentNode): boolean {
  const roles = Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    .map((input) => loginFieldRole(input, scope));
  const newPasswords = roles.filter((role) => role === "new-password").length;
  if (!newPasswords) return false;
  const hasCurrentPassword = roles.includes("current-password");
  return !hasCurrentPassword || newPasswords >= 2;
}

/** 需要挂生成器图标的字段：当前表单里可见、可写的新密码字段（含确认框）。 */
export function generatorPasswordFields(scope: ParentNode, rootDocument: Document = document): HTMLInputElement[] {
  if (!shouldOfferPasswordGenerator(scope)) return [];
  return Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    .filter((input) => loginFieldRole(input, scope) === "new-password" && visibleInput(input, rootDocument));
}

/**
 * 填入时要一起写入的确认框：同一表单里其它新密码字段，且当前为空或与源字段相同。
 * 只镜像“空或一致”的字段，避免覆盖用户已经单独填写过的内容。
 */
export function generatorMirrorFields(scope: ParentNode, source: HTMLInputElement, rootDocument: Document = document): HTMLInputElement[] {
  return generatorPasswordFields(scope, rootDocument)
    .filter((input) => input !== source && (input.value === "" || input.value === source.value));
}

/** 文档里所有需要提供生成器的表单（用于首次扫描）。 */
export function generatorScopes(rootDocument: Document = document): ParentNode[] {
  const scopes = new Set<ParentNode>();
  for (const input of Array.from(rootDocument.querySelectorAll<HTMLInputElement>('input[type="password"]'))) {
    const scope = loginFieldScope(input, rootDocument);
    if (shouldOfferPasswordGenerator(scope)) scopes.add(scope);
  }
  return [...scopes];
}

/** 与内联菜单一致的可见性判定：不在 inert 子树、有实际尺寸、未被样式隐藏。 */
function visibleInput(input: HTMLInputElement, rootDocument: Document): boolean {
  const rect = input.getBoundingClientRect();
  return input.isConnected && !input.disabled && !input.readOnly && input.type !== "hidden"
    && !input.closest("[inert]") && rect.width > 0 && rect.height > 0
    && input.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    && input.ownerDocument === rootDocument;
}
