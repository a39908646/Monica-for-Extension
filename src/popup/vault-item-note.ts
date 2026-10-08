import type { LoginMatchSummary } from "../runtime/messages";
import { tr } from "../i18n/runtime";

/**
 * 弹窗「全部登录项 / 搜索结果」里的条目按构造都不匹配当前网站（该列表 = 全部登录项 − 已匹配项），
 * 所以点它填充必然被「登录项与目标页面不匹配」拦下。这里把原因写清楚，
 * 否则用户只会看到一张点不动的卡片，以为是自动填充坏了。
 */
export function vaultItemNote(item: LoginMatchSummary): string {
  const parts: string[] = [];
  parts.push(item.uris.length ? `${tr('网址')}：${item.uris.join(' · ')}` : tr('未保存网址'));
  parts.push(tr('与当前网站不匹配'));
  return parts.join(' · ');
}
