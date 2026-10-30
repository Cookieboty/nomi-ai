/**
 * 检索分词（纯逻辑，无依赖）：拉丁字母 / 数字按词切分并小写；中日韩文字按「单字 + 相邻二元组」切分，
 * 不需要词典也能对中文做不错的 BM25 召回。
 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const STOP = new Set([
  'the',
  'a',
  'an',
  'of',
  'to',
  'and',
  'or',
  'in',
  'on',
  'is',
  'are',
  'was',
  'be',
  'for',
  'with',
  'it',
  'this',
  'that',
  'as',
  'at',
  'by',
  'from',
  '的',
  '了',
  '是',
  '在',
  '和',
  '吗',
  '呢',
  '吧',
  '啊',
]);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const s = text.normalize('NFKC').toLowerCase();
  let word = '';
  let prevCjk = '';
  const flush = () => {
    if (word.length > 1 && !STOP.has(word) && word.length <= 40) out.push(word);
    word = '';
  };
  for (const ch of s) {
    if (CJK.test(ch)) {
      flush();
      if (!STOP.has(ch)) out.push(ch);
      if (prevCjk) out.push(prevCjk + ch);
      prevCjk = ch;
    } else if (/[\p{L}\p{N}_]/u.test(ch)) {
      prevCjk = '';
      word += ch;
    } else {
      prevCjk = '';
      flush();
    }
  }
  flush();
  return out;
}
