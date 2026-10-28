/**
 * 拖入 / 粘贴的非图片文件附件：小文本文件连内容一起发，其余只发本机路径（模型 / 编程助手用工具去读）。
 * 附件按 <attached-file> 块拼在消息正文末尾，随正文走完所有通道（Nomi / 编程助手 / 持久化），
 * 显示时再从正文里拆出来画成卡片，所以不需要在消息结构里另加字段。
 * 路径经 `services/api` 的 hostPathForFile（preload 的 nomiHost）取；浏览器预览等没有桥的环境拿不到路径。
 */
import { hostPathForFile } from './api';

export interface FileAttachment {
  id: string;
  name: string;
  /** 本机绝对路径；拿不到时为空 */
  path: string;
  size: number;
  /** 文本内容；二进制或太大的文件没有 */
  text?: string;
}

export const MAX_FILE_ATTACHMENTS = 10;
/** 超过这个大小只发路径，不把内容塞进上下文 */
export const MAX_TEXT_BYTES = 200 * 1024;

const TAG = 'attached-file';

const newId = () => `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** 非本地文件（如网页拖来的内容）没有路径 */
const pathOf = (f: File): string => hostPathForFile(f);

/** 能按 UTF-8 解码且不含 NUL 的才算文本 */
async function readText(f: File): Promise<string | undefined> {
  if (f.size > MAX_TEXT_BYTES) return undefined;
  try {
    const buf = await f.arrayBuffer();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return text.includes('\0') ? undefined : text;
  } catch {
    return undefined;
  }
}

/** 既没路径也读不出文本的文件（浏览器里拖入的二进制）发了也没用，返回 null */
export async function fileAttachmentFrom(f: File): Promise<FileAttachment | null> {
  const path = pathOf(f);
  const text = await readText(f);
  if (!path && text === undefined) return null;
  return { id: newId(), name: f.name, path, size: f.size, ...(text !== undefined && { text }) };
}

const escAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const unescAttr = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
const CLOSE = `</${TAG}>`;
const CLOSE_ESC = `<\\/${TAG}>`;

function serialize(f: FileAttachment): string {
  const attrs = `name="${escAttr(f.name)}"${f.path ? ` path="${escAttr(f.path)}"` : ''}`;
  if (f.text === undefined) return `<${TAG} ${attrs} />`;
  return `<${TAG} ${attrs}>\n${f.text.split(CLOSE).join(CLOSE_ESC)}\n${CLOSE}`;
}

/** 正文 + 附件块 → 发给模型的完整消息 */
export function joinFileAttachments(text: string, files: FileAttachment[]): string {
  if (!files.length) return text;
  const blocks = files.map(serialize).join('\n\n');
  return text ? `${text}\n\n${blocks}` : blocks;
}

const BLOCK = new RegExp(
  `<${TAG} name="([^"]*)"(?: path="([^"]*)")?\\s*(?:/>|>\\n?([\\s\\S]*?)\\n?${CLOSE})`,
  'g',
);

/** 完整消息 → 正文 + 附件（显示 / 编辑重发用） */
export function splitFileAttachments(full: string): { text: string; files: FileAttachment[] } {
  if (!full.includes(`<${TAG} `)) return { text: full, files: [] };
  const files: FileAttachment[] = [];
  const text = full
    .replace(BLOCK, (_m, name: string, path: string | undefined, body: string | undefined) => {
      const content = body?.split(CLOSE_ESC).join(CLOSE);
      files.push({
        id: `f_${files.length}`,
        name: unescAttr(name),
        path: path ? unescAttr(path) : '',
        size: content?.length ?? 0,
        ...(content !== undefined && { text: content }),
      });
      return '';
    })
    .trim();
  return { text, files };
}
