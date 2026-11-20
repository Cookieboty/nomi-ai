import type { PreviewEntry } from '../components/ResourcePreview/ResourcePreview';
import { formatAtPathInsert } from '../slash/atPathComplete';

import { basename, resourceTarget, resolveDocumentPath } from './resourceLinks';
import { workspaceKey } from './workspacePath';

export const FILE_PATH_DRAG_MIME = 'application/x-nomi-file-path';
export const CHAT_DROP_FILE_PATH_EVENT = 'nomi:chat-drop-file-path';

export interface FilePathDragPayload {
  path: string;
  kind: 'file' | 'dir';
}

let activeDrag: FilePathDragPayload | null = null;
let dragEndListener: (() => void) | null = null;

export function isAbsoluteFsPath(p: string): boolean {
  return /^(?:\/|~[\\/]|[A-Za-z]:[\\/])/.test(p);
}

function normalizeFsPath(p: string): string {
  const norm = p.replace(/\\/g, '/');
  if (norm === '/' || /^[A-Za-z]:\/$/.test(norm)) return norm;
  return norm.replace(/\/+$/, '');
}

export function resolveDragPath(rawPath: string, baseCwd?: string | null): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  if (/^(?:https?:|chat-asset:|data:|blob:)/i.test(trimmed)) return null;

  let path = trimmed;
  if (/^file:\/\//i.test(trimmed)) {
    const target = resourceTarget(trimmed);
    if (!target?.path) return null;
    path = target.path;
  }

  if (!isAbsoluteFsPath(path)) {
    if (!baseCwd || !baseCwd.trim()) return null;
    path = resolveDocumentPath(baseCwd, path);
  }

  const normalized = normalizeFsPath(path);
  return normalized || null;
}

export function previewEntryFilePath(
  entry: PreviewEntry | undefined,
  resolvedPath?: string,
): string | null {
  if (!entry) return null;
  if (entry.diff) {
    return resolveDragPath(entry.diff.path, entry.diff.cwd ?? entry.scope.cwd);
  }
  if (resolvedPath) {
    const fromResolved = resolveDragPath(resolvedPath, entry.scope.cwd);
    if (fromResolved) return fromResolved;
  }
  const target = resourceTarget(entry.href);
  if (!target || target.web || !target.path) return null;
  return resolveDragPath(target.path, entry.scope.cwd);
}

function detachDragEndListener(): void {
  if (dragEndListener && typeof window !== 'undefined') {
    window.removeEventListener('dragend', dragEndListener);
  }
  dragEndListener = null;
}

export function clearFilePathDrag(): void {
  activeDrag = null;
  detachDragEndListener();
}

export function startFilePathDrag(
  dt: DataTransfer | null | undefined,
  payload: FilePathDragPayload,
  opts?: { effectAllowed?: DataTransfer['effectAllowed']; preserveEffectAllowed?: boolean },
): boolean {
  const path = normalizeFsPath(payload.path.trim());
  if (!path) return false;
  const normalized: FilePathDragPayload = {
    path,
    kind: payload.kind === 'dir' ? 'dir' : 'file',
  };

  if (dt) {
    try {
      dt.setData(FILE_PATH_DRAG_MIME, JSON.stringify(normalized));
    } catch {
      /* ignore DataTransfer errors in constrained webviews */
    }
    try {
      dt.setData('text/plain', normalized.path);
    } catch {
      /* ignore DataTransfer errors in constrained webviews */
    }
    if (!opts?.preserveEffectAllowed) {
      try {
        dt.effectAllowed = opts?.effectAllowed ?? 'copy';
      } catch {
        /* ignore readonly effectAllowed */
      }
    }
  }

  detachDragEndListener();
  activeDrag = normalized;
  if (typeof window !== 'undefined') {
    dragEndListener = () => clearFilePathDrag();
    window.addEventListener('dragend', dragEndListener, { once: true });
  }
  return true;
}

function dataTransferTypes(dt: DataTransfer | null | undefined): string[] {
  if (!dt?.types) return [];
  return Array.from(dt.types);
}

export function hasFilePathDrag(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  const types = dataTransferTypes(dt);
  if (types.includes(FILE_PATH_DRAG_MIME)) return true;
  if (activeDrag !== null && !types.includes('Files')) return true;
  return false;
}

function parseDragPayload(raw: string): FilePathDragPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.path !== 'string') return null;
    const path = normalizeFsPath(rec.path.trim());
    if (!path) return null;
    const kind = rec.kind === 'dir' ? 'dir' : rec.kind === 'file' ? 'file' : null;
    if (!kind) return null;
    return { path, kind };
  } catch {
    return null;
  }
}

export function readFilePathDrag(dt: DataTransfer | null | undefined): FilePathDragPayload | null {
  if (!dt) return null;
  const types = dataTransferTypes(dt);
  try {
    const raw = dt.getData(FILE_PATH_DRAG_MIME);
    const parsed = parseDragPayload(raw);
    if (parsed) return parsed;
  } catch {
    /* fallback to in-memory activeDrag */
  }
  if (activeDrag !== null && !types.includes('Files')) return activeDrag;
  return null;
}

export function formatDroppedFilePath(payload: FilePathDragPayload, cwd?: string | null): string {
  const normPath = normalizeFsPath(payload.path.trim());
  if (!normPath) return '';

  if (cwd && cwd.trim()) {
    const normCwd = normalizeFsPath(cwd.trim());
    const pathKey = workspaceKey(normPath);
    const cwdKey = workspaceKey(normCwd);
    const prefix = cwdKey === '/' ? '/' : `${cwdKey}/`;
    if (pathKey.startsWith(prefix) && pathKey.length > prefix.length) {
      const rel = normPath.slice(normCwd === '/' ? 1 : normCwd.length + 1);
      if (rel) {
        return formatAtPathInsert({ path: rel, kind: payload.kind, label: basename(rel) });
      }
    }
  }

  return formatAtPathInsert({
    path: normPath,
    kind: payload.kind,
    label: basename(normPath),
  });
}

export function insertPathToken(
  text: string,
  token: string,
  selectionStart: number,
  selectionEnd: number,
): { text: string; caret: number } {
  const len = text.length;
  const rawStart = Math.max(0, Math.min(selectionStart, len));
  const rawEnd = Math.max(0, Math.min(selectionEnd, len));
  const start = Math.min(rawStart, rawEnd);
  const end = Math.max(rawStart, rawEnd);

  const before = text.slice(0, start);
  const after = text.slice(end);
  const leading = before.length > 0 && !/[\s([{'"`]$/.test(before) ? ' ' : '';
  const trailing = after.length === 0 || !/^\s/.test(after) ? ' ' : '';
  const inserted = `${leading}${token}${trailing}`;

  return {
    text: before + inserted + after,
    caret: start + inserted.length,
  };
}

export function dispatchChatDropFilePath(payload: FilePathDragPayload): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<FilePathDragPayload>(CHAT_DROP_FILE_PATH_EVENT, { detail: payload }),
  );
}
