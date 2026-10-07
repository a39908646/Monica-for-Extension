import type { SecureCustomField } from "./model";
import { sha256HexBytes } from "./sha256";
import { base64ToBytes, bytesToBase64 } from "../security/encoding";

/**
 * Android 1.0.315+ 的“密码内容块”传输约定（Monica for Android
 * `data/model/PasswordContentBlocks.kt` 与 `docs/PASSWORD-CONTENT-BLOCKS-1.0.315.zh-CN.md`）。
 * API Key、API 令牌、SSH 密钥、GPG 密钥、二维码作为独立内容藏在普通密码条目的受保护自定义字段里：
 *
 * - manifest：`monica.content.block.<uuid>` = `{"version":1,"encoding":"base64","parts":N,"sha256":"…"}`
 * - 分片：`monica.content.block.<uuid>.0000` 起，四位十进制递增，Base64，每片最多 1600 字符
 * - 内容：manifest 与全部片段拼接后 Base64 解码，是 `{"version":1,"id","kind","title","data":{…}}`
 * - 顺序：`monica.content.order` 逗号分隔，用 `BLOCK:<uuid>` 标记内容块位置
 *
 * 本模块只做严格的读取、写回与 patch；任何校验失败都返回 undefined，调用方保留原始字段、
 * 不展示、不覆盖，避免把损坏或未来版本的内容块替换成空表单。
 */
export const CONTENT_BLOCK_PREFIX = "monica.content.block.";
export const CONTENT_BLOCK_ORDER_FIELD = "monica.content.order";
export const CONTENT_BLOCK_MAX_BYTES = 256 * 1024;
export const CONTENT_BLOCK_CHUNK_SIZE = 1600;
export const CONTENT_BLOCK_MAX_PARTS = 220;

/** 写入失败的原因码：界面据此取翻译文案，不用解析错误文本。 */
export type ContentBlockErrorCode = "too-large" | "missing-block" | "unreadable-block";

export class ContentBlockError extends Error {
  constructor(readonly code: ContentBlockErrorCode, message: string) {
    super(message);
    this.name = "ContentBlockError";
  }
}

const CONTENT_BLOCK_ERROR_MESSAGES: Record<ContentBlockErrorCode, string> = {
  "too-large": "内容块超过 256 KiB，无法保存。",
  "missing-block": "内容块不存在，未删除任何字段。",
  "unreadable-block": "无法读取的内容块不会被删除。"
};

/** 返回可直接交给 `tr()` 的文案键；不是内容块错误时返回 undefined。 */
export function contentBlockErrorMessageKey(error: unknown): string | undefined {
  return error instanceof ContentBlockError ? CONTENT_BLOCK_ERROR_MESSAGES[error.code] : undefined;
}

export type ContentBlockKind = "API_KEY" | "API_TOKEN" | "SSH_KEY" | "GPG_KEY" | "QR_CODE";
export const CONTENT_BLOCK_KINDS: readonly ContentBlockKind[] = ["API_KEY", "API_TOKEN", "SSH_KEY", "GPG_KEY", "QR_CODE"];

/** 与 Android `PasswordContentBlocks.editableKeys` 一致的可编辑字段与顺序。 */
const EDITABLE_KEYS: Record<ContentBlockKind, readonly string[]> = {
  API_KEY: ["key", "url", "notes"],
  API_TOKEN: ["provider", "api_base", "token", "notes"],
  SSH_KEY: ["algorithm", "keySize", "format", "publicKeyOpenSsh", "privateKeyOpenSsh", "fingerprintSha256", "comment", "notes"],
  GPG_KEY: ["publicKey", "privateKey", "fingerprint", "userId", "notes"],
  QR_CODE: ["content", "notes"]
};

/** Android `secretField()`：这些值在详情中默认隐藏。 */
const SECRET_KEYS = new Set(["key", "token", "privateKey", "privateKeyOpenSsh", "content"]);
/** 长内容按等宽整行展示。 */
const MONO_KEYS = new Set(["key", "token", "publicKeyOpenSsh", "privateKeyOpenSsh", "publicKey", "privateKey", "fingerprintSha256", "fingerprint", "content"]);
/** 空值不渲染成空行（Android 只在有值时显示字段）。 */
const OPTIONAL_KEYS = new Set(["notes", "comment", "userId", "format", "keySize", "algorithm", "provider", "url", "api_base", "fingerprintSha256", "fingerprint"]);

