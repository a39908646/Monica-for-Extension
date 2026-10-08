import { generatePassphrase, generatePassword, generatePin, generateWordPassword } from "./credential-generator";
import { DEFAULT_GENERATOR_PREFERENCES, resolveAllowedSymbols, type GeneratorMode, type GeneratorPreferences } from "./generator-preferences";

/**
 * 设置页生成器与页面内生成面板共用的「偏好 → 生成结果」映射，避免两处逻辑漂移。
 * SSH 密钥不在字段内生成，因此字段内面板只用前四种模式。
 */
export type FieldGeneratorMode = "SYMBOL" | "PASSWORD" | "PIN" | "PASSPHRASE";

export const FIELD_GENERATOR_MODES: readonly FieldGeneratorMode[] = ["SYMBOL", "PASSWORD", "PIN", "PASSPHRASE"];

/** 模式对应的长度偏好键，供页面内面板做长度微调。 */
export const FIELD_GENERATOR_LENGTH_KEY: Record<FieldGeneratorMode, keyof GeneratorPreferences> = {
  SYMBOL: "symbolLength",
  PASSWORD: "passwordLength",
  PIN: "pinLength",
  PASSPHRASE: "passphraseWordCount"
};

export const FIELD_GENERATOR_LENGTH_RANGE: Record<FieldGeneratorMode, { minimum: number; maximum: number }> = {
  SYMBOL: { minimum: 4, maximum: 64 },
  PASSWORD: { minimum: 4, maximum: 128 },
  PIN: { minimum: 4, maximum: 32 },
  PASSPHRASE: { minimum: 2, maximum: 12 }
};

export interface GeneratorMinimums {
  uppercase: number;
  lowercase: number;
  digits: number;
  symbols: number;
}

export interface FieldGeneratorSettings {
  /** 每个模式各自记住长度：符号密码/单词密码是字符数，PIN 是位数，短语是单词数。 */
  lengths: Record<FieldGeneratorMode, number>;
  /** 各字符类型的最少数量；0 表示该类型完全不使用。剩余位数从已启用类型随机补足。 */
  minimums: GeneratorMinimums;
}

const MINIMUM_MAX = 32;

/** 默认总长度 20 位，每类至少 1 个：构成随机，不固定。 */
export const DEFAULT_FIELD_GENERATOR_SETTINGS: FieldGeneratorSettings = {
  lengths: { SYMBOL: 20, PASSWORD: 12, PIN: 6, PASSPHRASE: 4 },
  minimums: { uppercase: 1, lowercase: 1, digits: 1, symbols: 1 }
};

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

export function fieldGeneratorMinimumTotal(minimums: GeneratorMinimums): number {
  return minimums.uppercase + minimums.lowercase + minimums.digits + minimums.symbols;
}

/** 符号密码的长度不能小于最少数量之和，否则 generatePassword 会直接报错。 */
function lengthFloor(mode: FieldGeneratorMode, minimums: GeneratorMinimums): number {
  const range = FIELD_GENERATOR_LENGTH_RANGE[mode];
  return mode === "SYMBOL" ? Math.max(range.minimum, Math.min(fieldGeneratorMinimumTotal(minimums), range.maximum)) : range.minimum;
}

function boundedLength(mode: FieldGeneratorMode, value: unknown, fallback: number, minimums: GeneratorMinimums): number {
  const range = FIELD_GENERATOR_LENGTH_RANGE[mode];
  return clampInteger(value, lengthFloor(mode, minimums), range.maximum, Math.max(fallback, lengthFloor(mode, minimums)));
}

function boundedMinimums(value: unknown): GeneratorMinimums {
  const source = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof GeneratorMinimums, unknown>>;
  const minimums: GeneratorMinimums = {
    uppercase: clampInteger(source.uppercase, 0, MINIMUM_MAX, DEFAULT_FIELD_GENERATOR_SETTINGS.minimums.uppercase),
    lowercase: clampInteger(source.lowercase, 0, MINIMUM_MAX, DEFAULT_FIELD_GENERATOR_SETTINGS.minimums.lowercase),
    digits: clampInteger(source.digits, 0, MINIMUM_MAX, DEFAULT_FIELD_GENERATOR_SETTINGS.minimums.digits),
    symbols: clampInteger(source.symbols, 0, MINIMUM_MAX, DEFAULT_FIELD_GENERATOR_SETTINGS.minimums.symbols)
  };
  // 四类全为 0 时没有可用字符：退回默认的最少数量。
  return fieldGeneratorMinimumTotal(minimums) ? minimums : { ...DEFAULT_FIELD_GENERATOR_SETTINGS.minimums };
}

