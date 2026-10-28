import { createLogger } from '@nomi-ai/ui';
import { useEffect } from 'react';

import { directiveForEvent } from '@/mascot/expressionDirector';
import { applyDirective } from '@/mascot/mood';
import { api, hasTransport, hostPathForFile } from '@/services/api';

const log = createLogger('FileDrop');

/**
 * 把文件拖到看板娘身上 → 主进程临时授权该文件（只读、仅本次运行）并总结，结果显示在气泡与对话窗口。
 * 拖到弹窗（如「导入 VRM」）里的不处理。本机路径只能从真实拖入的 File 取（`hostPathForFile`），
 * 再经契约 `desktop.dropFile` 交给内核。
 */
export function useFileDropSummarize(elementId = 'mascot-canvas'): void {
  useEffect(() => {
    const el = document.getElementById(elementId);
    if (!hasTransport() || !el) return;
    const isFiles = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const over = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      document.documentElement.dataset.mascotDropHover = '1';
    };
    const leave = () => {
      document.documentElement.dataset.mascotDropHover = '0';
    };
    const drop = (e: DragEvent) => {
      leave();
      if (!isFiles(e) || (e.target as Element | null)?.closest('[role="dialog"]')) return;
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const path = hostPathForFile(file);
      document.documentElement.dataset.mascotDrop = path ? file.name : 'no-path';
      if (!path) return;
      applyDirective(directiveForEvent({ kind: 'file:drop' }));
      api.desktop.dropFile({ path }).catch((e: unknown) => log.warn('拖入文件失败', e));
    };
    el.addEventListener('dragover', over);
    el.addEventListener('dragleave', leave);
    el.addEventListener('drop', drop);
    return () => {
      el.removeEventListener('dragover', over);
      el.removeEventListener('dragleave', leave);
      el.removeEventListener('drop', drop);
    };
  }, [elementId]);
}
