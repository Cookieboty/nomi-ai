/**
 * 工作区文件轻量索引：供对话区的行内文件提及（如 `wails.go`、`packages/.../foo.tsx`）
 * 判断是否为当前工作区内的真实文件并解析出精确路径。
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import type { ResourceScope } from '../contexts/ResourceContext';
import { resourceTarget, workspaceFileHref } from '../utils/resourceLinks';

import { harnessClient, type WorkspaceTreeNode } from './harnessClient';

export interface WorkspaceRootFiles {
  root: string;
  exact: Set<string>;
  files: string[];
  byBase: Map<string, string[]>;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000;
const rootCache = new Map<string, WorkspaceRootFiles>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let snapshotVersion = 0;

function emit() {
  snapshotVersion += 1;
  listeners.forEach((fn) => fn());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return snapshotVersion;
}

function flattenFiles(nodes: readonly WorkspaceTreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    const rel = node.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (node.kind === 'file' && rel) out.push(rel);
    if (node.children?.length) flattenFiles(node.children, out);
  }
  return out;
}

function buildRootFiles(root: string, entries: readonly WorkspaceTreeNode[]): WorkspaceRootFiles {
  const files = flattenFiles(entries);
  const exact = new Set<string>(files);
  const byBase = new Map<string, string[]>();
  for (const rel of files) {
    const slash = rel.lastIndexOf('/');
    const base = slash >= 0 ? rel.slice(slash + 1) : rel;
    const bucket = byBase.get(base);
    if (bucket) bucket.push(rel);
    else byBase.set(base, [rel]);
  }
  return { root, exact, files, byBase, fetchedAt: Date.now() };
}

export function ensureWorkspaceRootIndexed(root: string): void {
  const key = root.trim();
  if (!key) return;
  const hit = rootCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return;
  if (inflight.has(key)) return;
  if (typeof harnessClient?.workspaceList !== 'function') return;
  const task = Promise.resolve()
    .then(() => harnessClient.workspaceList(key))
    .then((res) => {
      if (res?.ok && Array.isArray(res.entries)) {
        rootCache.set(key, buildRootFiles(key, res.entries));
        emit();
      }
    })
    .catch(() => undefined)
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, task);
}

/** 测试辅助：清空或预置工作区索引缓存 */
export function resetWorkspaceFileIndex(): void {
  rootCache.clear();
  inflight.clear();
  emit();
}

export function seedWorkspaceFileIndex(root: string, relativePaths: readonly string[]): void {
  const entries: WorkspaceTreeNode[] = relativePaths.map((p) => {
    const normalized = p.replace(/\\/g, '/').replace(/^\/+/, '');
    const slash = normalized.lastIndexOf('/');
    return {
      kind: 'file',
      name: slash >= 0 ? normalized.slice(slash + 1) : normalized,
      path: normalized,
    };
  });
  rootCache.set(root, buildRootFiles(root, entries));
  emit();
}

export function useWorkspaceFileIndex(
  scope: ResourceScope | null | undefined,
): WorkspaceRootFiles[] {
  const version = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const rootsKey = useMemo(() => {
    if (!scope) return '';
    const list = [scope.cwd, ...(scope.fallbackCwds ?? [])].filter(
      (x): x is string => typeof x === 'string' && x.trim().length > 0,
    );
    return Array.from(new Set(list)).join('\0');
  }, [scope]);

  useEffect(() => {
    if (!rootsKey) return;
    for (const root of rootsKey.split('\0')) {
      ensureWorkspaceRootIndexed(root);
    }
  }, [rootsKey]);

  return useMemo(() => {
    void version;
    if (!rootsKey) return [];
    const out: WorkspaceRootFiles[] = [];
    for (const root of rootsKey.split('\0')) {
      const hit = rootCache.get(root);
      if (hit) out.push(hit);
    }
    return out;
  }, [rootsKey, version]);
}

const KNOWN_FILE_EXTS = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'go',
  'py',
  'pyi',
  'rs',
  'java',
  'kt',
  'kts',
  'swift',
  'c',
  'cc',
  'cpp',
  'cxx',
  'h',
  'hh',
  'hpp',
  'cs',
  'rb',
  'php',
  'lua',
  'zig',
  'dart',
  'scala',
  'ex',
  'exs',
  'erl',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'cmd',
  'sql',
  'graphql',
  'gql',
  'proto',
  'vue',
  'svelte',
  'astro',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'md',
  'markdown',
  'mdx',
  'txt',
  'rst',
  'json',
  'jsonc',
  'json5',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'xml',
  'plist',
  'csv',
  'tsv',
  'svg',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'ico',
  'bmp',
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'mod',
  'sum',
  'work',
  'lock',
  'gradle',
  'cmake',
  'mk',
  'dockerfile',
]);

/** 不依赖目录扫描即可断定不是 JS/Go 属性访问的特征文件名 */
const UNAMBIGUOUS_BASENAME =
  /^(?:package\.json|tsconfig(?:\.[\w-]+)?\.json|go\.(?:mod|sum|work)|Cargo\.(?:toml|lock)|Makefile|Dockerfile|[\w.-]+\.(?:test|spec)\.[jt]sx?|[\w.-]+_test\.go|[\w.-]+\.module\.(?:css|scss|less)|[\w.-]+\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s)$/i;

