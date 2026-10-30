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

const HAN = /\p{Script=Han}/u;
const LATIN = /[A-Za-z0-9]/;

/**
 * 中文排版：插进句子里的 `word`（例如角色名）两端，拉丁字母 / 数字与汉字直接相邻时补一个空格
 * （「打开{0}」+「Ab」→「打开 Ab」，「{0}已就绪」→「Ab 已就绪」）；汉字名（「打开小纸」）、
 * 标点旁（「，Ab 和」「打开 Ab（」）和已有空格的地方不动。只处理 `word` 的出现位置。
 */
export function spaceAround(text: string, word: string): string {
  if (!word || !text.includes(word)) return text;
  const head = LATIN.test(word[0] ?? '');
  const tail = LATIN.test(word[word.length - 1] ?? '');
  if (!head && !tail) return text;
  let out = '';
  let from = 0;
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, from)) {
    out += text.slice(from, i);
    if (head && HAN.test(text[i - 1] ?? '')) out += ' ';
    out += word;
    from = i + word.length;
    if (tail && HAN.test(text[from] ?? '')) out += ' ';
  }
  return out + text.slice(from);
}

export type Translate = (key: unknown, ...args: unknown[]) => unknown;

/**
 * 只认词典自己的字符串条目：用户文本（会话名等）可能恰好是 `__proto__` / `constructor` / `toString`，
 * 不能读到继承属性返回对象或函数（#142）。查不到原样返回。
 */
function lookup(dictionaries: Record<string, string>, key: string): string {
  if (!Object.hasOwn(dictionaries, key)) return key;
  const value = dictionaries[key];
  return typeof value === 'string' ? value : key;
}

export function createTranslator(getLocale: () => Locale): Translate {
  return (input, ...args) => {
    if (typeof input !== 'string') return input;
    const language = languageForLocale(getLocale());
    const dictionaries = getDictionary(language);
    const translated = lookup(dictionaries, input);
    const translatedArgs = args.map((arg) =>
      typeof arg === 'string' ? lookup(dictionaries, arg) : arg,
    );
    return format(translated, translatedArgs);
  };
}
