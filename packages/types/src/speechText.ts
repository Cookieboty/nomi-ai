/**
 * Text cleanup and sentence splitting for realtime read-aloud.
 * Pure functions shared by the renderer (segment queue) and the main process (per-request guard).
 */

/** Remove things that should not be read aloud: code, markdown markup, links, HTML tags. */
export function cleanTextForSpeech(input: string): string {
  if (!input) return '';
  let s = String(input);
  s = s.replace(/```[\s\S]*?(```|$)/g, ' '); // fenced code (also an unterminated tail)
  s = s.replace(/~~~[\s\S]*?(~~~|$)/g, ' ');
  s = s.replace(/`[^`\n]*`/g, ' '); // inline code
  s = s.replace(/<[^>\n]+>/g, ' '); // html tags
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' '); // images
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // links -> label
  s = s.replace(/\bhttps?:\/\/\S+/gi, ' '); // bare urls
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, ''); // headings
  s = s.replace(/^\s{0,3}>\s?/gm, ''); // block quotes
  s = s.replace(/^\s*([-*+]|\d+[.)])\s+/gm, ''); // list markers
  s = s.replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, ' '); // table rules
  s = s.replace(/^\s*([-*_]\s*){3,}$/gm, ' '); // horizontal rules
  s = s.replace(/\|/g, ' ');
  s = s.replace(/(\*\*|__|~~)(.+?)\1/g, '$2');
  s = s.replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2');
  s = s.replace(/[*_#~`]+/g, ' ');
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/\s*\n\s*/g, '\n');
  return s.trim();
}

const HARD_LIMIT = 280;

/**
 * Split cleaned text into speakable segments: sentence ends (。！？!?；; and ". "), line breaks,
 * then short pieces merged up to `target` chars; anything longer than the hard limit is cut at
 * a comma or space.
 */
export function splitSpeechSegments(text: string, target = 120): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const parts = clean
    .split(/(?<=[。！？!?；;…])|(?<=\.)(?=\s)|\n+/)
    .map((p) => p.trim())
    .filter((p) => /[\p{L}\p{N}]/u.test(p));
  const out: string[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(buf);
    buf = '';
  };
  for (const part of parts) {
    for (const piece of hardSplit(part)) {
      const sep = buf && /[A-Za-z0-9]$/.test(buf) && /^[A-Za-z0-9]/.test(piece) ? ' ' : '';
      if (buf && buf.length + sep.length + piece.length > target) flush();
      buf = buf ? buf + (/[A-Za-z0-9.,!?;:]$/.test(buf) ? ' ' : sep) + piece : piece;
    }
  }
  flush();
  return out;
}

function hardSplit(s: string): string[] {
  if (s.length <= HARD_LIMIT) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > HARD_LIMIT) {
    const window = rest.slice(0, HARD_LIMIT);
    const cut = Math.max(
      window.lastIndexOf('，'),
      window.lastIndexOf(','),
      window.lastIndexOf('、'),
      window.lastIndexOf(' '),
    );
    const at = cut > HARD_LIMIT / 3 ? cut + 1 : HARD_LIMIT;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}
