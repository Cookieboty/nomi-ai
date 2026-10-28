/**
 * 包内相对路径规范化（纯函数，Node 与浏览器通用）。
 * 拒绝绝对路径、盘符、`..` 越界与空段；统一为 `/` 分隔，去掉开头的 `./` 与结尾的 `/`。
 */
export function normalizePackPath(input: string): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim().replace(/\\/g, '/');
  if (!raw) return null;
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw) || raw.includes('\0')) return null;
  const out: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    out.push(seg);
  }
  return out.length ? out.join('/') : null;
}

/** 拼接包内相对路径；任何一段不合法时返回 null。 */
export function joinPackPath(...parts: string[]): string | null {
  return normalizePackPath(parts.filter(Boolean).join('/'));
}
