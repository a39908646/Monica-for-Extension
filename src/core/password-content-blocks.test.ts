import { describe, expect, it } from "vitest";
import type { SecureCustomField } from "./model";
import {
  applyContentBlocks,
  contentBlockDraft,
  contentBlockFromDraft,
  contentBlockOrderTokens,
  contentBlockToken,
  contentBlockValue,
  createContentBlockDraft,
  orderContentBlocks,
  putContentBlock,
  readContentBlocks,
  removeContentBlock,
  resolveContentBlockQrText,
  withContentOrder,
  withoutContentBlockFields
} from "./password-content-blocks";
import { bytesToBase64 } from "../security/encoding";
import { sha256HexBytes } from "./sha256";

const ID = "ffdba4b4-e793-4fd8-a62d-ef04ba5b5ff9";
const CHUNK = "monica.content.block." + ID + ".0000";

function field(name: string, value: string, protectedField = true): SecureCustomField {
  return { name, value, protected: protectedField, fieldType: protectedField ? "HIDDEN" : "TEXT" };
}

function header(parts: number, sha256: string): string {
  return JSON.stringify({ version: 1, encoding: "base64", parts, sha256 });
}

/** 直接构造 Android 侧的传输字段，避免测试依赖被测的写入实现。 */
function transport(id: string, envelope: Record<string, unknown>, options: { sha256?: string; parts?: number; extraHeader?: Record<string, unknown> } = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  const encoded = bytesToBase64(bytes);
  const chunks = encoded.match(/.{1,1600}/g) || [""];
  const declaredParts = options.parts ?? chunks.length;
  const manifest = JSON.stringify({ ...(options.extraHeader || {}), version: 1, encoding: "base64", parts: declaredParts, sha256: options.sha256 ?? sha256HexBytes(bytes) });
  return [
    field("monica.content.block." + id, manifest),
    ...chunks.map((text, index) => field("monica.content.block." + id + "." + String(index).padStart(4, "0"), text))
  ];
}

const apiKeyEnvelope = (data: Record<string, unknown> = {}, title = "示例") => ({
  version: 1, id: ID, kind: "API_KEY", title, data: { key: "synthetic-key", url: "https://example.invalid/api", notes: "备注", ...data }
});

