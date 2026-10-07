import { describe, expect, it } from "vitest";
import { createLoginItem, type LoginItem } from "./model";
import { isUnchangedCredentialCapture } from "./credential-capture-policy";

function login(title: string, username: string, password: string): LoginItem {
  return createLoginItem({ title, username, password, uris: ["example.com"] });
}

describe("credential capture policy", () => {
  it("treats a repeated password for the same account as unchanged", () => {
    const matches = [login("Example", "alice@example.com", "correct horse")];
    expect(isUnchangedCredentialCapture(matches, { username: "alice@example.com", password: "correct horse" })).toBe(true);
    expect(isUnchangedCredentialCapture(matches, { username: "ALICE@Example.com ", password: "correct horse" })).toBe(true);
  });

  it("keeps a real password change actionable", () => {
    const matches = [login("Example", "alice@example.com", "correct horse")];
    expect(isUnchangedCredentialCapture(matches, { username: "alice@example.com", password: "new password" })).toBe(false);
  });

  it("keeps a username change actionable even when the password repeats", () => {
    const matches = [login("Example", "alice@example.com", "shared password")];
    expect(isUnchangedCredentialCapture(matches, { username: "bob@example.com", password: "shared password" })).toBe(false);
  });

  it("matches a capture without username only when the password repeats", () => {
    const matches = [login("Example", "alice@example.com", "correct horse")];
    expect(isUnchangedCredentialCapture(matches, { username: "", password: "correct horse" })).toBe(true);
    expect(isUnchangedCredentialCapture(matches, { username: "", password: "other" })).toBe(false);
  });

  it("never suppresses a capture without a stored match or without a password", () => {
    expect(isUnchangedCredentialCapture([], { username: "alice@example.com", password: "correct horse" })).toBe(false);
    const matches = [login("Example", "alice@example.com", "correct horse")];
    expect(isUnchangedCredentialCapture(matches, { username: "alice@example.com", password: "" })).toBe(false);
  });
});
