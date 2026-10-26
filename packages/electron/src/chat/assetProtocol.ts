import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { app, protocol } from 'electron';

export const CHAT_ASSET_SCHEME = 'chat-asset';

const IMG_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const AREAS = new Set(['images']);

/**
 * 解析 chat-asset:// URL 到真实文件。
 * extraRoots 为额外区域 → 绝对根目录（如 media → userData/media/assets），仅显式传入时开放。
 */
export async function resolveChatAssetUrl(
  root: string,
  rawUrl: string,
  extraRoots?: Record<string, string>,
): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const extra = extraRoots && Object.hasOwn(extraRoots, u.hostname) ? extraRoots[u.hostname] : null;
  if (u.protocol !== `${CHAT_ASSET_SCHEME}:` || (!AREAS.has(u.hostname) && !extra)) return null;
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  if (!rel || rel.includes('\0') || rel.split(/[\\/]/).some((seg) => seg === '..' || seg === ''))
    return null;
  if (!IMG_MIME[path.extname(rel).toLowerCase()]) return null;
  const base = extra ? path.resolve(extra) : path.resolve(root, u.hostname);
  const file = path.resolve(base, rel);
  if (!file.startsWith(base + path.sep)) return null;
  try {
    const real = await fsp.realpath(file);
    const realBase = await fsp.realpath(base);
    if (!real.startsWith(realBase + path.sep)) return null;
    return real;
  } catch {
    return null;
  }
}

export function chatAssetMimeFor(file: string): string {
  return IMG_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** chat-asset:// 的特权声明：支持 fetch 与 <img> 加载。由 registerAppSchemePrivileges 统一注册 */
export const CHAT_ASSET_SCHEME_PRIVILEGES: Electron.CustomScheme = {
  scheme: CHAT_ASSET_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
};

/** app ready 后调用：响应 chat-asset:// 请求，根为 userData/chat；media 区域指向素材库目录。*/
export function registerChatAssetProtocol(): void {
  const root = path.join(app.getPath('userData'), 'chat');
  const extra = { media: path.join(app.getPath('userData'), 'media', 'assets') };
  protocol.handle(CHAT_ASSET_SCHEME, async (req) => {
    const file = await resolveChatAssetUrl(root, req.url, extra);
    if (!file) return new Response('not found', { status: 404 });
    const body = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream;
    return new Response(body, {
      headers: {
        'content-type': chatAssetMimeFor(file),
        'access-control-allow-origin': '*',
        'cache-control': 'no-cache',
      },
    });
  });
}
