/**
 * `folder` 事件源（§6.2）：本机文件夹的新文件 / 改动。fs.watch 命中后尽快扫描，另有 5 分钟一次的扫描兜底；
 * 目录必须在任务授权的路径里。扫描最多 3 层、2000 个文件，跳过隐藏目录与 node_modules。
 * Go 版：apps/desktop-go/internal/core/tasks/events/folder.go。
 */
import fs from 'node:fs';
import path from 'node:path';

import { t } from '../../../i18n';
import type { EventSource, SourceEvent } from '../types';

export interface FolderFilter {
  path: string;
  recursive?: boolean;
}

const MAX_FILES = 2000;
const MAX_DEPTH = 3;

const inside = (root: string, p: string) => {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** 相对路径 → `mtimeMs:size` */
export function scanFolder(root: string, recursive: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  const walk = (dir: string, depth: number) => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (n >= MAX_FILES) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive && depth < MAX_DEPTH) walk(p, depth + 1);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(p);
          out[path.relative(root, p).split(path.sep).join('/')] =
            `${Math.floor(st.mtimeMs)}:${st.size}`;
          n++;
        } catch {
          /* 扫描途中被删 */
        }
      }
    }
  };
  walk(root, 1);
  return out;
}

export function createFolderSource(deps: { now?: () => number } = {}): EventSource {
  const now = deps.now ?? Date.now;
  return {
    id: 'folder',
    minIntervalMs: 5 * 60_000,
    validate(filter, task) {
      const f = filter as FolderFilter | null;
      if (!f || typeof f.path !== 'string' || !path.isAbsolute(f.path))
        return 'absolute path required';
      if (!task.grant.paths.some((g) => inside(g, f.path))) return `path not granted: ${f.path}`;
      try {
        if (!fs.statSync(f.path).isDirectory()) return 'not a directory';
      } catch {
        return 'not found';
      }
      return null;
    },
    async poll(filter, cursor) {
      const f = filter as FolderFilter;
      const prev = cursor ? (JSON.parse(cursor) as Record<string, string>) : null;
      const cur = scanFolder(f.path, f.recursive !== false);
      const events: SourceEvent[] = [];
      if (prev)
        for (const [rel, sig] of Object.entries(cur)) {
          if (prev[rel] === sig) continue;
          const isNew = prev[rel] === undefined;
          events.push({
            key: `folder:${rel}:${sig}`,
            occurredAt: Number(sig.split(':')[0]) || now(),
            summary: isNew
              ? t('electron.common.task-event-file-new', rel)
              : t('electron.common.task-event-file-changed', rel),
            payload: { folder: f.path, file: rel, change: isNew ? 'new' : 'modified' },
          });
        }
      return { events, cursor: JSON.stringify(cur), ...(prev ? {} : { baseline: true }) };
    },
    watch(filter, _task, changed) {
      const f = filter as FolderFilter;
      try {
        const w = fs.watch(f.path, { recursive: f.recursive !== false, persistent: false }, () =>
          changed(),
        );
        w.on('error', () => undefined);
        return () => w.close();
      } catch {
        return () => undefined;
      }
    },
  };
}
