import { describe, expect, it } from "vitest";
import { DEFAULT_GENERATOR_PREFERENCES, resolveAllowedSymbols } from "./generator-preferences";
import {
  applyFieldGeneratorLength,
  applyFieldGeneratorMinimum,
  DEFAULT_FIELD_GENERATOR_SETTINGS,
  fieldGeneratorMode,
  fieldGeneratorLength,
  fieldGeneratorSettingsFromCounts,
  generateFromFieldSettings,
  generateFromPreferences,
  normalizeFieldGeneratorSettings,
  withFieldGeneratorLength,
  type FieldGeneratorSettings
} from "./generator-presets";

const preferences = (patch: Partial<typeof DEFAULT_GENERATOR_PREFERENCES> = {}) => ({ ...DEFAULT_GENERATOR_PREFERENCES, ...patch });

describe("shared generator presets", () => {
  it("generates a symbol password with the configured length and character rules", () => {
    const value = generateFromPreferences(preferences({ symbolLength: 24 }));
    expect(value).toHaveLength(24);
    expect(value).not.toMatch(/[0Ol1I]/);
    const lettersOnly = generateFromPreferences(preferences({ symbolLength: 12, includeSymbols: false, includeNumbers: false }));
    expect(lettersOnly).toMatch(/^[A-Za-z]{12}$/);
    const custom = generateFromPreferences(preferences({ symbolLength: 16, useSymbolExclusionMode: false, customSymbols: "$" }));
    // 生成器只保证「最少」符号数：先放够下限，剩余位置从全部字符里随机补，
    // 因此符号数可以多于下限，这里只能断言下限（原断言等于下限，约 1/5 概率随机失败）。
    expect(custom.replace(/[^$]/g, "").length).toBeGreaterThanOrEqual(DEFAULT_GENERATOR_PREFERENCES.symbolsMin);
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

const settings = (patch: Partial<FieldGeneratorSettings> = {}): FieldGeneratorSettings => ({
  ...DEFAULT_FIELD_GENERATOR_SETTINGS,
  ...patch,
  lengths: { ...DEFAULT_FIELD_GENERATOR_SETTINGS.lengths, ...patch.lengths },
  minimums: { ...DEFAULT_FIELD_GENERATOR_SETTINGS.minimums, ...patch.minimums }
});

describe("field generator settings", () => {
  it("uses the length for the total and the minimums only as a lower bound", () => {
    const value = generateFromFieldSettings(settings({ lengths: { ...DEFAULT_FIELD_GENERATOR_SETTINGS.lengths, SYMBOL: 24 } }), "SYMBOL");
    expect(value).toHaveLength(24);
    // 构成不固定：每类下限只有 1 个，大写个数不应该总是 1。
    const counts = Array.from({ length: 10 }, () => [...generateFromFieldSettings(settings(), "SYMBOL")].filter((character) => /[A-Z]/.test(character)).length);
    expect(Math.max(...counts)).toBeGreaterThan(1);
  });

  it("treats a minimum of 0 as excluding that character type", () => {
    const value = generateFromFieldSettings(settings({ minimums: { uppercase: 0, lowercase: 0, digits: 0, symbols: 1 } }), "SYMBOL");
    expect(value).toHaveLength(DEFAULT_FIELD_GENERATOR_SETTINGS.lengths.SYMBOL);
    expect(value).toMatch(/^[^A-Za-z0-9]+$/);
  });

  it("generates pins, passphrases and word passwords from the same settings", () => {
    expect(generateFromFieldSettings(settings({ lengths: { ...DEFAULT_FIELD_GENERATOR_SETTINGS.lengths, PIN: 8 } }), "PIN")).toMatch(/^[0-9]{8}$/);
    expect(generateFromFieldSettings(settings({ lengths: { ...DEFAULT_FIELD_GENERATOR_SETTINGS.lengths, PASSPHRASE: 5 } }), "PASSPHRASE").split("-")).toHaveLength(5);
    const wordPassword = generateFromFieldSettings(settings({ lengths: { ...DEFAULT_FIELD_GENERATOR_SETTINGS.lengths, PASSWORD: 16 } }), "PASSWORD");
    expect(wordPassword).toMatch(/^[a-z0-9]{16}$/);
  });

  it("normalizes stored settings, including the all-zero fallback", () => {
    expect(normalizeFieldGeneratorSettings(undefined)).toEqual(DEFAULT_FIELD_GENERATOR_SETTINGS);
    expect(normalizeFieldGeneratorSettings({ lengths: { SYMBOL: 999, PIN: 0 }, minimums: { uppercase: 99, lowercase: -3 } })).toEqual({
      lengths: { ...DEFAULT_FIELD_GENERATOR_SETTINGS.lengths, SYMBOL: 64, PIN: 4 },
      minimums: { uppercase: 32, lowercase: 0, digits: 1, symbols: 1 }
    });
    // 四类全为 0 时没有可用字符，退回默认最少数量。
    expect(normalizeFieldGeneratorSettings({ minimums: { uppercase: 0, lowercase: 0, digits: 0, symbols: 0 } }).minimums)
      .toEqual(DEFAULT_FIELD_GENERATOR_SETTINGS.minimums);
    // 长度不能小于最少数量之和。
    expect(normalizeFieldGeneratorSettings({ lengths: { SYMBOL: 4 }, minimums: { uppercase: 5, lowercase: 5, digits: 5, symbols: 5 } }).lengths.SYMBOL).toBe(20);
  });

  it("migrates the legacy per-type counts into a length plus minimums", () => {
    expect(fieldGeneratorSettingsFromCounts({ uppercase: 2, lowercase: 10, digits: 4, symbols: 3 })).toEqual({
      lengths: { ...DEFAULT_FIELD_GENERATOR_SETTINGS.lengths, SYMBOL: 20 },
      minimums: { uppercase: 2, lowercase: 10, digits: 4, symbols: 3 }
    });
    // 旧数量合计超过默认长度时抬高长度。
    expect(fieldGeneratorSettingsFromCounts({ uppercase: 20, lowercase: 20, digits: 0, symbols: 0 })?.lengths.SYMBOL).toBe(40);
    expect(fieldGeneratorSettingsFromCounts(undefined)).toBeUndefined();
    expect(fieldGeneratorSettingsFromCounts({ selectedGenerator: "PIN" })).toBeUndefined();
  });

  it("keeps the length above the minimums and the minimums inside the length", () => {
    const start = settings();
    expect(applyFieldGeneratorLength(start, "SYMBOL", 999).lengths.SYMBOL).toBe(64);
    expect(applyFieldGeneratorLength(start, "SYMBOL", 2).lengths.SYMBOL).toBe(4);
    expect(applyFieldGeneratorLength(start, "PIN", 999).lengths.PIN).toBe(32);
    expect(applyFieldGeneratorLength(start, "PASSPHRASE", 1).lengths.PASSPHRASE).toBe(2);
    // 其他模式的长度不受影响。
    expect(applyFieldGeneratorLength(start, "PIN", 10).lengths.SYMBOL).toBe(start.lengths.SYMBOL);

    const raised = applyFieldGeneratorMinimum(start, "uppercase", 32);
    expect(raised.minimums.uppercase).toBe(32);
    expect(raised.lengths.SYMBOL).toBe(35);
    // 合计不得超出符号密码的长度上限：剩下三类已占 3，大写最多只能到 61。
    expect(applyFieldGeneratorMinimum(settings({ minimums: { uppercase: 32, lowercase: 32, digits: 0, symbols: 0 } }), "uppercase", 40).minimums.uppercase).toBe(32);
  });

  it("refuses to disable every character type", () => {
    const almost = settings({ minimums: { uppercase: 0, lowercase: 0, digits: 0, symbols: 3 } });
    expect(applyFieldGeneratorMinimum(almost, "symbols", 0)).toBe(almost);
  });
});
