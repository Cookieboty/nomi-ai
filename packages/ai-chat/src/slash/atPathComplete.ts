export interface AtPathToken {
  start: number;
  end: number;
  query: string;
}

/** Active @-token ending at caret: from nearest @ left of caret with no whitespace between @ and caret. */
export function atPathToken(text: string, caret: number): AtPathToken | null {
  const c = Math.max(0, Math.min(caret, text.length));
  const left = text.slice(0, c);
  const at = left.lastIndexOf('@');
  if (at < 0) return null;
  const between = left.slice(at + 1);
  if (/[\s\n]/.test(between)) return null;
  return { start: at, end: c, query: between };
}

export function replaceAtPathToken(
  text: string,
  token: AtPathToken,
  insert: string,
): { text: string; caret: number } {
  const next = text.slice(0, token.start) + insert + text.slice(token.end);
  return { text: next, caret: token.start + insert.length };
}
