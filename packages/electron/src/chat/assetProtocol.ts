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

const AREAS = new Set(['images', 'presets']);

export async function resolveChatAssetUrl(root: string, rawUrl: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== `${CHAT_ASSET_SCHEME}:` || !AREAS.has(u.hostname)) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (!rel || rel.includes('\0') || rel.split(/[\\/]/).some((seg) => seg === '..' || seg === ''))
    return null;
  if (!IMG_MIME[path.extname(rel).toLowerCase()]) return null;
  const base = path.resolve(root, u.hostname);
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

/** app ready 后调用：响应 chat-asset:// 请求，根为 userData/chat。*/
export function registerChatAssetProtocol(): void {
  const root = path.join(app.getPath('userData'), 'chat');
  protocol.handle(CHAT_ASSET_SCHEME, async (req) => {
    const file = await resolveChatAssetUrl(root, req.url);
    if (!file) return new Response('not found', { status: 404 });
    const body = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream;
    return new Response(body, {
      headers: {
        'content-type': chatAssetMimeFor(file),
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      },
    });
  });
}
