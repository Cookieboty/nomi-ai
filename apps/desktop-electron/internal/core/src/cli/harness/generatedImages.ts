/**
 * 编程助手生成的图片（Grok image_gen 等）：复制到 chat-asset 根目录，并把回复里的本地路径改写成
 * chat-asset:// 链接，渲染进程才能安全加载。只接受各 CLI 会话目录里的图片文件。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CHAT_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_ALIAS_FILE = 'image-aliases.json';

/** Grok image_gen 返回本地图片路径；复制到 chat-asset 根目录后才能被渲染进程安全加载。 */
export function materializeGeneratedImages(
  rawOutput: string,
  home: string,
  chatRoot: string,
  aliases: Map<string, string>,
): void {
  let value: unknown;
  try {
    value = JSON.parse(rawOutput);
  } catch {
    return;
  }
  const paths = new Set<string>();
  const visit = (v: unknown, depth = 0): void => {
    if (depth > 6 || v === null || v === undefined) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.path === 'string') paths.add(o.path);
    for (const key of ['content', 'rawOutput', 'output', 'result', 'data'])
      visit(o[key], depth + 1);
  };
  visit(value);
  if (!paths.size) return;
  const roots = [
    path.join(home, '.grok', 'sessions'),
    process.env.GROK_HOME ? path.join(process.env.GROK_HOME, 'sessions') : '',
  ]
    .filter(Boolean)
    .map((x) => {
      const resolved = path.resolve(x);
      // 候选路径会做 realpath；根目录也要 realpath，否则 HOME 经符号链接（macOS 的 /var → /private/var）时合法图片会被拒掉
      try {
        return fs.realpathSync(resolved);
      } catch {
        return resolved;
      }
    });
  const destDir = path.join(chatRoot, 'images');
  let changed = false;
  for (const raw of paths) {
    const ext = path.extname(raw).toLowerCase();
    if (!CHAT_IMAGE_EXTS.has(ext)) continue;
    const normalized = raw.replaceAll('\\', '/').replace(/^\.\//, '');
    const marker = normalized.lastIndexOf('/images/');
    const shortAlias = marker >= 0 ? normalized.slice(marker + 1) : normalized;
    // 仅按完整源路径复用；不同 session 都可能使用 images/1.jpg，不能跨 session 误绑定。
    const existing = aliases.get(normalized) ?? aliases.get(raw);
    if (existing && materializedImageExists(chatRoot, existing)) {
      aliases.set(normalized, existing);
      aliases.set(raw, existing);
      aliases.set(shortAlias, existing);
      continue;
    }
    const candidate = path.isAbsolute(raw)
      ? path.resolve(raw)
      : path.resolve(roots[0] ?? path.join(home, '.grok', 'sessions'), raw);
    let real: string;
    try {
      real = fs.realpathSync(candidate);
      const stat = fs.statSync(real);
      if (!stat.isFile() || stat.size > MAX_GENERATED_IMAGE_BYTES) continue;
    } catch {
      continue;
    }
    if (!roots.some((root) => real === root || real.startsWith(`${root}${path.sep}`))) continue;
    const file = `grok-${randomUUID()}${ext}`;
    const dest = path.join(destDir, file);
    try {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(real, dest);
    } catch {
      continue;
    }
    const url = `chat-asset://images/${file}`;
    aliases.set(normalized, url);
    aliases.set(raw, url);
    aliases.set(shortAlias, url);
    changed = true;
  }
  if (changed) persistImageAliases(chatRoot, aliases);
}

function materializedImageExists(chatRoot: string, url: string): boolean {
  const match = /^chat-asset:\/\/images\/([^/]+)$/.exec(url);
  if (!match) return false;
  const file = path.resolve(chatRoot, 'images', match[1]!);
  return file.startsWith(`${path.resolve(chatRoot, 'images')}${path.sep}`) && fs.existsSync(file);
}

export function loadImageAliases(chatRoot: string): Map<string, string> {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(chatRoot, IMAGE_ALIAS_FILE), 'utf8'),
    ) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
    return new Map(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === 'string' &&
          typeof entry[1] === 'string' &&
          /^chat-asset:\/\/images\/[A-Za-z0-9._-]+$/.test(entry[1]),
      ),
    );
  } catch {
    return new Map();
  }
}

function persistImageAliases(chatRoot: string, aliases: Map<string, string>): void {
  try {
    fs.mkdirSync(chatRoot, { recursive: true });
    fs.writeFileSync(
      path.join(chatRoot, IMAGE_ALIAS_FILE),
      JSON.stringify(Object.fromEntries(aliases)),
      'utf8',
    );
  } catch {
    /* 图片已经复制成功；索引写入失败不影响当前轮显示。 */
  }
}

export function rewriteGeneratedImageLinks(text: string, aliases: Map<string, string>): string {
  if (!aliases.size || !text.includes('![')) return text;
  return text.replace(/(!\[[^\]]*\]\()([^)]+)(\))/g, (full, before, rawUrl, after) => {
    const key = String(rawUrl).trim();
    let decoded = key;
    try {
      decoded = decodeURIComponent(key);
    } catch {
      /* 保留原始 key；畸形百分号编码不应中断整轮输出。 */
    }
    const url = aliases.get(key) ?? aliases.get(decoded);
    return url ? `${before}${url}${after}` : full;
  });
}
