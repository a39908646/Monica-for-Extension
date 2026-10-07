import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeVaultSessionStore } from "./vault-session";

function storageArea() {
  const entries = new Map<string, unknown>();
  return {
    entries,
    async get(key: string) {
      return entries.has(key) ? { [key]: entries.get(key) } : {};
    },
    async set(values: Record<string, unknown>) {
      for (const [key, value] of Object.entries(values)) entries.set(key, value);
    },
    async remove(key: string) {
      entries.delete(key);
    }
  };
}

describe("vault session store", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the session key in session storage unless the timeout policy is persistent", async () => {
    const local = storageArea();
    const session = storageArea();
    vi.stubGlobal("chrome", { storage: { local, session } });
    const store = new ChromeVaultSessionStore();

    await store.write({ rawKey: "session-key", lastActivityAt: 1, expiresAt: 2 });
    expect(session.entries.size).toBe(1);
    expect(local.entries.size).toBe(0);
    expect(await store.read()).toMatchObject({ rawKey: "session-key" });

    await store.write({ rawKey: "persistent-key", lastActivityAt: 3, expiresAt: 4 }, { persistent: true });
    expect(local.entries.size).toBe(1);
    expect(session.entries.size).toBe(0);
    expect(await store.read()).toMatchObject({ rawKey: "persistent-key" });

    await store.clear();
    expect(local.entries.size).toBe(0);
    expect(session.entries.size).toBe(0);
    expect(await store.read()).toBeNull();
  });

  it("ignores records that carry no usable key", async () => {
    const local = storageArea();
    const session = storageArea();
    session.entries.set("monica.secureVault.session.v1", { lastActivityAt: 1, expiresAt: 2 });
    vi.stubGlobal("chrome", { storage: { local, session } });
    expect(await new ChromeVaultSessionStore().read()).toBeNull();
  });
});
