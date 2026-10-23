/**
 * 会话工作区内只读/写文本文件（Changes 预览编辑）。
 * 路径必须落在 cwd 内；禁止 .. 与绝对路径逃逸。
 */
import { execFile, execFileSync } from 'node:child_process';
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

/** 依赖目录：不展示（动辄几万到几十万个文件，没人会在文件树里翻）。依赖与缓存之外的文件即使被 .gitignore 忽略也展示 */
const DEP_DIRS = new Set([
  'node_modules',
  '.pnpm-store',
  'bower_components',
  'jspm_packages',
  '.venv',
  'venv',
  '__pycache__',
  'Pods',
]);
/** 版本库内部目录 */
const VCS_DIRS = new Set(['.git', '.hg', '.svn']);
/** 框架 / 工具的缓存目录：都是可再生成的中间产物，展示没有意义（构建产物 dist、build 仍展示） */
const CACHE_DIRS = new Set([
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vite',
  '.angular',
  '.expo',
  '.gradle',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.eslintcache',
]);
/** Next.js 缓存：.next 以及自定义 distDir 的 .next-dev / .next-xxx */
const NEXT_CACHE = /^\.next(-.+)?$/;
const skipDir = (name: string) =>
  DEP_DIRS.has(name) || VCS_DIRS.has(name) || CACHE_DIRS.has(name) || NEXT_CACHE.test(name);
/** 系统垃圾文件 */
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export interface WorkspaceTreeNode {
  kind: 'file' | 'dir';
  name: string;
  /** 相对 cwd，posix 斜杠 */
  path: string;
  /** 被 .gitignore 忽略（仍展示，渲染端置灰） */
  ignored?: boolean;
  children?: WorkspaceTreeNode[];
}

export interface WorkspaceTreeResult {
  ok: boolean;
  entries?: WorkspaceTreeNode[];
  error?: string;
  code?: WorkspaceFileResult['code'];
}

/**
 * git 仓库里被忽略的路径：`git ls-files --others --ignored --exclude-standard --directory`，
 * 整个被忽略的目录只输出一条 `dir/`，量很小。不是仓库 / git 不可用时返回空集。异步，不阻塞主进程。
 */
function listGitIgnored(root: string): Promise<Set<string>> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
      { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(new Set(err ? [] : stdout.split('\0').filter(Boolean))),
    );
  });
}

/**
 * 异步广度优先遍历 cwd 下全部文件：同层目录并发读取，Dirent 自带类型（不逐个 lstat）；
 * 跳过依赖目录、版本库目录与符号链接（避免环）。不设数量 / 深度上限。
 */
async function walkDisk(root: string): Promise<{ files: string[]; dirs: string[] }> {
  const files: string[] = [];
  const dirs: string[] = [];
  const CONCURRENCY = 32;
  let level: string[] = [''];
  while (level.length) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += CONCURRENCY) {
      await Promise.all(
        level.slice(i, i + CONCURRENCY).map(async (relDir) => {
          let entries: fs.Dirent[];
          try {
            entries = await fs.promises.readdir(path.join(root, relDir), { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            const rel = relDir ? `${relDir}/${e.name}` : e.name;
            if (e.isDirectory()) {
              if (skipDir(e.name)) continue;
              dirs.push(rel);
              next.push(rel);
            } else if (e.isFile() && !JUNK_FILES.has(e.name)) {
              files.push(rel);
            }
          }
        }),
      );
    }
    level = next;
  }
  return { files, dirs };
}

/** 把相对路径（posix）列表组装成树；目录在前、同类按名称排序；被忽略的目录其子孙也标记忽略 */
function buildTree(
  files: readonly string[],
  dirs: readonly string[],
  ignored: ReadonlySet<string>,
): WorkspaceTreeNode[] {
  const roots: WorkspaceTreeNode[] = [];
  const dirIndex = new Map<string, { children: WorkspaceTreeNode[]; ignored: boolean }>([
    ['', { children: roots, ignored: false }],
  ]);
  const ensureDir = (rel: string): { children: WorkspaceTreeNode[]; ignored: boolean } => {
    const hit = dirIndex.get(rel);
    if (hit) return hit;
    const cut = rel.lastIndexOf('/');
    const parent = ensureDir(cut < 0 ? '' : rel.slice(0, cut));
    const isIgnored = parent.ignored || ignored.has(`${rel}/`) || ignored.has(rel);
    const children: WorkspaceTreeNode[] = [];
    parent.children.push({
      kind: 'dir',
      name: rel.slice(cut + 1),
      path: rel,
      ...(isIgnored ? { ignored: true } : {}),
      children,
    });
    const entry = { children, ignored: isIgnored };
    dirIndex.set(rel, entry);
    return entry;
  };
  for (const d of dirs) ensureDir(d);
  for (const f of files) {
    const cut = f.lastIndexOf('/');
    const parent = ensureDir(cut < 0 ? '' : f.slice(0, cut));
    parent.children.push({
      kind: 'file',
      name: f.slice(cut + 1),
      path: f,
      ...(parent.ignored || ignored.has(f) ? { ignored: true } : {}),
    });
  }
  const sort = (nodes: WorkspaceTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.children) sort(n.children);
  };
  sort(roots);
  return roots;
}

/**
 * 列出 cwd 下的全部文件（不截断），供右栏「工作区」展示，变更标注由渲染端叠加。
 * 只跳过依赖目录；被 .gitignore 忽略的文件照样列出并打 ignored 标记。
 */
export async function listWorkspaceTree(cwd: string): Promise<WorkspaceTreeResult> {
  const root = path.resolve(String(cwd ?? ''));
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, error: 'invalid cwd', code: 'invalid' };
  }
  try {
    const [disk, ignored] = await Promise.all([walkDisk(root), listGitIgnored(root)]);
    return { ok: true, entries: buildTree(disk.files, disk.dirs, ignored) };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      code: 'io',
    };
  }
}