export const CONTENT_BLOCK_KIND_LABELS: Record<ContentBlockKind, string> = {
  API_KEY: "API Key",
  API_TOKEN: "API 令牌",
  SSH_KEY: "SSH 密钥",
  GPG_KEY: "GPG 密钥",
  QR_CODE: "二维码"
};

const CONTENT_BLOCK_FIELD_LABELS: Record<string, string> = {
  key: "密钥",
  token: "令牌",
  provider: "服务商",
  url: "接口地址",
  api_base: "接口地址",
  algorithm: "算法",
  keySize: "密钥位数",
  format: "格式",
  publicKeyOpenSsh: "公钥",
  publicKey: "公钥",
  privateKeyOpenSsh: "私钥",
  privateKey: "私钥",
  fingerprintSha256: "指纹",
  fingerprint: "指纹",
  comment: "身份／注释",
  userId: "身份／注释",
  content: "文本或链接",
  notes: "备注"
};

/** 已解码的内容块：`envelope` 保留未知顶层键与未知 data 键，写回时按 patch 更新。 */
export interface ContentBlock {
  id: string;
  kind: ContentBlockKind;
  envelope: Record<string, unknown>;
}

/** 编辑中的草稿：界面直接绑定 title/values，未知键仍留在 envelope 里。 */
export interface ContentBlockDraft {
  id: string;
  kind: ContentBlockKind;
  title: string;
  values: Record<string, string>;
  envelope: Record<string, unknown>;
}

/** `block` 缺失表示损坏、缺片、摘要不符或版本/类型不认识，只能保留原始字段。 */
export interface StoredContentBlock {
  id: string;
  token: string;
  block?: ContentBlock;
}

export function contentBlockToken(id: string): string {
  return `BLOCK:${id}`;
}

export function contentBlockIdFromToken(token: string): string | undefined {
  const value = token.startsWith("BLOCK:") ? token.slice("BLOCK:".length) : "";
  return isCanonicalUuid(value) ? value : undefined;
}

export function ownsContentBlockField(name: string): boolean {
  return name.startsWith(CONTENT_BLOCK_PREFIX);
}

/** 界面里不该逐条展示的内部字段：manifest、分片以及顺序字段。 */
export function isContentBlockInternalField(name: string): boolean {
  return ownsContentBlockField(name) || name === CONTENT_BLOCK_ORDER_FIELD;
}

export function contentBlockEditableKeys(kind: ContentBlockKind): readonly string[] {
  return EDITABLE_KEYS[kind];
}

export function contentBlockFieldLabel(key: string): string {
  return CONTENT_BLOCK_FIELD_LABELS[key] || CONTENT_BLOCK_FIELD_LABELS.notes;
}

export function contentBlockFieldIsSecret(key: string): boolean {
  return SECRET_KEYS.has(key);
}

export function contentBlockFieldIsMono(key: string): boolean {
  return MONO_KEYS.has(key);
}

export function contentBlockFieldIsOptional(key: string): boolean {
  return OPTIONAL_KEYS.has(key);
}

export function contentBlockKindLabel(kind: ContentBlockKind): string {
  return CONTENT_BLOCK_KIND_LABELS[kind];
}

/** 详情标题：块标题为空时退回类型名，与 Android 一致。 */
export function contentBlockDisplayTitle(block: ContentBlock): string {
  return contentBlockTitle(block).trim() || contentBlockKindLabel(block.kind);
}

export function contentBlockTitle(block: ContentBlock): string {
  const title = block.envelope.title;
  return typeof title === "string" ? title : "";
}

