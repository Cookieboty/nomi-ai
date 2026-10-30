/**
 * 更多文档格式的纯文本提取（纯 JS，无原生依赖）：odt（content.xml）、rtf（控制字剥离）、xlsx（共享字符串 + 工作表）。
 * 自行实现，只取文本，不执行任何宏 / 外部引用。
 */
import { strFromU8, unzipSync } from 'fflate';

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unescapeXml = (s: string) =>
  s
    .replace(/&(amp|lt|gt|quot|apos);/g, (_m, e: string) => ENT[e])
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)));

const parseErr = (m: string) => Object.assign(new Error(m), { code: 'parse_failed' });

function unzipSome(buf: Uint8Array, want: (name: string) => boolean): Record<string, Uint8Array> {
  try {
    return unzipSync(buf, { filter: (f) => want(f.name) && f.originalSize < 80 * 1024 * 1024 });
  } catch {
    throw parseErr('不是有效的压缩文档（zip）');
  }
}

// ---------- ODT ----------
export function odtXmlToText(xml: string): string {
  const body = xml.replace(/<office:annotation[\s\S]*?<\/office:annotation>/g, '');
  let out = '';
  const re =
    /<text:(p|h)\b[^>]*\/>|<\/text:(p|h)>|<text:tab\/>|<text:line-break\/>|<text:s(?:\s+text:c="(\d+)")?\/>|<[^>]+>|([^<]+)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m[4] !== undefined) out += m[4];
    else if (m[0] === '<text:tab/>') out += '\t';
    else if (m[0] === '<text:line-break/>') out += '\n';
    else if (m[0].startsWith('<text:s')) out += ' '.repeat(Number(m[3] ?? 1));
    else if (m[1] || m[2]) out += '\n';
  }
  return unescapeXml(out)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractOdt(buf: Uint8Array): string {
  const f = unzipSome(buf, (n) => n === 'content.xml');
  if (!f['content.xml']) throw parseErr('odt 中没有 content.xml');
  return odtXmlToText(strFromU8(f['content.xml']));
}

// ---------- XLSX ----------
function cellText(si: string): string {
  let s = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  for (let m = re.exec(si); m; m = re.exec(si)) s += m[1];
  return unescapeXml(s);
}

export function xlsxToText(files: Record<string, Uint8Array>, maxRows = 20000): string {
  const shared: string[] = [];
  const ss = files['xl/sharedStrings.xml'];
  if (ss) {
    const re = /<si>([\s\S]*?)<\/si>/g;
    const x = strFromU8(ss);
    for (let m = re.exec(x); m; m = re.exec(x)) shared.push(cellText(m[1]));
  }
  const names: string[] = [];
  const wb = files['xl/workbook.xml'];
  if (wb) {
    const re = /<sheet\b[^>]*\bname="([^"]*)"/g;
    const x = strFromU8(wb);
    for (let m = re.exec(x); m; m = re.exec(x)) names.push(unescapeXml(m[1]));
  }
  const sheets = Object.keys(files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  const parts: string[] = [];
  let rows = 0;
  sheets.forEach((name, i) => {
    const x = strFromU8(files[name]);
    const lines: string[] = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    for (let r = rowRe.exec(x); r && rows < maxRows; r = rowRe.exec(x)) {
      const cells: string[] = [];
      const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      for (let c = cRe.exec(r[1]); c; c = cRe.exec(r[1])) {
        const attrs = c[1];
        const inner = c[2] ?? '';
        const col = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
        if (col) {
          let idx = 0;
          for (const ch of col) idx = idx * 26 + (ch.charCodeAt(0) - 64);
          while (cells.length < idx - 1) cells.push('');
        }
        const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let val = '';
        if (t === 's' && v !== undefined) val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = cellText(inner);
        else if (v !== undefined) val = unescapeXml(v);
        cells.push(val.replace(/[\t\n]+/g, ' '));
      }
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (cells.length) lines.push(cells.join('\t'));
      rows += 1;
    }
    if (lines.length) parts.push(`## ${names[i] ?? `Sheet${i + 1}`}\n${lines.join('\n')}`);
  });
  return parts.join('\n\n');
}

