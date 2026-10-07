import type { LoginItem } from "./model";

export interface CredentialCaptureCandidate {
  username: string;
  password: string;
}

/**
 * True when the submitted credentials already match a stored login for this page,
 * so the "update password" prompt would only repeat what the vault already has.
 *
 * A submission counts as unchanged when a matching login stores exactly the same
 * password, and either the capture carries no username or it matches that login.
 * Username-only and password-only differences stay actionable, so the prompt still
 * appears when something really changed.
 */
export function isUnchangedCredentialCapture(matches: LoginItem[], candidate: CredentialCaptureCandidate): boolean {
  if (!candidate.password) return false;
  const username = candidate.username.trim().toLocaleLowerCase();
  return matches.some((item) =>
    item.password === candidate.password
    && (!username || item.username.trim().toLocaleLowerCase() === username)
  );
}
