import { describe, expect, it } from "vitest";
import { DEFAULT_GENERATOR_PREFERENCES, resolveAllowedSymbols } from "./generator-preferences";
import { fieldGeneratorLength, fieldGeneratorMode, generateFromPreferences, withFieldGeneratorLength } from "./generator-presets";

const preferences = (patch: Partial<typeof DEFAULT_GENERATOR_PREFERENCES> = {}) => ({ ...DEFAULT_GENERATOR_PREFERENCES, ...patch });

describe("shared generator presets", () => {
  it("generates a symbol password with the configured length and character rules", () => {
    const value = generateFromPreferences(preferences({ symbolLength: 24 }));
    expect(value).toHaveLength(24);
    expect(value).not.toMatch(/[0Ol1I]/);
    const lettersOnly = generateFromPreferences(preferences({ symbolLength: 12, includeSymbols: false, includeNumbers: false }));
    expect(lettersOnly).toMatch(/^[A-Za-z]{12}$/);
    const custom = generateFromPreferences(preferences({ symbolLength: 16, useSymbolExclusionMode: false, customSymbols: "$" }));
    expect(custom.replace(/[^$]/g, "")).toHaveLength(DEFAULT_GENERATOR_PREFERENCES.symbolsMin);
    expect(resolveAllowedSymbols(preferences({ useSymbolExclusionMode: false, customSymbols: "$" }))).toBe("$");
  });

  it("generates pins, passphrases and word passwords from the same preferences", () => {
    expect(generateFromPreferences(preferences({ pinLength: 8 }), "PIN")).toMatch(/^[0-9]{8}$/);
    const passphrase = generateFromPreferences(preferences({ passphraseWordCount: 5, passphraseDelimiter: ".", passphraseCapitalize: true }), "PASSPHRASE");
    const words = passphrase.split(".");
    expect(words).toHaveLength(5);
    expect(words.every((word) => /^[A-Z]/.test(word))).toBe(true);
    const wordPassword = generateFromPreferences(preferences({ passwordLength: 20, includeNumbersInPassword: false, firstLetterUppercase: true, customSeparator: "" }), "PASSWORD");
    expect(wordPassword).toMatch(/^[A-Za-z]+$/);
  });

  it("maps stored modes to the field modes and skips SSH keys", () => {
    expect(fieldGeneratorMode("SYMBOL")).toBe("SYMBOL");
    expect(fieldGeneratorMode("PASSPHRASE")).toBe("PASSPHRASE");
    expect(fieldGeneratorMode("SSH_KEY")).toBe("SYMBOL");
  });

  it("adjusts only the length of the active mode and clamps it", () => {
    const start = preferences();
    const pin = withFieldGeneratorLength(start, "PIN", 4);
    expect(pin.pinLength).toBe(4);
    expect(pin.selectedGenerator).toBe("PIN");
    expect(pin.symbolLength).toBe(start.symbolLength);
    expect(withFieldGeneratorLength(start, "PIN", 999).pinLength).toBe(32);
    expect(withFieldGeneratorLength(start, "PASSPHRASE", 0).passphraseWordCount).toBe(2);
    expect(withFieldGeneratorLength(start, "PASSWORD", 999).passwordLength).toBe(128);
    expect(fieldGeneratorLength(start, "SYMBOL")).toBe(start.symbolLength);
    expect(fieldGeneratorLength(start, "PASSPHRASE")).toBe(start.passphraseWordCount);
  });
});