export function extractXlsx(buf: Uint8Array): string {
  const f = unzipSome(
    buf,
    (n) =>
      n === 'xl/sharedStrings.xml' ||
      n === 'xl/workbook.xml' ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  );
  if (!Object.keys(f).some((n) => n.startsWith('xl/worksheets/')))
    throw parseErr('xlsx 中没有工作表');
  return xlsxToText(f);
}

// ---------- RTF ----------
const SKIP_DEST = new Set([
  'fonttbl',
  'colortbl',
  'stylesheet',
  'info',
  'pict',
  'header',
  'footer',
  'headerl',
  'headerr',
  'footerl',
  'footerr',
  'object',
  'themedata',
  'colorschememapping',
  'latentstyles',
  'datastore',
  'xmlnstbl',
  'listtable',
  'listoverridetable',
  'rsidtbl',
  'generator',
  'filetbl',
  'revtbl',
]);

function decoderFor(cp: number): TextDecoder {
  const name =
    cp === 936
      ? 'gbk'
      : cp === 950
        ? 'big5'
        : cp === 932
          ? 'shift_jis'
          : cp === 949
            ? 'euc-kr'
            : cp === 65001
              ? 'utf-8'
              : 'windows-1252';
  try {
    return new TextDecoder(name);
  } catch {
    return new TextDecoder('windows-1252');
  }
}

export function rtfToText(rtf: string): string {
  if (!rtf.startsWith('{\\rtf')) throw parseErr('不是有效的 rtf 文件');
  let dec = decoderFor(Number(/\\ansicpg(\d+)/.exec(rtf.slice(0, 2000))?.[1] ?? 1252));
  const stack: Array<{ skip: boolean; uc: number }> = [];
  let skip = false;
  let uc = 1;
  let out = '';
  let bytes: number[] = [];
  let pendingSkip = 0;
  const flushBytes = () => {
    if (bytes.length) {
      out += dec.decode(Uint8Array.from(bytes));
      bytes = [];
    }
  };
  let i = 0;
  while (i < rtf.length) {
    const ch = rtf[i];
    if (ch === '{') {
      flushBytes();
      stack.push({ skip, uc });
      i++;
      if (rtf.startsWith('\\*', i)) skip = true;
      continue;
    }
    if (ch === '}') {
      flushBytes();
      const s = stack.pop();
      if (s) ({ skip, uc } = s);
      i++;
      continue;
    }
    if (ch === '\\') {
      const nx = rtf[i + 1];
      if (nx === "'") {
        const hex = rtf.slice(i + 2, i + 4);
        i += 4;
        if (pendingSkip > 0) {
          pendingSkip--;
          continue;
        }
        if (!skip) bytes.push(parseInt(hex, 16));
        continue;
      }
      if (nx === '\\' || nx === '{' || nx === '}') {
        flushBytes();
        if (!skip) out += nx;
        i += 2;
        continue;
      }
      if (nx === '~') {
        flushBytes();
        if (!skip) out += '\u00a0';
        i += 2;
        continue;
      }
      const m = /^\\([a-z]+)(-?\d+)? ?/i.exec(rtf.slice(i, i + 40));
      if (!m) {
        i += 2;
        continue;
      }
      i += m[0].length;
      const word = m[1];
      const arg = m[2] !== undefined ? Number(m[2]) : undefined;
      flushBytes();
      if (SKIP_DEST.has(word)) skip = true;
      else if (word === 'ansicpg' && arg) dec = decoderFor(arg);
      else if (word === 'uc' && arg !== undefined) uc = arg;
      else if (word === 'u' && arg !== undefined) {
        if (!skip) out += String.fromCharCode(arg < 0 ? arg + 65536 : arg);
        pendingSkip = uc;
      } else if (!skip && (word === 'par' || word === 'line' || word === 'sect' || word === 'row'))
        out += '\n';
      else if (!skip && (word === 'tab' || word === 'cell')) out += '\t';
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (pendingSkip > 0) {
      pendingSkip--;
      i++;
      continue;
    }
    flushBytes();
    if (!skip) out += ch;
    i++;
  }
  flushBytes();
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
