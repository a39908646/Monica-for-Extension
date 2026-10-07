import type { VaultSessionSealer } from "../../security/vault-session";
import type { Mdbx2NativeClient } from "./native-client";

/**
 * Windows DPAPI session sealing through the Monica Native Host.
 *
 * The Host wraps the raw vault session key in current-user scope, so a
 * persisted session never stores the key in plaintext. DPAPI trusts the Windows
 * logon session: any process running as the same user can unseal the same blob,
 * which is why the settings panel states that scope explicitly.
 */
export class NativeDpapiSessionSealer implements VaultSessionSealer {
  constructor(private readonly client: Mdbx2NativeClient) {}

  async available(): Promise<boolean> {
    try {
      return (await this.client.hello()).supportsSessionSeal === true;
    } catch {
      return false;
    }
  }

  seal(rawKey: string): Promise<string> {
    return this.client.sealSessionKey(rawKey);
  }

  unseal(sealedKey: string): Promise<string> {
    return this.client.unsealSessionKey(sealedKey);
  }
}