describe("content block transport", () => {
  it("reads a canonical block and exposes its values", () => {
    const fields = [field("普通字段", "keep"), ...transport(ID, apiKeyEnvelope())];
    const [stored] = readContentBlocks(fields);
    expect(stored.id).toBe(ID);
    expect(stored.token).toBe(contentBlockToken(ID));
    expect(stored.block?.kind).toBe("API_KEY");
    expect(contentBlockValue(stored.block!, "key")).toBe("synthetic-key");
    expect(contentBlockValue(stored.block!, "notes")).toBe("备注");
  });

  it("keeps unknown internal and top-level keys when writing back an edited block", () => {
    const envelope = { ...apiKeyEnvelope({ futureField: "保留" }), futureTop: { nested: true } };
    const [stored] = readContentBlocks(transport(ID, envelope));
    const draft = contentBlockDraft(stored.block!);
    expect(draft.values.key).toBe("synthetic-key");
    draft.title = "改标题";
    draft.values.key = "rotated-key";
    const written = contentBlockFromDraft(draft);
    expect(written.envelope.futureTop).toEqual({ nested: true });
    expect((written.envelope.data as Record<string, unknown>).futureField).toBe("保留");
    expect(contentBlockValue(written, "key")).toBe("rotated-key");
    const fields = putContentBlock([field("邻居", "keep")], written);
    const [roundTrip] = readContentBlocks(fields);
    expect(roundTrip.block && contentBlockValue(roundTrip.block, "key")).toBe("rotated-key");
    expect(fields.find((item) => item.name === "邻居")).toBeTruthy();
  });

  it("splits large content into protected chunks and rejects content above the byte limit", () => {
    const longNotes = "长内容".repeat(2000);
    const fields = putContentBlock([], contentBlockFromDraft({ ...contentBlockDraft({ id: ID, kind: "API_KEY", envelope: apiKeyEnvelope() }), values: { key: "k", url: "", notes: longNotes } }));
    const manifest = JSON.parse(fields.find((item) => item.name === "monica.content.block." + ID)!.value);
    expect(manifest.parts).toBeGreaterThan(1);
    for (const item of fields) {
      expect(item.protected).toBe(true);
      expect(item.value.length).toBeLessThanOrEqual(1600);
    }
    const [stored] = readContentBlocks(fields);
    expect(contentBlockValue(stored.block!, "notes")).toBe(longNotes);
    expect(() => putContentBlock([], contentBlockFromDraft({ ...createContentBlockDraft("QR_CODE"), values: { content: "x".repeat(256 * 1024), notes: "" } }))).toThrow();
  });

  it("keeps damaged, duplicated, truncated or unknown blocks unreadable instead of guessing", () => {
    const damaged: Array<[string, SecureCustomField[]]> = [
      ["缺分片", transport(ID, apiKeyEnvelope()).slice(0, 1)],
      ["分片被截断", [...transport(ID, apiKeyEnvelope()).slice(0, 1), field(CHUNK, "AAAA")]],
      ["摘要不符", transport(ID, apiKeyEnvelope(), { sha256: "0".repeat(64) })],
      ["分片数量不符", transport(ID, apiKeyEnvelope(), { parts: 2 })],
      ["重复分片", [...transport(ID, apiKeyEnvelope()), field(CHUNK, "ZHVw")]],
      ["非规范 UUID", transport("FFDBA4B4-E793-4FD8-A62D-EF04BA5B5FF9", { ...apiKeyEnvelope(), id: "FFDBA4B4-E793-4FD8-A62D-EF04BA5B5FF9" })],
      ["未知类型", transport(ID, { ...apiKeyEnvelope(), kind: "FUTURE_KIND" })],
      ["版本不符", transport(ID, { ...apiKeyEnvelope(), version: 2 })],
      ["字段形状变化", transport(ID, apiKeyEnvelope({ key: 42 }))],
      ["二维码模式未知", transport(ID, { version: 1, id: ID, kind: "QR_CODE", title: "码", data: { content: "x", mode: "future" } })],
      ["模板版本未知", transport(ID, { version: 1, id: ID, kind: "QR_CODE", title: "码", data: { content: "x", mode: "template", templateVersion: "2" } })]
    ];
    for (const [label, fields] of damaged) {
      const snapshot = JSON.parse(JSON.stringify(fields)) as SecureCustomField[];
      const stored = readContentBlocks(fields);
      expect(stored, label).toHaveLength(1);
      expect(stored[0].block, label).toBeUndefined();
      // 读取不得改动原始字段，损坏内容也不能被替换成空表单。
      expect(fields, label).toEqual(snapshot);
    }
  });

  it("accepts a supported QR template block and rejects an unsupported mode", () => {
    const supported = transport(ID, { version: 1, id: ID, kind: "QR_CODE", title: "Wi-Fi", data: { content: "WIFI:T:WPA;S:%ACCOUNT%;P:%PASSWORD%;H:false;;", mode: "template", templateVersion: "1" } });
    const [stored] = readContentBlocks(supported);
    expect(stored.block?.kind).toBe("QR_CODE");
    expect(contentBlockValue(stored.block!, "mode")).toBe("template");
  });
});

