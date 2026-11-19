/**
 * 输入框 @ 路径补全的候选：面板打开时读一次各文件夹的目录树（cwd 在前；文件夹变了重读），
 * 并合并 workspaceList 会跳过的依赖 / 缓存目录节点。查询非空时再防抖请求这些目录内部的匹配项。
 * 工作目录里的插相对路径；项目其余文件夹里的插绝对路径，显示成「文件夹名/相对路径」。
 */
import { useEffect, useState } from 'react';

import { harnessClient } from '../services/harnessClient';

import {
  flattenWorkspacePaths,
  mentionPathsToOptions,
  mergeAtPathOptions,
  type AtPathOption,
} from './atPathComplete';

export const AT_PATH_MENTION_DEBOUNCE_MS = 150;
const MENTION_LIMIT = 50;

const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p;

function rootFolder(root: string, index: number): { root: string; name: string } | undefined {
  return index === 0 ? undefined : { root, name: baseName(root) };
}

function mentionOptions(root: string, query: string, folder?: { root: string; name: string }) {
  if (typeof harnessClient.workspaceMentionPaths !== 'function') {
    return Promise.resolve([] as AtPathOption[]);
  }
  return harnessClient
    .workspaceMentionPaths(root, query, MENTION_LIMIT)
    .then((res) => mentionPathsToOptions(res.ok && res.entries ? res.entries : [], folder))
    .catch(() => [] as AtPathOption[]);
}

export function useAtPathOptions(
  open: boolean,
  cwd: string | null | undefined,
  roots: readonly string[] | null | undefined,
  query = '',
): { options: AtPathOption[]; reload: () => void } {
  const [tree, setTree] = useState<AtPathOption[]>([]);
  const [skipTops, setSkipTops] = useState<AtPathOption[]>([]);
  const [mentionHits, setMentionHits] = useState<AtPathOption[]>([]);
  const [loaded, setLoaded] = useState<string | null>(null);
  const key = cwd ? [cwd, ...(roots ?? []).filter((r) => r !== cwd)].join('\0') : null;
  const q = query.trim();

  useEffect(() => {
    if (!open || !key || loaded === key) return;
    let live = true;
    void Promise.all(
      key.split('\0').map((r, i) => {
        const folder = rootFolder(r, i);
        return Promise.all([
          harnessClient
            .workspaceList(r)
            .then((res) => flattenWorkspacePaths(res.ok && res.entries ? res.entries : [], folder))
            .catch(() => [] as AtPathOption[]),
          mentionOptions(r, '', folder),
        ]);
      }),
    ).then((parts) => {
      if (!live) return;
      setTree(parts.flatMap((p) => p[0]));
      setSkipTops(parts.flatMap((p) => p[1]));
      setMentionHits([]);
      setLoaded(key);
    });
    return () => {
      live = false;
    };
  }, [open, key, loaded]);

  useEffect(() => {
    if (!open || !key || loaded !== key) return;
    if (!q) {
      setMentionHits([]);
      return;
    }
    setMentionHits([]);
    let live = true;
    const t = window.setTimeout(() => {
      void Promise.all(key.split('\0').map((r, i) => mentionOptions(r, q, rootFolder(r, i)))).then(
        (parts) => {
          if (!live) return;
          setMentionHits(parts.flat());
        },
      );
    }, AT_PATH_MENTION_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [open, key, loaded, q]);

  const options =
    key && loaded === key
      ? mergeAtPathOptions([tree, skipTops, mentionHits], query, MENTION_LIMIT)
      : [];

  return { options, reload: () => setLoaded(null) };
}
