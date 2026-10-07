import { generatePassphrase, generatePassword, generatePin, generateWordPassword } from "./credential-generator";
import { resolveAllowedSymbols, type GeneratorMode, type GeneratorPreferences } from "./generator-preferences";

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
