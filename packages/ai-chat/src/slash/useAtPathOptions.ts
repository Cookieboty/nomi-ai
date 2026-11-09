/**
 * 输入框 @ 路径补全的候选：面板打开时读一次各文件夹的目录树（cwd 在前；文件夹变了重读）。
 * 工作目录里的插相对路径；项目其余文件夹里的插绝对路径，显示成「文件夹名/相对路径」。
 */
import { useEffect, useState } from 'react';

import { harnessClient } from '../services/harnessClient';

import { flattenWorkspacePaths, type AtPathOption } from './atPathComplete';

const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p;

export function useAtPathOptions(
  open: boolean,
  cwd: string | null | undefined,
  roots: readonly string[] | null | undefined,
): { options: AtPathOption[]; reload: () => void } {
  const [nodes, setNodes] = useState<AtPathOption[]>([]);
  const [loaded, setLoaded] = useState<string | null>(null);
  const key = cwd ? [cwd, ...(roots ?? []).filter((r) => r !== cwd)].join('\0') : null;

  useEffect(() => {
    if (!open || !key || loaded === key) return;
    let live = true;
    void Promise.all(
      key.split('\0').map((r, i) =>
        harnessClient
          .workspaceList(r)
          .then((res) =>
            flattenWorkspacePaths(
              res.ok && res.entries ? res.entries : [],
              i === 0 ? undefined : { root: r, name: baseName(r) },
            ),
          )
          .catch(() => [] as AtPathOption[]),
      ),
    ).then((parts) => {
      if (!live) return;
      setNodes(parts.flat());
      setLoaded(key);
    });
    return () => {
      live = false;
    };
  }, [open, key, loaded]);

  return { options: key && loaded === key ? nodes : [], reload: () => setLoaded(null) };
}
