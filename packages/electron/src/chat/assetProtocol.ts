import { promises as fsp } from 'node:fs';
import path from 'node:path';

import type { HostPorts } from '@nomi-ai/host-ports';
// 宿主代码：chat-asset:// 协议注册（protocol.handle）只能在 Electron 里做，P3 随协议注册移入宿主
import { app, protocol } from 'electron';

import { CHAT_BG_PRESET_URL, getChatBackgroundPresetFile } from './backgroundPreset';

export const CHAT_ASSET_SCHEME = 'chat-asset';

const IMG_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const AREAS = new Set(['images', 'presets']);

export async function resolveChatAssetUrl(
  root: string,
  rawUrl: string,
  presetFile = getChatBackgroundPresetFile(app.isPackaged),
): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== `${CHAT_ASSET_SCHEME}:` || !AREAS.has(u.hostname)) return null;
  if (u.hostname === 'presets' && rawUrl !== CHAT_BG_PRESET_URL) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (!rel || rel.includes('\0') || rel.split(/[\\/]/).some((seg) => seg === '..' || seg === ''))
    return null;
  if (!IMG_MIME[path.extname(rel).toLowerCase()]) return null;
  const isPreset = u.hostname === 'presets';
  const base = isPreset ? path.dirname(presetFile) : path.resolve(root, u.hostname);
  const file = isPreset ? presetFile : path.resolve(base, rel);
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

/** app ready 后调用：用户图片从 userData/chat 读取，预设从应用资源读取。*/
export function registerChatAssetProtocol(ports: Pick<HostPorts, 'paths' | 'app'>): void {
  const root = path.join(ports.paths.userData(), 'chat');
  const presetFile = getChatBackgroundPresetFile(ports.app.isPackaged(), ports.paths.resources());
  protocol.handle(CHAT_ASSET_SCHEME, async (req) => {
    const file = await resolveChatAssetUrl(root, req.url, presetFile);
    if (!file) return new Response('not found', { status: 404 });
    // 整个读入再返回：流式响应在 Windows 上会一直占着文件句柄（换图后旧图删不掉），
    // 且渲染端中途取消时可能拿到截断的数据；背景图有 CHAT_BG_MAX_BYTES 上限，读入内存无压力
    let body: Buffer;
    try {
      body = await fsp.readFile(file);
    } catch {
      return new Response('not found', { status: 404 });
    }
    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': chatAssetMimeFor(file),
        'content-length': String(body.length),
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      },
    });
  });
}