export function contentBlockValue(block: ContentBlock, key: string): string {
  const data = block.envelope.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

export function contentBlockDraft(block: ContentBlock): ContentBlockDraft {
  const values: Record<string, string> = {};
  for (const key of EDITABLE_KEYS[block.kind]) values[key] = contentBlockValue(block, key);
  return { id: block.id, kind: block.kind, title: contentBlockTitle(block), values, envelope: block.envelope };
}

export function createContentBlockDraft(kind: ContentBlockKind): ContentBlockDraft {
  const values: Record<string, string> = {};
  for (const key of EDITABLE_KEYS[kind]) values[key] = "";
  return { id: crypto.randomUUID(), kind, title: "", values, envelope: { version: 1, id: "", kind, title: "", data: {} } };
}

export function contentBlockFromDraft(draft: ContentBlockDraft): ContentBlock {
  const envelope = isJsonObject(draft.envelope) ? { ...draft.envelope } : {};
  const data = isJsonObject(envelope.data) ? { ...envelope.data } : {};
  for (const key of EDITABLE_KEYS[draft.kind]) data[key] = draft.values[key] || "";
  return {
    id: draft.id,
    kind: draft.kind,
    envelope: { ...envelope, version: 1, id: draft.id, kind: draft.kind, title: draft.title, data }
  };
}

export function readContentBlocks(fields: readonly SecureCustomField[]): StoredContentBlock[] {
  const ids: string[] = [];
  for (const field of fields) {
    if (!ownsContentBlockField(field.name)) continue;
    const id = field.name.slice(CONTENT_BLOCK_PREFIX.length).split(".")[0];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.map((id) => ({ id, token: contentBlockToken(id), block: decodeContentBlock(fields, id) }));
}

/** 详情展示顺序：先按 `monica.content.order` 里的 `BLOCK:` 令牌，其余按字段出现顺序。 */
export function orderContentBlocks(stored: readonly StoredContentBlock[], fields: readonly SecureCustomField[]): StoredContentBlock[] {
  const tokens = contentBlockOrderTokens(fields);
  const rank = (token: string) => {
    const index = tokens.indexOf(token);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  return stored.map((item, index) => ({ item, index }))
    .sort((left, right) => rank(left.item.token) - rank(right.item.token) || left.index - right.index)
    .map((entry) => entry.item);
}

export function contentBlockOrderTokens(fields: readonly SecureCustomField[]): string[] {
  const field = fields.find((candidate) => candidate.name === CONTENT_BLOCK_ORDER_FIELD);
  if (!field) return [];
  return field.value.split(",").map((token) => token.trim()).filter(Boolean);
}

/**
 * 写回一个内容块（Android `PasswordContentBlocks.put`）：替换同名 manifest 与全部分片，
 * 保留旧 manifest 里不认识的键，新字段一律 `protected=true`，未知的其他自定义字段原样保留。
 */
export function putContentBlock(fields: readonly SecureCustomField[], block: ContentBlock): SecureCustomField[] {
  const bytes = new TextEncoder().encode(JSON.stringify(block.envelope));
  if (bytes.byteLength > CONTENT_BLOCK_MAX_BYTES) throw new ContentBlockError("too-large", "内容块超过 256 KiB，无法保存。");
  const chunks = bytesToBase64(bytes).match(new RegExp(`.{1,${CONTENT_BLOCK_CHUNK_SIZE}}`, "g")) || [];
  const manifestName = CONTENT_BLOCK_PREFIX + block.id;
  const previousManifest = fields.find((field) => field.name === manifestName);
  const previousHeader = previousManifest ? parseJsonObject(previousManifest.value) : undefined;
  const header = { ...(previousHeader || {}), version: 1, encoding: "base64", parts: chunks.length, sha256: sha256HexBytes(bytes) };
  const next = fields.filter((field) => !isContentBlockFieldOf(field.name, block.id)).map((field) => ({ ...field }));
  next.push(contentBlockField(previousManifest, manifestName, JSON.stringify(header)));
  chunks.forEach((text, index) => {
    const name = contentBlockChunkName(block.id, index);
    next.push(contentBlockField(fields.find((field) => field.name === name), name, text));
  });
  return next;
}

/** 删除一个内容块：manifest、全部片段，以及顺序字段里的 `BLOCK:` 令牌。
 * 与 Android 一致：无法读取的块不得删除，调用方必须让用户先看到原内容。 */
export function removeContentBlock(fields: readonly SecureCustomField[], token: string): SecureCustomField[] {
  const stored = readContentBlocks(fields).find((item) => item.token === token);
  if (!stored) throw new ContentBlockError("missing-block", "内容块不存在，未删除任何字段。");
  if (!stored.block) throw new ContentBlockError("unreadable-block", "无法读取的内容块不会被删除。");
  const id = stored.id;
  const next = fields.filter((field) => !isContentBlockFieldOf(field.name, id)).map((field) => ({ ...field }));
  return next.map((field) => field.name === CONTENT_BLOCK_ORDER_FIELD
    ? { ...field, value: field.value.split(",").map((item) => item.trim()).filter((item) => item && item !== token).join(",") }
    : field);
}

/** 顺序字段合并：保留已有令牌（含非内容块的 section 令牌），追加新令牌，与 Android `withOrder` 一致。 */
export function withContentOrder(fields: readonly SecureCustomField[], tokens: readonly string[]): SecureCustomField[] {
  const merged = [...new Set([...tokens.filter(Boolean), ...contentBlockOrderTokens(fields)])];
  if (!merged.length) return fields.map((field) => ({ ...field }));
  const existing = fields.find((field) => field.name === CONTENT_BLOCK_ORDER_FIELD);
  const next = fields.filter((field) => field.name !== CONTENT_BLOCK_ORDER_FIELD).map((field) => ({ ...field }));
  next.push({ ...(existing || {}), name: CONTENT_BLOCK_ORDER_FIELD, value: merged.join(","), protected: existing?.protected ?? false });
  return next;
}

/** 保存时的统一入口：先删除被移除的块，再写回草稿，最后补顺序令牌。 */
export function applyContentBlocks(
  fields: readonly SecureCustomField[],
  drafts: readonly ContentBlockDraft[],
  removedTokens: readonly string[] = []
): SecureCustomField[] {
  let next = fields.map((field) => ({ ...field }));
  for (const token of removedTokens) next = removeContentBlock(next, token);
  for (const draft of drafts) next = putContentBlock(next, contentBlockFromDraft(draft));
  return withContentOrder(next, drafts.map((draft) => contentBlockToken(draft.id)));
}

/** 交给页面自动填充的自定义字段：内容块传输字段带着秘密的 Base64，绝不外发。 */
export function withoutContentBlockFields(fields: readonly SecureCustomField[]): SecureCustomField[] {
  return fields.filter((field) => !isContentBlockInternalField(field.name));
}

function isContentBlockFieldOf(name: string, id: string): boolean {
  const manifestName = CONTENT_BLOCK_PREFIX + id;
  return name === manifestName || name.startsWith(`${manifestName}.`);
}

function contentBlockChunkName(id: string, index: number): string {
  return `${CONTENT_BLOCK_PREFIX}${id}.${String(index).padStart(4, "0")}`;
}

function contentBlockField(previous: SecureCustomField | undefined, name: string, value: string): SecureCustomField {
  // Android 保存时把所有块字段写成 is_protected=true；未知类型信息沿用原字段。
  return { ...(previous || {}), name, value, protected: true, fieldType: "HIDDEN" };
}

function decodeContentBlock(fields: readonly SecureCustomField[], id: string): ContentBlock | undefined {
  if (!isCanonicalUuid(id)) return undefined;
  const manifestName = CONTENT_BLOCK_PREFIX + id;
  const manifests = fields.filter((field) => field.name === manifestName);
  if (manifests.length !== 1) return undefined;
  const header = parseJsonObject(manifests[0].value);
  if (!header || header.version !== 1 || header.encoding !== "base64") return undefined;
  const parts = header.parts;
  if (typeof parts !== "number" || !Number.isInteger(parts) || parts < 1 || parts > CONTENT_BLOCK_MAX_PARTS) return undefined;
  const suffixFields = fields.filter((field) => field.name.startsWith(`${manifestName}.`));
  if (suffixFields.length !== parts) return undefined;
  let encoded = "";
  for (let index = 0; index < parts; index += 1) {
    const name = contentBlockChunkName(id, index);
    const chunks = suffixFields.filter((field) => field.name === name);
    if (chunks.length !== 1 || chunks[0].value.length > CONTENT_BLOCK_CHUNK_SIZE) return undefined;
    encoded += chunks[0].value;
  }
  const bytes = decodeBase64Strict(encoded);
  if (!bytes || bytes.byteLength > CONTENT_BLOCK_MAX_BYTES) return undefined;
  if (typeof header.sha256 !== "string" || sha256HexBytes(bytes) !== header.sha256) return undefined;
  const text = decodeUtf8Strict(bytes);
  if (text === undefined) return undefined;
  const envelope = parseJsonObject(text);
  if (!envelope || envelope.version !== 1 || envelope.id !== id || typeof envelope.title !== "string") return undefined;
  const kind = envelope.kind;
  if (typeof kind !== "string" || !isContentBlockKind(kind)) return undefined;
  const data = envelope.data;
  if (!isJsonObject(data)) return undefined;
  for (const key of EDITABLE_KEYS[kind]) {
    if (data[key] !== undefined && typeof data[key] !== "string") return undefined;
  }
  if (kind === "QR_CODE") {
    for (const key of ["mode", "templateVersion"]) {
      if (data[key] !== undefined && typeof data[key] !== "string") return undefined;
    }
    if (!qrTemplateSupported(data)) return undefined;
  }
  return { id, kind, envelope };
}

function isContentBlockKind(value: string): value is ContentBlockKind {
  return (CONTENT_BLOCK_KINDS as readonly string[]).includes(value);
}

function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Java `Base64.getDecoder()` 的宽容性有限：这里仍只接受标准字母表与合法长度。 */
function decodeBase64Strict(text: string): Uint8Array | undefined {
  if (!text || text.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return undefined;
  try {
    return base64ToBytes(text.padEnd(Math.ceil(text.length / 4) * 4, "="));
  } catch {
    return undefined;
  }
}

function decodeUtf8Strict(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 二维码内容：字段模板（`mode="template"`、`templateVersion="1"`）按当前条目字段展开，
// 与 Android `PasswordQrTemplate` 保持同样的占位符、Wi-Fi 转义与失败语义。
// ---------------------------------------------------------------------------

export interface ContentBlockQrValues {
  fields: Record<string, string>;
  custom: readonly SecureCustomField[];
}

export function contentBlockQrIsTemplate(block: ContentBlock): boolean {
  return contentBlockValue(block, "mode") === "template";
}

export function contentBlockQrTemplateSupported(block: ContentBlock): boolean {
  const data = isJsonObject(block.envelope.data) ? block.envelope.data : {};
  return qrTemplateSupported(data);
}

function qrTemplateSupported(data: Record<string, unknown>): boolean {
  const mode = typeof data.mode === "string" ? data.mode : "";
  if (mode === "" || mode === "literal") return true;
  return mode === "template" && data.templateVersion === "1";
}

/** 返回要编码进二维码的文本；模板展开失败或不是受支持的模板时返回 undefined。 */
export function resolveContentBlockQrText(block: ContentBlock, values: ContentBlockQrValues): string | undefined {
  const content = contentBlockValue(block, "content");
  if (!contentBlockQrIsTemplate(block) || !contentBlockQrTemplateSupported(block)) return content || "";
  try {
    return renderQrTemplate(content, values);
  } catch {
    return undefined;
  }
}

export function renderQrTemplate(template: string, values: ContentBlockQrValues): string {
  if (new TextEncoder().encode(template).byteLength > CONTENT_BLOCK_MAX_BYTES) throw new Error("二维码模板过大。");
  const wifi = template.toLowerCase().startsWith("wifi:");
  const tokens = /%%|%([A-Z][A-Z0-9_]*)(?::([^%]*))?%/g;
  let result = "";
  let offset = 0;
  for (const match of template.matchAll(tokens)) {
    const start = match.index ?? 0;
    result += template.slice(offset, start);
    if (match[0] === "%%") result += "%";
    else {
      const key = match[1];
      const parameter = match[2] || "";
      if (key === "FIELD") {
        const name = decodeBase64UrlText(parameter);
        if (name === undefined) throw new Error("二维码模板字段无效。");
        const matches = values.custom.filter((field) => field.name === name);
        if (matches.length !== 1) throw new Error("二维码模板引用的字段不存在。");
        result += wifi ? escapeWifiQrValue(matches[0].value) : matches[0].value;
      } else {
        if (parameter) throw new Error("二维码模板占位符无效。");
        const value = values.fields[key];
        if (value === undefined) throw new Error("二维码模板字段未知。");
        result += wifi ? escapeWifiQrValue(value) : value;
      }
    }
    if (new TextEncoder().encode(result).byteLength > CONTENT_BLOCK_MAX_BYTES) throw new Error("二维码模板展开结果过大。");
    offset = start + match[0].length;
  }
  result += template.slice(offset);
  if (new TextEncoder().encode(result).byteLength > CONTENT_BLOCK_MAX_BYTES) throw new Error("二维码模板展开结果过大。");
  return result;
}

export function escapeWifiQrValue(value: string): string {
  return value.replace(/([\\;,:"])/g, "\\$1");
}

function decodeBase64UrlText(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
  try {
    return decodeUtf8Strict(base64ToBytes(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")));
  } catch {
    return undefined;
  }
}
