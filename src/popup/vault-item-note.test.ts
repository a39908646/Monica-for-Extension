import { describe, expect, it } from "vitest";
import type { LoginMatchSummary } from "../runtime/messages";
import { vaultItemNote } from "./vault-item-note";

const item = (patch: Partial<LoginMatchSummary> = {}): LoginMatchSummary => ({
  id: "login-1",
  title: "百变小樱",
  username: "a39908646@gmail.com",
  favorite: false,
  uris: [],
  hasTotp: false,
  ...patch
});

describe("popup vault item note", () => {
  it("names the saved website when the item simply does not match the page", () => {
    expect(vaultItemNote(item({ uris: ["https://other.example"] }))).toBe("网址：https://other.example · 与当前网站不匹配");
  });

  it("says an item without a saved website never matches", () => {
    expect(vaultItemNote(item())).toBe("未保存网址 · 与当前网站不匹配");
  });

  it("lists every saved website so the mismatch is obvious", () => {
    expect(vaultItemNote(item({ uris: ["https://bbxy.buzz", "https://www.bbxy.buzz/v2/login"] })))
      .toBe("网址：https://bbxy.buzz · https://www.bbxy.buzz/v2/login · 与当前网站不匹配");
  });
});
