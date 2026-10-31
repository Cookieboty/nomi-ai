/**
 * character-pack:// protocol:
 *   - character-pack://pack/<relpath>  — files of the active Scheme B overlay root;
 *   - character-pack://assets/<packId>/<file>  — downloaded remote character assets
 *     (<userData>/character-assets, see CharacterAssets.ts).
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const CHARACTER_PACK_SCHEME = 'character-pack';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.json': 'application/json',
  '.riv': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8',
};

export const CHARACTER_PACK_SCHEME_PRIVILEGES: {
  scheme: string;
  privileges: {
    standard: boolean;
    secure: boolean;
    supportFetchAPI: boolean;
    corsEnabled: boolean;
    stream: boolean;
  };
} = {
  scheme: CHARACTER_PACK_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
};

export function characterPackMimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Resolve character-pack://pack/<rel> against an overlay root. Returns absolute path or null. */
export function resolveCharacterPackUrl(
  root: string | null,
  rawUrl: string,
): Promise<string | null> {
  return resolveUnder(root, rawUrl, 'pack');
}

/** Resolve character-pack://assets/<packId>/<file> against the remote-asset cache root. */
export function resolveCharacterAssetUrl(
  assetsRoot: string | null,
  rawUrl: string,
): Promise<string | null> {
  return resolveUnder(assetsRoot, rawUrl, 'assets');
}

async function resolveUnder(
  root: string | null,
  rawUrl: string,
  host: 'pack' | 'assets',
): Promise<string | null> {
  if (!root) return null;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== `${CHARACTER_PACK_SCHEME}:` || u.hostname !== host) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (!rel || rel.includes('\0') || rel.split(/[\\/]/).some((seg) => seg === '..')) return null;
  const base = path.resolve(root);
  const file = path.resolve(base, rel);
  if (!file.startsWith(base + path.sep) && file !== base) return null;
  try {
    const real = await fsp.realpath(file);
    const realBase = await fsp.realpath(base);
    if (!real.startsWith(realBase + path.sep) && real !== realBase) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * Normalize a pack-manifest relative asset path for URL / filesystem use.
 * Strips leading ./ and / , unifies separators, rejects empty / absolute / traversal.
 * Returns null when the path is unsafe or empty.
 */
export function normalizePackRelPath(relPath: string | null | undefined): string | null {
  if (relPath == null) return null;
  let s = String(relPath).trim().replace(/\\/g, '/');
  // Reject absolute (posix / win drive) before stripping cosmetic prefixes
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null;
  // Drop leading ./ segments (manifest authors often write "./rive/x.riv")
  while (s.startsWith('./')) s = s.slice(2);
  if (!s) return null;
  const keepSlash = s.endsWith('/');
  const parts = s.split('/').filter((seg) => seg.length > 0 && seg !== '.');
  if (parts.length === 0 || parts.some((seg) => seg === '..')) return null;
  return keepSlash ? `${parts.join('/')}/` : parts.join('/');
}

export function characterPackAssetUrl(relPath: string): string {
  const clean = normalizePackRelPath(relPath) ?? relPath.replace(/^\/+/, '').split('\\').join('/');
  return `${CHARACTER_PACK_SCHEME}://pack/${clean}`;
}

/** Register after app ready. Pass electron.protocol from caller to keep this module electron-free for tests. */
export function registerCharacterPackProtocol(
  protocol: {
    handle: (scheme: string, handler: (req: Request) => Promise<Response> | Response) => void;
  },
  getRoot: () => string | null,
  getAssetsRoot: () => string | null = () => null,
): void {
  protocol.handle(CHARACTER_PACK_SCHEME, async (req) => {
    const file =
      (await resolveCharacterPackUrl(getRoot(), req.url)) ??
      (await resolveCharacterAssetUrl(getAssetsRoot(), req.url));
    if (!file) return new Response('not found', { status: 404 });
    let body: Buffer;
    try {
      body = await fsp.readFile(file);
    } catch {
      return new Response('not found', { status: 404 });
    }
    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': characterPackMimeFor(file),
        'content-length': String(body.length),
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      },
    });
  });
}
