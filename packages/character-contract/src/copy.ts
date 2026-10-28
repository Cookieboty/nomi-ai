/**
 * 角色文案的读取（纯函数）：persona 按语言覆盖、台词按语言回退到主语言。
 */
import { PRIMARY_CHARACTER_LOCALE } from './contract';
import { resolveVoiceClipId } from './migrations';
import type { CharacterLocaleData, PersonaData } from './schemas';

type Locales = Partial<Record<string, CharacterLocaleData>>;

/** `zh-CN` → `zh`，`en-US` → `en`。 */
function baseLocale(locale: string): string {
  return locale.toLowerCase().split(/[-_]/)[0] ?? locale;
}

/** 某语言下的 persona：`locales/<lang>.json` 的 `persona` 覆盖 persona.json 的同名字段。 */
export function resolvePersona(
  persona: PersonaData,
  locales: Locales,
  locale: string = PRIMARY_CHARACTER_LOCALE,
): PersonaData {
  const override = locales[baseLocale(locale)]?.persona;
  if (!override) return persona;
  const merged: PersonaData = { ...persona };
  for (const [k, v] of Object.entries(override) as Array<[keyof PersonaData, unknown]>) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  }
  // 覆盖了全名却没给简称：简称跟着这一语言的全名，不沿用主语言的简称
  if (override.displayName && !override.shortName && persona.shortName) {
    merged.shortName = override.displayName;
  }
  return merged;
}

/**
 * 某语言下角色的全名与简称。全名用在界面第一次提到角色的地方（欢迎语），简称用在之后
 * （「显示 X」「X 大小」）；见 docs/BRAND.md。`override` 是 `locales/<lang>.json` 的 persona：它给了全名
 * 却没给简称时，简称就是它的全名（不沿用主语言的简称）。
 */
export function personaNames(
  persona: Pick<PersonaData, 'displayName' | 'shortName'>,
  override?: Partial<Pick<PersonaData, 'displayName' | 'shortName'>>,
): { displayName: string; shortName: string } {
  const displayName = override?.displayName || persona.displayName;
  const shortName =
    override?.shortName || (override?.displayName ? undefined : persona.shortName) || displayName;
  return { displayName, shortName };
}

/**
 * 台词 / 字幕：先查目标语言，再查主语言；key 可以是稳定 clip id 或旧 i18n key。
 * 找不到返回 undefined（由调用方决定回退）。
 */
export function resolveLine(
  locales: Locales,
  key: string,
  locale: string = PRIMARY_CHARACTER_LOCALE,
): string | undefined {
  const ids = [key, resolveVoiceClipId(key)];
  for (const lang of [baseLocale(locale), PRIMARY_CHARACTER_LOCALE]) {
    const lines = locales[lang]?.lines;
    if (!lines) continue;
    for (const id of ids) {
      const v = lines[id];
      if (typeof v === 'string' && v) return v;
    }
  }
  return undefined;
}