/** 存储或跨页面同步过来的设置可能缺字段、越界或互相矛盾，这里统一归一化。 */
export function normalizeFieldGeneratorSettings(value: unknown): FieldGeneratorSettings {
  const source = (value && typeof value === "object" ? value : {}) as { lengths?: Partial<Record<FieldGeneratorMode, unknown>>; minimums?: unknown };
  const minimums = boundedMinimums(source.minimums);
  const lengths = { ...DEFAULT_FIELD_GENERATOR_SETTINGS.lengths };
  for (const mode of FIELD_GENERATOR_MODES) {
    lengths[mode] = boundedLength(mode, source.lengths?.[mode], DEFAULT_FIELD_GENERATOR_SETTINGS.lengths[mode], minimums);
  }
  return { lengths, minimums };
}

/** 旧版只存了四类数量（精确数量兼总长度）：把它们当作最少数量，长度取默认与合计的较大值。 */
export function fieldGeneratorSettingsFromCounts(value: unknown): FieldGeneratorSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (!["uppercase", "lowercase", "digits", "symbols"].some((key) => key in source)) return undefined;
  const minimums = boundedMinimums(source);
  const lengths = { ...DEFAULT_FIELD_GENERATOR_SETTINGS.lengths };
  lengths.SYMBOL = boundedLength("SYMBOL", Math.max(lengths.SYMBOL, fieldGeneratorMinimumTotal(minimums)), lengths.SYMBOL, minimums);
  return { lengths, minimums };
}

/** 改长度：夹到模式范围，且符号密码不得低于最少数量之和。 */
export function applyFieldGeneratorLength(settings: FieldGeneratorSettings, mode: FieldGeneratorMode, length: number): FieldGeneratorSettings {
  return { ...settings, lengths: { ...settings.lengths, [mode]: boundedLength(mode, length, settings.lengths[mode], settings.minimums) } };
}

/** 改某一类最少数量：夹到可用额度，并抬高符号密码长度使合计不超长。 */
export function applyFieldGeneratorMinimum(settings: FieldGeneratorSettings, key: keyof GeneratorMinimums, value: number): FieldGeneratorSettings {
  const others = fieldGeneratorMinimumTotal(settings.minimums) - settings.minimums[key];
  const cap = Math.min(MINIMUM_MAX, Math.max(0, FIELD_GENERATOR_LENGTH_RANGE.SYMBOL.maximum - others));
  const minimums = { ...settings.minimums, [key]: clampInteger(value, 0, cap, settings.minimums[key]) };
  // 四类全为 0 时没有任何可用字符：拒绝这次改动（返回原对象，调用方据此提示）。
  if (!fieldGeneratorMinimumTotal(minimums)) return settings;
  const lengths = { ...settings.lengths, SYMBOL: boundedLength("SYMBOL", Math.max(settings.lengths.SYMBOL, fieldGeneratorMinimumTotal(minimums)), settings.lengths.SYMBOL, minimums) };
  return { minimums, lengths };
}

/**
 * 字段内生成器的统一入口：长度决定总位数，最少数量只保证下限，其余位数随机填充，
 * 因此密码构成不固定。单词密码固定用应用默认的单词参数（面板只暴露长度）。
 */
