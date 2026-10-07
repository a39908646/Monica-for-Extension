import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Digest, sha256HexBytes } from "./sha256";

const encode = (value: string) => new TextEncoder().encode(value);
const nodeDigest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("pure JS SHA-256", () => {
  it("matches published vectors", () => {
    expect(sha256HexBytes(encode(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256HexBytes(encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256HexBytes(encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))
      .toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("handles multi-block and byte-length padding identically to the platform digest", () => {
    for (const length of [1, 55, 56, 63, 64, 65, 1000, 65_536, 200_000]) {
      const bytes = new Uint8Array(randomBytes(length));
      expect(sha256HexBytes(bytes), `length ${length}`).toBe(nodeDigest(bytes));
    }
  });

  it("returns the raw digest as bytes", () => {
    const digest = sha256Digest(encode("abc"));
    expect(Array.from(digest)).toHaveLength(32);
    expect(Buffer.from(digest).toString("hex")).toBe(nodeDigest(encode("abc")));
  });
});