describe("content block ordering and removal", () => {
  const second = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("orders blocks by monica.content.order and falls back to field order", () => {
    const fields = [
      ...transport(ID, apiKeyEnvelope()),
      ...transport(second, { version: 1, id: second, kind: "API_TOKEN", title: "令牌", data: { provider: "p", api_base: "", token: "t", notes: "" } }),
      field("monica.content.order", "NOTES," + contentBlockToken(second) + "," + contentBlockToken(ID))
    ];
    const stored = readContentBlocks(fields);
    expect(orderContentBlocks(stored, fields).map((item) => item.id)).toEqual([second, ID]);
    const withoutOrder = fields.filter((item) => item.name !== "monica.content.order");
    expect(orderContentBlocks(stored, withoutOrder).map((item) => item.id)).toEqual([ID, second]);
  });

  it("removes a readable block with its chunks and its order token, and refuses unreadable ones", () => {
    const fields = [field("普通", "keep"), ...transport(ID, apiKeyEnvelope()), field("monica.content.order", "NOTES," + contentBlockToken(ID))];
    const next = removeContentBlock(fields, contentBlockToken(ID));
    expect(next.map((item) => item.name)).toEqual(["普通", "monica.content.order"]);
    expect(next.find((item) => item.name === "monica.content.order")?.value).toBe("NOTES");
    expect(() => removeContentBlock(transport(ID, apiKeyEnvelope(), { sha256: "0".repeat(64) }), contentBlockToken(ID))).toThrow();
    expect(() => removeContentBlock(fields, contentBlockToken(second))).toThrow();
  });

  it("merges order tokens without dropping existing section tokens", () => {
    const fields = withContentOrder([field("monica.content.order", "NOTES," + contentBlockToken(ID))], [contentBlockToken(second)]);
    expect(contentBlockOrderTokens(fields)).toEqual([contentBlockToken(second), "NOTES", contentBlockToken(ID)]);
  });

  it("applies drafts, removals and order in one save step and never sends blocks to pages", () => {
    const fields = [
      field("普通", "keep"),
      ...transport(ID, apiKeyEnvelope()),
      ...transport(second, { version: 1, id: second, kind: "QR_CODE", title: "码", data: { content: "https://example.test", notes: "" } })
    ];
    const draft = contentBlockDraft(readContentBlocks(fields)[0].block!);
    draft.values.key = "rotated";
    const saved = applyContentBlocks(fields, [draft], [contentBlockToken(second)]);
    expect(saved.filter((item) => item.name === "普通")).toHaveLength(1);
    const stored = readContentBlocks(saved);
    expect(stored).toHaveLength(1);
    expect(stored[0].block && contentBlockValue(stored[0].block, "key")).toBe("rotated");
    expect(contentBlockOrderTokens(saved)).toEqual([contentBlockToken(ID)]);
  });

  it("strips every internal transport field from page-facing payloads", () => {
    const fields = [field("普通", "keep"), ...transport(ID, apiKeyEnvelope()), field("monica.content.order", contentBlockToken(ID))];
    expect(withoutContentBlockFields(fields)).toEqual([field("普通", "keep")]);
  });
});

describe("content block QR templates", () => {
  const values = {
    fields: { ACCOUNT: "user@example.test", PASSWORD: "synthetic-password", TITLE: "站点", URL: "https://example.test", EMAIL: "", PHONE: "", NOTES: "" },
    custom: [{ name: "自定义", value: "值", protected: false }]
  };
  const qrBlock = (data: Record<string, unknown>) => readContentBlocks(transport(ID, { version: 1, id: ID, kind: "QR_CODE", title: "码", data }))[0].block!;

  it("returns literal content unchanged and expands Wi-Fi templates with escaping", () => {
    expect(resolveContentBlockQrText(qrBlock({ content: "https://example.test/plain", notes: "" }), values)).toBe("https://example.test/plain");
    expect(resolveContentBlockQrText(qrBlock({ content: "WIFI:T:WPA;S:%TITLE%;P:%PASSWORD%;H:false;;", mode: "template", templateVersion: "1" }), values))
      .toBe("WIFI:T:WPA;S:站点;P:synthetic-password;H:false;;");
    expect(resolveContentBlockQrText(qrBlock({ content: "WIFI:T:WPA;S:%ACCOUNT%;H:false;;", mode: "template", templateVersion: "1" }), values))
      .toBe("WIFI:T:WPA;S:user@example.test;H:false;;");
  });

  it("supports literal percent, custom field placeholders and fails safely on unknown tokens", () => {
    const fieldToken = "%FIELD:" + bytesToBase64(new TextEncoder().encode("自定义")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + "%";
    expect(resolveContentBlockQrText(qrBlock({ content: "100%%" + fieldToken, mode: "template", templateVersion: "1" }), values)).toBe("100%值");
    expect(resolveContentBlockQrText(qrBlock({ content: "%UNKNOWN%", mode: "template", templateVersion: "1" }), values)).toBeUndefined();
    expect(resolveContentBlockQrText(qrBlock({ content: "%TITLE:x%", mode: "template", templateVersion: "1" }), values)).toBeUndefined();
    expect(resolveContentBlockQrText(qrBlock({ content: "%FIELD:missing%", mode: "template", templateVersion: "1" }), values)).toBeUndefined();
  });
});
