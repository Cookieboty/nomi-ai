/**
 * Text cleanup and sentence splitting for realtime read-aloud.
 * Pure functions shared by the renderer (segment queue) and the main process (per-request guard).
 */

/** Remove things that should not be read aloud: code, markdown markup, links, HTML tags. */
export function cleanTextForSpeech(input: string): string {
  if (!input) return '';
  let s = String(input);
  s = s.replace(/<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|$)/gi, ' '); // reasoning blocks
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
  s = s.replace(/^.*\|.*\|.*$/gm, ' '); // table rows (two or more pipes): not read cell by cell
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

/** Default cap for reading an AI reply aloud: about the first 300 characters (whole sentences). */
export const REPLY_SPEECH_MAX_CHARS = 300;

const SENTENCE_END = /[。！？!?；;…\n]|\.(?=\s)/g;

/**
 * Incremental sentence feeder for a streaming AI reply: push raw deltas, get back speakable
 * segments as soon as a whole sentence is available. Code fences / reasoning blocks that are
 * still open are held back until they close (and then dropped by cleanTextForSpeech).
 * Stops after `maxChars` speakable characters (the sentence that crosses the cap is the last).
 */
export class ReplySpeechStream {
  private raw = '';
  private consumed = 0;
  private spoken = 0;
  private full = false;

  constructor(private readonly maxChars = REPLY_SPEECH_MAX_CHARS) {}

  /** True once the cap was reached; later text is ignored. */
  get done(): boolean {
    return this.full;
  }

  push(delta: string): string[] {
    if (this.full || !delta) return [];
    this.raw += delta;
    return this.take(false);
  }

  /** Reply finished: flush whatever is left (an unterminated last sentence included). */
  finish(): string[] {
    if (this.full) return [];
    return this.take(true);
  }

  private take(final: boolean): string[] {
    let pending = this.raw.slice(this.consumed);
    if (!final) {
      const open = openBlockStart(this.raw, this.consumed);
      if (open >= 0) pending = pending.slice(0, open - this.consumed);
      let cut = -1;
      SENTENCE_END.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SENTENCE_END.exec(pending))) cut = m.index + m[0].length;
      if (cut <= 0) return [];
      pending = pending.slice(0, cut);
    }
    this.consumed += pending.length;
    const out: string[] = [];
    for (const seg of splitSpeechSegments(cleanTextForSpeech(pending), 60)) {
      if (this.spoken >= this.maxChars) break;
      out.push(seg);
      this.spoken += seg.length;
    }
    if (this.spoken >= this.maxChars) this.full = true;
    return out;
  }
}

/** Index (in `raw`) where a still-open ``` / ~~~ fence or <think> block starts after `from`; -1 if none. */
function openBlockStart(raw: string, from: number): number {
  let open = -1;
  const re = /```|~~~|<(think|thinking|reasoning)>|<\/(think|thinking|reasoning)>/gi;
  let fence: string | null = null;
  let think = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const tok = m[0].toLowerCase();
    if (tok === '```' || tok === '~~~') {
      if (think) continue;
      if (fence === tok) {
        fence = null;
        open = -1;
      } else if (!fence) {
        fence = tok;
        open = m.index;
      }
    } else if (!fence) {
      if (tok.startsWith('</')) {
        think = false;
        open = -1;
      } else if (!think) {
        think = true;
        open = m.index;
      }
    }
  }
  return open >= from ? open : open >= 0 ? from : -1;
}
