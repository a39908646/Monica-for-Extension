export interface VaultSessionRecord {
  /** Present for in-memory/session-storage sessions and after a sealed record is opened. */
  rawKey?: string;
  /** Present only in local storage: the session key wrapped by the platform sealer. */
  sealedKey?: string;
  lastActivityAt: number;
  expiresAt: number;
}

export interface VaultSessionWriteOptions {
  /**
   * Keep the session in local storage so it survives a browser restart.
   * The raw key is never written: it is wrapped by the session sealer first.
   * Only the "browser-restart" and "never" timeout policies use this mode.
   */
  persistent?: boolean;
}

/** Platform protection for a persisted session key (Windows DPAPI through the Native Host). */
export interface VaultSessionSealer {
  seal(rawKey: string): Promise<string>;
  unseal(sealedKey: string): Promise<string>;
  available(): Promise<boolean>;
}

export interface VaultSessionStore {
  read(): Promise<VaultSessionRecord | null>;
  write(session: VaultSessionRecord, options?: VaultSessionWriteOptions): Promise<void>;
  clear(): Promise<void>;
  /** Whether a persistent session can be protected at rest on this machine. */
  supportsPersistentSessions(): Promise<boolean>;
}

export class ChromeVaultSessionStore implements VaultSessionStore {
  private readonly key = "monica.secureVault.session.v1";
  /** Avoids a sealer round trip on every read/write while the worker is alive. */
  private opened?: { sealedKey: string; rawKey: string };
  private capability?: { value: boolean; expiresAt: number };

  constructor(private readonly sealer?: VaultSessionSealer) {}

  async supportsPersistentSessions(): Promise<boolean> {
    if (!this.sealer) return false;
    if (this.capability && this.capability.expiresAt > Date.now()) return this.capability.value;
    let value = false;
    try {
      value = await this.sealer.available();
    } catch {
      value = false;
    }
    this.capability = { value, expiresAt: Date.now() + 60_000 };
    return value;
  }

  async read(): Promise<VaultSessionRecord | null> {
    const persistent = await this.readArea(chrome.storage.local);
    if (persistent) return await this.openPersistent(persistent);
    return await this.readArea(chrome.storage.session);
  }

  async write(session: VaultSessionRecord, options: VaultSessionWriteOptions = {}): Promise<void> {
    // Sealing is best effort: when the Native Host is missing the session still
    // works for this browser session instead of blocking the unlock entirely.
    const sealedKey = options.persistent ? await this.sealedFor(session.rawKey ?? this.opened?.rawKey, session.sealedKey) : undefined;
    if (sealedKey) {
      await chrome.storage.local.set({ [this.key]: { sealedKey, lastActivityAt: session.lastActivityAt, expiresAt: session.expiresAt } });
      await chrome.storage.session.remove(this.key);
      return;
    }
    this.opened = undefined;
    await chrome.storage.session.set({ [this.key]: { rawKey: session.rawKey, lastActivityAt: session.lastActivityAt, expiresAt: session.expiresAt } });
    await chrome.storage.local.remove(this.key);
  }

  async clear(): Promise<void> {
    this.opened = undefined;
    await chrome.storage.session.remove(this.key);
    await chrome.storage.local.remove(this.key);
  }

  /** A sealed record that cannot be opened fails closed: the vault stays locked. */
  private async openPersistent(record: VaultSessionRecord): Promise<VaultSessionRecord | null> {
    if (!record.sealedKey) return null;
    if (this.opened?.sealedKey === record.sealedKey) {
      return { rawKey: this.opened.rawKey, lastActivityAt: record.lastActivityAt, expiresAt: record.expiresAt };
    }
    if (!this.sealer) return null;
    try {
      const rawKey = await this.sealer.unseal(record.sealedKey);
      if (!rawKey) return null;
      this.opened = { sealedKey: record.sealedKey, rawKey };
      return { rawKey, lastActivityAt: record.lastActivityAt, expiresAt: record.expiresAt };
    } catch {
      return null;
    }
  }

  private async sealedFor(rawKey: string | undefined, provided?: string): Promise<string | undefined> {
    if (provided) return provided;
    if (!rawKey || !this.sealer) return undefined;
    if (this.opened?.rawKey === rawKey) return this.opened.sealedKey;
    try {
      const sealedKey = await this.sealer.seal(rawKey);
      if (!sealedKey) return undefined;
      this.opened = { sealedKey, rawKey };
      return sealedKey;
    } catch {
      return undefined;
    }
  }

  private async readArea(area: chrome.storage.StorageArea): Promise<VaultSessionRecord | null> {
    const result = await area.get(this.key);
    const value = result[this.key] as VaultSessionRecord | undefined;
    if (!value || typeof value !== "object") return null;
    if (typeof value.rawKey !== "string" && typeof value.sealedKey !== "string") return null;
    return value;
  }
}

export class MemoryVaultSessionStore implements VaultSessionStore {
  session: VaultSessionRecord | null = null;

  async supportsPersistentSessions(): Promise<boolean> {
    return true;
  }

  async read(): Promise<VaultSessionRecord | null> {
    return this.session ? { ...this.session } : null;
  }

  async write(session: VaultSessionRecord): Promise<void> {
    this.session = { ...session };
  }

  async clear(): Promise<void> {
    this.session = null;
  }
}
