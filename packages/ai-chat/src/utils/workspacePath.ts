/** 工作目录显示：把家目录换成 ~，过长时保留最后两段（完整路径放 tooltip）。 */
export function shortenPath(full: string, max = 28): string {
  if (!full) return '';
  const norm = full.replace(/\\/g, '/').replace(/\/+$/, '');
  const home = norm.match(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)(\/|$)/);
  let p = home ? `~${norm.slice(home[1]!.length)}` : norm;
  if (!p) p = '/';
  if (p.length <= max) return p;
  const parts = p.split('/').filter(Boolean);
  const tail = parts.slice(-2).join('/');
  return `…/${tail}`.length <= max ? `…/${tail}` : `…/${parts[parts.length - 1]}`;
}

/** 将绝对路径收成 cwd 相对路径（若落在工作区内）；否则原样返回 */
export function workspaceRelPath(cwd: string | null | undefined, filePath: string): string {
  if (!cwd || !filePath) return filePath;
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const c = norm(cwd);
  let f = norm(filePath);
  if (f.startsWith('file://')) f = decodeURIComponent(f.slice(7));
  if (f === c) return f.split('/').pop() || f;
  if (f.startsWith(`${c}/`)) return f.slice(c.length + 1);
  return filePath;
}

/** 路径比较键：统一分隔符、去掉末尾斜杠；Windows 盘符路径大小写不敏感 */
export function workspaceKey(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return /^[A-Za-z]:\//.test(p) || /^[A-Za-z]:$/.test(p) ? p.toLowerCase() : p;
}

/** p 落在哪个文件夹里（最长的那个）；都不在时 undefined */
export function rootOf(roots: readonly string[], p: string): string | undefined {
  const k = workspaceKey(p);
  let best: string | undefined;
  for (const r of roots) {
    const rk = workspaceKey(r);
    if ((k === rk || k.startsWith(`${rk}/`)) && (!best || r.length > best.length)) best = r;
  }
  return best;
}
