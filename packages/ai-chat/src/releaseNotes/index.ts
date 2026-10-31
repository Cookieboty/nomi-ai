/**
 * 更新说明来自发布本身（docs/releases/vX.Y.Z.md → 该版本的 latest-go.json），内核按版本取（updates.releaseNotes），
 * 界面不再内置任何版本的文案。说明是中英双语：标题与条目每行都是「中文 / English」，按界面语言取一半。
 */
export const RELEASE_HISTORY_URL = 'https://github.com/Cookieboty/nomi-ai/releases';

const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

/**
 * 「中文 / English」→ 两半。分隔点取第一个「/ 左边有中文、右边没有中文」的 ` / `，
 * 所以中文半句里自己带的 ` / `（如「警告 / 危险色」）不会被切开。不是双语行时返回 null。
 */
export function splitBilingual(text: string): { zh: string; en: string } | null {
  for (let i = text.indexOf(' / '); i >= 0; i = text.indexOf(' / ', i + 1)) {
    const zh = text.slice(0, i);
    const en = text.slice(i + 3);
    if (CJK.test(zh) && !CJK.test(en)) return { zh, en };
  }
  return null;
}

/** 按界面语言保留双语说明的一半；去掉一级标题（弹层自己有标题），表格原样保留 */
export function localizeReleaseNotes(markdown: string, locale: string): string {
  const zh = locale === 'zh-CN';
  const out: string[] = [];
  let seenContent = false;
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (!seenContent && line.trim()) {
      seenContent = true;
      if (/^#\s/.test(line)) continue;
    }
    if (line.trimStart().startsWith('|')) {
      out.push(line);
      continue;
    }
    const m = /^(\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)?)(.*)$/.exec(line)!;
    const parts = splitBilingual(m[2]!);
    out.push(parts ? m[1] + (zh ? parts.zh : parts.en) : line);
  }
  return out.join('\n').trim();
}
