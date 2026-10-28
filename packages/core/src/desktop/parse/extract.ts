/**
 * 文本提取（在受限的子进程里运行，见 worker.ts / runParse.ts）：
 * txt / md / csv / json / 代码 → UTF-8 文本；pdf → unpdf（pdf.js 无 worker 版）；docx → fflate 解 zip + 解析 word/document.xml；
 * odt / xlsx / rtf → office.ts。
 */
import { strFromU8, unzipSync } from 'fflate';

import { extractOdt, extractXlsx, rtfToText } from './office';

export const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'log',
  'yaml',
  'yml',
  'toml',
  'ini',
  'xml',
  'html',
  'htm',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'swift',
  'php',
  'sh',
  'sql',
  'css',
  'scss',
  'vue',
  'svelte',
  'tex',
  'rst',
  'org',
]);
export const DOC_EXTS = new Set(['pdf', 'docx', 'odt', 'rtf', 'xlsx']);

export function extOf(p: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(p);
  return m ? m[1].toLowerCase() : '';
}

export function isSupported(p: string): boolean {
  const e = extOf(p);
  return TEXT_EXTS.has(e) || DOC_EXTS.has(e);
}

export interface Extracted {
  text: string;
  mime: string;
  pages?: number;
  /** 每页文本（仅 pdf） */
  pageTexts?: string[];
}

export function decodeText(buf: Uint8Array): string {
  // 含 NUL 视为二进制
  const probe = buf.subarray(0, Math.min(buf.length, 8192));
  if (probe.includes(0))
    throw Object.assign(new Error('看起来是二进制文件'), { code: 'unsupported' });
  let start = 0;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  return new TextDecoder('utf-8').decode(buf.subarray(start));
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** word/document.xml → 纯文本：只取 <w:t> 文本，段落 / 换行 → \n，制表 → \t */
export function docxXmlToText(xml: string): string {
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br[^>]*\/>|<\/w:p>/g;
  let out = '';
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[1] !== undefined) out += m[1];
    else if (m[0] === '<w:tab/>') out += '\t';
    else out += '\n';
  }
  return out
    .replace(/&(amp|lt|gt|quot|apos);/g, (_m, e: string) => XML_ENTITIES[e])
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractDocx(buf: Uint8Array): Extracted {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf, {
      filter: (f) => f.name === 'word/document.xml' && f.originalSize < 50 * 1024 * 1024,
    });
  } catch {
    throw Object.assign(new Error('不是有效的 docx 文件'), { code: 'parse_failed' });
  }
  const xml = files['word/document.xml'];
  if (!xml)
    throw Object.assign(new Error('docx 中没有 word/document.xml'), { code: 'parse_failed' });
  return {
    text: docxXmlToText(strFromU8(xml)),
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
}

export async function extractPdf(buf: Uint8Array): Promise<Extracted> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pageTexts = (text as string[]).map((t) => t.trim());
  return { text: pageTexts.join('\n\n'), mime: 'application/pdf', pages: totalPages, pageTexts };
}

export async function extract(buf: Uint8Array, filePath: string): Promise<Extracted> {
  const e = extOf(filePath);
  if (e === 'pdf') return extractPdf(buf);
  if (e === 'docx') return extractDocx(buf);
  if (e === 'odt')
    return { text: extractOdt(buf), mime: 'application/vnd.oasis.opendocument.text' };
  if (e === 'xlsx')
    return {
      text: extractXlsx(buf),
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  if (e === 'rtf')
    return { text: rtfToText(new TextDecoder('latin1').decode(buf)), mime: 'application/rtf' };
  if (TEXT_EXTS.has(e))
    return {
      text: decodeText(buf),
      mime: e === 'md' || e === 'markdown' ? 'text/markdown' : 'text/plain',
    };
  throw Object.assign(new Error(`不支持的文件类型：.${e || '(无扩展名)'}`), {
    code: 'unsupported',
  });
}
