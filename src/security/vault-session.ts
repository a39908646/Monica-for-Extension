export interface VaultSessionRecord {
  rawKey: string;
  lastActivityAt: number;
  expiresAt: number;
}

export interface VaultSessionWriteOptions {
  /**
   * Keep the session in local storage so it survives a browser restart.
   * Only the "browser-restart" and "never" timeout policies use this mode;
   * the session key is then readable by anything running on this machine.
   */
  persistent?: boolean;
}

export interface VaultSessionStore {
  read(): Promise<VaultSessionRecord | null>;
  write(session: VaultSessionRecord, options?: VaultSessionWriteOptions): Promise<void>;
  clear(): Promise<void>;
}

export class ChromeVaultSessionStore implements VaultSessionStore {
  private readonly key = "monica.secureVault.session.v1";

  async read(): Promise<VaultSessionRecord | null> {
    return await this.readArea(chrome.storage.local) ?? await this.readArea(chrome.storage.session);
  }

  async write(session: VaultSessionRecord, options: VaultSessionWriteOptions = {}): Promise<void> {
    const target = options.persistent ? chrome.storage.local : chrome.storage.session;
    const other = options.persistent ? chrome.storage.session : chrome.storage.local;
    await target.set({ [this.key]: session });
    await other.remove(this.key);
  }

  async clear(): Promise<void> {
    await chrome.storage.session.remove(this.key);
    await chrome.storage.local.remove(this.key);
  }

  private async readArea(area: chrome.storage.StorageArea): Promise<VaultSessionRecord | null> {
    const result = await area.get(this.key);
    const value = result[this.key] as VaultSessionRecord | undefined;
    return value && typeof value.rawKey === "string" ? value : null;
  }
}

export class MemoryVaultSessionStore implements VaultSessionStore {
  session: VaultSessionRecord | null = null;

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
