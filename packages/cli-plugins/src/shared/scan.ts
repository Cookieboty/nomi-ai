/**
 * 历史会话文件扫描的共用部分：只读目录与 stat，不读文件内容。只给插件的 main 入口用。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { HistoryFileRef } from '@nomi-ai/cli-sdk';

export async function readdir(d: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(d, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 给候选路径补上 mtime / size；stat 不了的（刚被删）跳过。每批 128 个，避免一次开太多文件句柄 */
export async function statAll(
  files: Array<{ path: string; dirId?: string }>,
): Promise<HistoryFileRef[]> {
  const out: HistoryFileRef[] = [];
  for (let i = 0; i < files.length; i += 128) {
    const res = await Promise.all(
      files.slice(i, i + 128).map(async (f) => {
        try {
          const st = await fs.promises.stat(f.path);
          return {
            path: f.path,
            mtime: st.mtimeMs,
            size: st.size,
            ...(f.dirId ? { dirId: f.dirId } : {}),
          };
        } catch {
          return null;
        }
      }),
    );
    for (const r of res) if (r) out.push(r);
  }
  return out;
}

/** 递归找文件：depth 层子目录以内，文件名满足 match；dirId 取文件所在目录名（需要时） */
export async function walkFiles(
  root: string,
  depth: number,
  match: (name: string) => boolean,
  o: { dirId?: boolean } = {},
): Promise<Array<{ path: string; dirId?: string }>> {
  const files: Array<{ path: string; dirId?: string }> = [];
  const walk = async (d: string, left: number): Promise<void> => {
    if (left < 0) return;
    for (const e of await readdir(d)) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, left - 1);
      else if (e.isFile() && match(e.name))
        files.push(o.dirId ? { path: p, dirId: path.basename(path.dirname(p)) } : { path: p });
    }
  };
  await walk(root, depth);
  return files;
}

/** 把一次性算好的列表变成 scan() 需要的 AsyncIterable */
export async function* yieldAll(list: Promise<HistoryFileRef[]>): AsyncIterable<HistoryFileRef> {
  for (const f of await list) yield f;
}