function appendLocation(href: string, line?: number, lineEnd?: number, fragment?: string): string {
  if (line !== undefined) {
    return `${href}#L${line}${lineEnd !== undefined ? `-L${lineEnd}` : ''}`;
  }
  if (fragment !== undefined) {
    return `${href}#${encodeURIComponent(fragment)}`;
  }
  return href;
}

export interface ResolvedConversationFile {
  href: string;
  scope: ResourceScope;
}

/**
 * 识别对话行内代码中的文件路径 / 文件名：
 * - 拒绝代码表达式、函数调用、命令参数与 URL；
 * - 命中工作区索引时直接解析到对应根目录与完整路径；
 * - 未索引但具备明确路径前缀/分隔符/行号定位或特征文件名时，交给预览器按作用域打开。
 */
export function resolveConversationFile(
  raw: string,
  scope: ResourceScope,
  roots: readonly WorkspaceRootFiles[],
): ResolvedConversationFile | null {
  const text = raw.trim();
  if (!text || text.length > 512 || /[\r\n\t]/.test(text)) return null;
  if (text.startsWith('-') || text.startsWith('<') || /[;()`'"${}|&!=?*<>]/.test(text)) {
    return null;
  }

  const isExplicitPrefix = /^(?:\/|~[\\/]|\.{1,3}[\\/]|…[\\/]|file:\/\/|[A-Za-z]:[\\/])/i.test(
    text,
  );
  // 含空格的文本若既不是显式路径前缀，又不在工作区索引里，视为普通命令行（如 `go vet`）
  if (/\s/.test(text) && !isExplicitPrefix) {
    const matchedSpaceFile = roots.some((r) => r.exact.has(text.replace(/\\/g, '/')));
    if (!matchedSpaceFile) return null;
  }

  const target = resourceTarget(text);
  if (!target || target.web || !target.path) return null;

  const cleanPath = target.path.replace(/\\/g, '/');
  const extMatch = /\.([A-Za-z][A-Za-z\d]{0,11})$/.exec(cleanPath);
  const ext = extMatch?.[1]?.toLowerCase();
  if (!ext) return null;

  // 1. 优先在已加载的工作区文件树中精确匹配 / 唯一匹配
  if (!/^(?:\/|~\/|[A-Za-z]:\/)/.test(cleanPath)) {
    const rel = cleanPath.replace(/^(?:\.\/|\.\.\.\/|…\/)+/, '').replace(/^\/+/, '');
    if (rel && !rel.includes('..')) {
      for (const entry of roots) {
        if (entry.exact.has(rel)) {
          return {
            href: appendLocation(
              workspaceFileHref(entry.root, rel),
              target.line,
              target.lineEnd,
              target.fragment,
            ),
            scope: { ...scope, cwd: entry.root },
          };
        }
      }
      if (rel.includes('/')) {
        const suffix = `/${rel}`;
        const hits: Array<{ root: string; file: string }> = [];
        for (const entry of roots) {
          for (const f of entry.files) {
            if (f.endsWith(suffix)) hits.push({ root: entry.root, file: f });
          }
        }
        if (hits.length === 1) {
          const hit = hits[0]!;
          return {
            href: appendLocation(
              workspaceFileHref(hit.root, hit.file),
              target.line,
              target.lineEnd,
              target.fragment,
            ),
            scope: { ...scope, cwd: hit.root },
          };
        }
      } else {
        const hits: Array<{ root: string; file: string }> = [];
        for (const entry of roots) {
          const list = entry.byBase.get(rel);
          if (list) {
            for (const f of list) hits.push({ root: entry.root, file: f });
          }
        }
        if (hits.length === 1) {
          const hit = hits[0]!;
          return {
            href: appendLocation(
              workspaceFileHref(hit.root, hit.file),
              target.line,
              target.lineEnd,
              target.fragment,
            ),
            scope: { ...scope, cwd: hit.root },
          };
        }
      }
    }
  }

  // 2. 显式本机绝对路径 / file:// / ~/ / ./ / ../
  if (isExplicitPrefix && KNOWN_FILE_EXTS.has(ext)) {
    return { href: text, scope };
  }

  // 以下相对路径均需要会话具备工作区目录
  if (!scope.cwd) return null;

  // 3. 含目录分隔符的相对路径（如 `packages/ai-chat/src/App.tsx`、`src/demo.go#L7-L9`）
  if (cleanPath.includes('/') && KNOWN_FILE_EXTS.has(ext)) {
    // 排除类似 github.com/org/repo.git 或网址片段
    if (/^[a-z\d-]+\.(?:com|org|net|io|dev|ai)\//i.test(cleanPath)) return null;
    return { href: text, scope };
  }

  // 4. 裸文件名：需带明确行号定位（如 `wails.go:111`）或属于无歧义特征文件名（如 `browserTab.test.tsx`）
  if (
    KNOWN_FILE_EXTS.has(ext) &&
    (target.line !== undefined || UNAMBIGUOUS_BASENAME.test(cleanPath))
  ) {
    return { href: text, scope };
  }

  return null;
}
