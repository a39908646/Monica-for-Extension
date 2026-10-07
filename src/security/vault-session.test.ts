import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeVaultSessionStore, type VaultSessionSealer } from "./vault-session";

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

function fakeSealer(overrides: Partial<VaultSessionSealer> = {}): VaultSessionSealer {
  return {
    async available() { return true; },
    async seal(rawKey: string) { return `sealed.${[...rawKey].reverse().join("")}`; },
    async unseal(sealedKey: string) {
      if (!sealedKey.startsWith("sealed.")) throw new Error("sealed blob is not readable");
      return [...sealedKey.slice("sealed.".length)].reverse().join("");
    },
    ...overrides
  };
}

function installChrome(local: ReturnType<typeof storageArea>, session: ReturnType<typeof storageArea>) {
  vi.stubGlobal("chrome", { storage: { local, session } });
}

const KEY = "monica.secureVault.session.v1";

describe("vault session store", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the session key in session storage for the timed policies", async () => {
    const local = storageArea();
    const session = storageArea();
    installChrome(local, session);
    const store = new ChromeVaultSessionStore(fakeSealer());

    await store.write({ rawKey: "session-key", lastActivityAt: 1, expiresAt: 2 });
    expect(session.entries.get(KEY)).toMatchObject({ rawKey: "session-key" });
    expect(local.entries.size).toBe(0);
    expect(await store.read()).toMatchObject({ rawKey: "session-key" });
  });

  it("seals the key instead of writing it when the policy is persistent", async () => {
    const local = storageArea();
    const session = storageArea();
    installChrome(local, session);
    const store = new ChromeVaultSessionStore(fakeSealer());

    await store.write({ rawKey: "raw-key", lastActivityAt: 3, expiresAt: 4 }, { persistent: true });
    expect(local.entries.get(KEY)).toEqual({ sealedKey: "sealed.yek-war", lastActivityAt: 3, expiresAt: 4 });
    expect(JSON.stringify(local.entries.get(KEY))).not.toContain("raw-key");
    expect(session.entries.size).toBe(0);
    expect(await store.read()).toMatchObject({ rawKey: "raw-key", lastActivityAt: 3, expiresAt: 4 });
  });

  it("reuses the sealed blob for activity refreshes instead of resealing", async () => {
    const local = storageArea();
    const session = storageArea();
    installChrome(local, session);
    const seal = vi.fn(async (rawKey: string) => `sealed.${[...rawKey].reverse().join("")}`);
    const store = new ChromeVaultSessionStore(fakeSealer({ seal }));

    await store.write({ rawKey: "raw-key", lastActivityAt: 3, expiresAt: 4 }, { persistent: true });
    await store.write({ rawKey: "raw-key", lastActivityAt: 5, expiresAt: 6 }, { persistent: true });
    expect(seal).toHaveBeenCalledTimes(1);
    expect(local.entries.get(KEY)).toMatchObject({ lastActivityAt: 5, expiresAt: 6 });
  });

  it("falls back to session storage when the sealer is unavailable", async () => {
    const local = storageArea();
    const session = storageArea();
    installChrome(local, session);
    const store = new ChromeVaultSessionStore(fakeSealer({ seal: async () => { throw new Error("host missing"); } }));

    await store.write({ rawKey: "raw-key", lastActivityAt: 1, expiresAt: 2 }, { persistent: true });
    expect(local.entries.size).toBe(0);
    expect(session.entries.get(KEY)).toMatchObject({ rawKey: "raw-key" });
  });

  it("reports persistent support only when a sealer is available", async () => {
    const local = storageArea();
    const session = storageArea();
    installChrome(local, session);
    expect(await new ChromeVaultSessionStore().supportsPersistentSessions()).toBe(false);
    expect(await new ChromeVaultSessionStore(fakeSealer()).supportsPersistentSessions()).toBe(true);
    expect(await new ChromeVaultSessionStore(fakeSealer({ available: async () => false })).supportsPersistentSessions()).toBe(false);
  });

  it("fails closed when a sealed record cannot be opened", async () => {
    const local = storageArea();
    const session = storageArea();
    local.entries.set(KEY, { sealedKey: "corrupted", lastActivityAt: 1, expiresAt: 2 });
    installChrome(local, session);
    expect(await new ChromeVaultSessionStore(fakeSealer()).read()).toBeNull();
    expect(await new ChromeVaultSessionStore().read()).toBeNull();
  });

  it("clears both storage areas and ignores unusable records", async () => {
    const local = storageArea();
    const session = storageArea();
    installChrome(local, session);
    const store = new ChromeVaultSessionStore(fakeSealer());
    await store.write({ rawKey: "raw-key", lastActivityAt: 1, expiresAt: 2 }, { persistent: true });
    await store.write({ rawKey: "raw-key", lastActivityAt: 1, expiresAt: 2 });
    await store.clear();
    expect(local.entries.size).toBe(0);
    expect(session.entries.size).toBe(0);
    expect(await store.read()).toBeNull();

    session.entries.set(KEY, { lastActivityAt: 1, expiresAt: 2 });
    expect(await store.read()).toBeNull();
  });
});
