import { getDictionary } from './catalog';

export { DICTIONARIES, getDictionary } from './catalog';
export type { Language, TranslationKey } from './catalog';

export type Locale = 'zh-CN' | 'en';
export type LocalePref = Locale | 'system';

export const isLocalePref = (value: unknown): value is LocalePref =>
  value === 'system' || value === 'zh-CN' || value === 'en';

export const languageForLocale = (locale: Locale): 'zh' | 'en' => (locale === 'en' ? 'en' : 'zh');

export const resolveLocale = (
  pref: LocalePref,
  system: string | readonly string[] | undefined,
): Locale => {
  if (pref !== 'system') return pref;
  const first = Array.isArray(system) ? system[0] : system;
  return String(first ?? '')
    .toLowerCase()
    .startsWith('zh')
    ? 'zh-CN'
    : 'en';
};

export function format(value: string, args: unknown[]): string {
  if (!args.length) return value;
  const named =
    args.length === 1 && args[0] && typeof args[0] === 'object'
      ? (args[0] as Record<string, unknown>)
      : null;
  return value.replace(/\{(\w+)\}/g, (match, name: string) => {
    const replacement = named ? named[name] : args[Number(name)];
    return replacement === undefined ? match : String(replacement);
  });
}

export type Translate = (key: unknown, ...args: unknown[]) => unknown;

export function createTranslator(getLocale: () => Locale): Translate {
  return (input, ...args) => {
    if (typeof input !== 'string') return input;
    const language = languageForLocale(getLocale());
    const dictionaries = getDictionary(language);
    const translated = dictionaries[input] ?? input;
    const translatedArgs = args.map((arg) => {
      if (typeof arg !== 'string') return arg;
      return dictionaries[arg] ?? arg;
    });
    return format(translated, translatedArgs);
  };
}
