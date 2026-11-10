/** Resource targets remain data: local files are opened through the Go contract, never file: navigation. */
export interface ResourceTarget {
  href: string;
  path?: string;
  line?: number;
  lineEnd?: number;
  /** Decoded document heading, separate from the literal filesystem path. */
  fragment?: string;
  web?: boolean;
}
// Parse location syntax before URL decoding so escaped #/: characters in real
// filenames stay literal. Columns are accepted; the preview locates whole lines.
// Markdown and file URLs may percent-encode typographic range separators.
// Match those separators only inside a location, never by decoding the whole path.
const RANGE_SEPARATOR = String.raw`(?:[-–—−]|%[eE]2%80%9[34]|%[eE]2%88%92)`;
const COLON_LOCATION = String.raw`:L?(\d+)(?::\d+)?(?:${RANGE_SEPARATOR}L?(\d+)(?::\d+)?)?`;
const HASH_LOCATION = String.raw`#L(\d+)(?:C\d+)?(?:${RANGE_SEPARATOR}L?(\d+)(?:C\d+)?)?`;
const LOCATION_SUFFIX = `(?:${COLON_LOCATION}|${HASH_LOCATION})`;
const LOCATION = new RegExp(`${LOCATION_SUFFIX}$`);
const SOURCE_FRAGMENT = new RegExp(`^${HASH_LOCATION}$`);
const BASENAME_LOCATION = new RegExp(
  String.raw`^[^:\\/]+\.[A-Za-z][A-Za-z\d]{0,11}${COLON_LOCATION}$`,
);
export function resourceTarget(raw: string): ResourceTarget | null {
  let value = raw.trim();
  if (!value || Array.from(value).some((c) => c.charCodeAt(0) < 32)) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      if (u.username || u.password) return null;
      return { href: value, web: true };
    } catch {
      return null;
    }
  }
  if (/^chat-asset:\/\//i.test(value) || /^data:image\//i.test(value) || /^blob:/i.test(value))
    return { href: value };
  if (/^file:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      if (u.host && u.host !== 'localhost') return null;
      // Keep both the encoded pathname and source fragment until location
      // parsing, then decode the pathname exactly once below.
      value = u.pathname + u.hash;
      if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
    } catch {
      return null;
    }
  } else if (
    /^[a-z][a-z\d+.-]*:/i.test(value) &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    !BASENAME_LOCATION.test(value)
  )
    return null;
  // A href beginning with # is a document anchor, not a file.
  if (value.startsWith('#')) return null;
  let fragment: string | undefined;
  const hash = value.indexOf('#');
  // A percent-encoded hash belongs to the filename. Split only literal URL syntax,
  // before decoding either part. #L… remains a source location, not a heading.
  if (hash >= 0 && !SOURCE_FRAGMENT.test(value.slice(hash))) {
    try {
      fragment = decodeURIComponent(value.slice(hash + 1));
    } catch {
      return null;
    }
    value = value.slice(0, hash);
  }
  let line: number | undefined;
  let lineEnd: number | undefined;
  const location = LOCATION.exec(value);
  if (location) {
    line = Number(location[1] ?? location[3]);
    const end = location[2] ?? location[4];
    lineEnd = end === undefined ? undefined : Number(end);
    if (
      !Number.isSafeInteger(line) ||
      line < 1 ||
      (lineEnd !== undefined && (!Number.isSafeInteger(lineEnd) || lineEnd < line))
    )
      return null;
    value = value.slice(0, location.index);
  }
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (
    !/^(?:\/|~[\\/]|\.{1,3}[\\/]|…[\\/]|[A-Za-z]:[\\/])/.test(value) &&
    !/^[^<>\n"|?*]+\.[A-Za-z][A-Za-z\d]{0,11}$/.test(value)
  )
    return null;
  if (/[<>]/.test(value) || Array.from(value + (fragment ?? '')).some((c) => c.charCodeAt(0) < 32))
    return null;
  return { href: raw, path: value, line, lineEnd, ...(fragment !== undefined ? { fragment } : {}) };
}

export function dirname(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
}
export function resolveDocumentPath(base: string, target: string): string {
  if (/^(?:https?:|data:|blob:|chat-asset:|file:)/i.test(target)) return target;
  if (/^(?:\/|~[\\/]|[A-Za-z]:[\\/])/.test(target)) return target;
  const parts = `${base}/${target}`.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.') out.push(p);
  }
  return out.join('/');
}

/** The host provides a literal directory, while Markdown destinations are URL-encoded.
 * Encode only the directory so literal percent/hash characters there are not reinterpreted. */
export function resolveDocumentHref(directory: string, href: string): string {
  return resolveDocumentPath(workspaceFileHref('', directory), href);
}

/** File-list paths are literal filenames, not Markdown URLs or line-location suffixes. */
export function workspaceFileHref(cwd: string, path: string): string {
  return resolveDocumentPath(cwd, path)
    .replace(/\\/g, '/')
    .split('/')
    .map((part, index) =>
      index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part),
    )
    .join('/');
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
