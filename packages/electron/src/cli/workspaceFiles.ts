/**
 * 会话工作区内只读/写文本文件（Changes 预览编辑）。
 * 路径必须落在 cwd 内；禁止 .. 与绝对路径逃逸。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TEXT_MAX = 1_500_000; // ~1.5MB

export interface WorkspaceFileResult {
  ok: boolean;
  path?: string;
  /** 相对 cwd */
  rel?: string;
  content?: string;
  truncated?: boolean;
  binary?: boolean;
  size?: number;
  mtimeMs?: number;
  error?: string;
  code?: 'outside' | 'not-found' | 'is-dir' | 'too-large' | 'io' | 'invalid' | 'not-git';
}

function resolveInCwd(
  cwd: string,
  filePath: string,
):
  | { ok: true; abs: string; rel: string }
  | { ok: false; error: string; code: 'outside' | 'invalid' } {
  const root = path.resolve(String(cwd ?? ''));
  const raw = String(filePath ?? '').trim();
  if (!raw || raw.includes('\0')) {
    return { ok: false, error: 'invalid path', code: 'invalid' };
  }
  // 禁止绝对路径直接落到 cwd 外；绝对路径也必须仍在 root 下
  const abs = path.resolve(root, raw);
  const rel = path.relative(root, abs);
  if (!rel && rel !== '') {
    // abs === root：不允许把目录当文件写
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: 'path outside workspace', code: 'outside' };
  }
  // Windows 盘符差异
  if (process.platform === 'win32') {
    const rootN = root.replace(/\\/g, '/').toLowerCase();
    const absN = abs.replace(/\\/g, '/').toLowerCase();
    if (absN !== rootN && !absN.startsWith(rootN.endsWith('/') ? rootN : rootN + '/')) {
      return { ok: false, error: 'path outside workspace', code: 'outside' };
    }
  }
  return { ok: true, abs, rel: rel || path.basename(abs) };
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function readWorkspaceFile(cwd: string, filePath: string): WorkspaceFileResult {
  const r = resolveInCwd(cwd, filePath);
  if (!r.ok) return { ok: false, error: r.error, code: r.code };
  try {
    if (!fs.existsSync(r.abs)) {
      return { ok: false, path: r.abs, rel: r.rel, error: 'not found', code: 'not-found' };
    }
    const st = fs.statSync(r.abs);
    if (st.isDirectory()) {
      return { ok: false, path: r.abs, rel: r.rel, error: 'is a directory', code: 'is-dir' };
    }
    if (st.size > TEXT_MAX) {
      return {
        ok: false,
        path: r.abs,
        rel: r.rel,
        size: st.size,
        error: 'file too large',
        code: 'too-large',
      };
    }
    const buf = fs.readFileSync(r.abs);
    if (looksBinary(buf)) {
      return {
        ok: true,
        path: r.abs,
        rel: r.rel,
        binary: true,
        size: st.size,
        mtimeMs: st.mtimeMs,
        content: '',
      };
    }
    let content = buf.toString('utf8');
    const truncated = content.length > TEXT_MAX;
    if (truncated) content = content.slice(0, TEXT_MAX);
    return {
      ok: true,
      path: r.abs,
      rel: r.rel,
      content,
      truncated,
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
  } catch (e) {
    return {
      ok: false,
      path: r.abs,
      rel: r.rel,
      error: e instanceof Error ? e.message : String(e),
      code: 'io',
    };
  }
}

export function writeWorkspaceFile(
  cwd: string,
  filePath: string,
  content: string,
): WorkspaceFileResult {
  const r = resolveInCwd(cwd, filePath);
  if (!r.ok) return { ok: false, error: r.error, code: r.code };
  if (typeof content !== 'string') {
    return { ok: false, error: 'invalid content', code: 'invalid' };
  }
  if (Buffer.byteLength(content, 'utf8') > TEXT_MAX) {
    return { ok: false, error: 'content too large', code: 'too-large' };
  }
  try {
    if (fs.existsSync(r.abs) && fs.statSync(r.abs).isDirectory()) {
      return { ok: false, path: r.abs, rel: r.rel, error: 'is a directory', code: 'is-dir' };
    }
    fs.mkdirSync(path.dirname(r.abs), { recursive: true });
    const tmp = `${r.abs}.nomi-tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, r.abs);
    const st = fs.statSync(r.abs);
    return {
      ok: true,
      path: r.abs,
      rel: r.rel,
      content,
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
  } catch (e) {
    return {
      ok: false,
      path: r.abs,
      rel: r.rel,
      error: e instanceof Error ? e.message : String(e),
      code: 'io',
    };
  }
}

export function deleteWorkspaceFile(cwd: string, filePath: string): WorkspaceFileResult {
  const r = resolveInCwd(cwd, filePath);
  if (!r.ok) return { ok: false, error: r.error, code: r.code };
  try {
    if (!fs.existsSync(r.abs)) {
      return { ok: true, path: r.abs, rel: r.rel }; // already gone
    }
    if (fs.statSync(r.abs).isDirectory()) {
      return { ok: false, path: r.abs, rel: r.rel, error: 'is a directory', code: 'is-dir' };
    }
    fs.unlinkSync(r.abs);
    return { ok: true, path: r.abs, rel: r.rel };
  } catch (e) {
    return {
      ok: false,
      path: r.abs,
      rel: r.rel,
      error: e instanceof Error ? e.message : String(e),
      code: 'io',
    };
  }
}

/**
 * 安全路径下 `git checkout -- <rel>`：仅还原已跟踪文件到 HEAD。
 * 不执行其它 git 写操作。
 */
export function gitCheckoutWorkspaceFile(cwd: string, filePath: string): WorkspaceFileResult {
  const r = resolveInCwd(cwd, filePath);
  if (!r.ok) return { ok: false, error: r.error, code: r.code };
  try {
    const gitDir = path.join(path.resolve(String(cwd ?? '')), '.git');
    if (!fs.existsSync(gitDir)) {
      return { ok: false, path: r.abs, rel: r.rel, error: 'not a git repository', code: 'not-git' };
    }
    execFileSync('git', ['checkout', '--', r.rel], {
      cwd: path.resolve(String(cwd ?? '')),
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, path: r.abs, rel: r.rel };
  } catch (e) {
    return {
      ok: false,
      path: r.abs,
      rel: r.rel,
      error: e instanceof Error ? e.message : String(e),
      code: 'io',
    };
  }
}

/** 测试 / 单测导出 */
export const _test = { resolveInCwd, TEXT_MAX };