export function generateFromFieldSettings(settings: FieldGeneratorSettings, mode: FieldGeneratorMode): string {
  const length = settings.lengths[mode];
  if (mode === "PIN") return generatePin(length);
  if (mode === "PASSPHRASE") return generatePassphrase({ length, delimiter: "-" });
  if (mode === "PASSWORD") {
    return generateWordPassword({
      length,
      firstLetterUppercase: DEFAULT_GENERATOR_PREFERENCES.firstLetterUppercase,
      includeNumbers: DEFAULT_GENERATOR_PREFERENCES.includeNumbersInPassword,
      separator: DEFAULT_GENERATOR_PREFERENCES.customSeparator,
      separatorCountsTowardsLength: DEFAULT_GENERATOR_PREFERENCES.separatorCountsTowardsLength,
      segmentLength: DEFAULT_GENERATOR_PREFERENCES.segmentLength
    });
  }
  const minimums = settings.minimums;
  return generatePassword({
    length: Math.max(length, fieldGeneratorMinimumTotal(minimums)),
    uppercaseChars: minimums.uppercase > 0 ? undefined : "",
    lowercaseChars: minimums.lowercase > 0 ? undefined : "",
    numberChars: minimums.digits > 0 ? undefined : "",
    symbolChars: minimums.symbols > 0 ? resolveAllowedSymbols(DEFAULT_GENERATOR_PREFERENCES) : "",
    uppercaseMin: minimums.uppercase,
    lowercaseMin: minimums.lowercase,
    numbersMin: minimums.digits,
    symbolsMin: minimums.symbols,
    excludeSimilar: true
  });
}

export function isFieldGeneratorMode(value: unknown): value is FieldGeneratorMode {
  return typeof value === "string" && (FIELD_GENERATOR_MODES as readonly string[]).includes(value);
}

/** 偏好里的生成模式可能是不支持的 SSH_KEY：字段内一律退回符号密码。 */
export function fieldGeneratorMode(mode: GeneratorMode): FieldGeneratorMode {
  return isFieldGeneratorMode(mode) ? mode : "SYMBOL";
}

export function generateFromPreferences(preferences: GeneratorPreferences, mode: GeneratorMode = preferences.selectedGenerator): string {
  switch (mode) {
    case "PIN":
      return generatePin(preferences.pinLength);
    case "PASSPHRASE":
      return generatePassphrase({
        length: preferences.passphraseWordCount,
        delimiter: preferences.passphraseDelimiter,
        capitalize: preferences.passphraseCapitalize,
        includeNumber: preferences.passphraseIncludeNumber,
        customWord: preferences.passphraseCustomWord
      });
    case "PASSWORD":
      return generateWordPassword({
        length: preferences.passwordLength,
        firstLetterUppercase: preferences.firstLetterUppercase,
        includeNumbers: preferences.includeNumbersInPassword,
        separator: preferences.customSeparator,
        separatorCountsTowardsLength: preferences.separatorCountsTowardsLength,
        segmentLength: preferences.segmentLength
      });
    default:
      return generatePassword({
        length: preferences.symbolLength,
        uppercaseChars: preferences.includeUppercase ? undefined : "",
        lowercaseChars: preferences.includeLowercase ? undefined : "",
        numberChars: preferences.includeNumbers ? undefined : "",
        symbolChars: preferences.includeSymbols ? resolveAllowedSymbols(preferences) : "",
        uppercaseMin: preferences.includeUppercase ? preferences.uppercaseMin : 0,
        lowercaseMin: preferences.includeLowercase ? preferences.lowercaseMin : 0,
        numbersMin: preferences.includeNumbers ? preferences.numbersMin : 0,
        symbolsMin: preferences.includeSymbols ? preferences.symbolsMin : 0,
        excludeSimilar: preferences.excludeSimilar,
        excludeAmbiguous: preferences.excludeAmbiguous
      });
  }
}

/** 页面内面板的长度微调：只改当前模式的长度键，其余偏好原样保留。 */
export function withFieldGeneratorLength(preferences: GeneratorPreferences, mode: FieldGeneratorMode, length: number): GeneratorPreferences {
  const range = FIELD_GENERATOR_LENGTH_RANGE[mode];
  const bounded = Math.min(range.maximum, Math.max(range.minimum, Math.trunc(Number.isFinite(length) ? length : range.minimum)));
  return { ...preferences, selectedGenerator: mode, [FIELD_GENERATOR_LENGTH_KEY[mode]]: bounded };
}

export function fieldGeneratorLength(preferences: GeneratorPreferences, mode: FieldGeneratorMode): number {
  const value = preferences[FIELD_GENERATOR_LENGTH_KEY[mode]];
  return typeof value === "number" ? value : FIELD_GENERATOR_LENGTH_RANGE[mode].minimum;
}
