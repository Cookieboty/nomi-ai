import { createLogger } from '@nomi-ai/ui';
import { useEffect } from 'react';

import { directiveForEvent } from '@/mascot/expressionDirector';
import { applyDirective } from '@/mascot/mood';
import { hasTransport, hostDropFile } from '@/services/api';

const log = createLogger('FileDrop');

/**
 * 把文件拖到看板娘身上 → 主进程临时授权该文件（只读、仅本次运行）并总结，结果显示在气泡与对话窗口。
 * 拖到弹窗（如「导入 VRM」）里的不处理。路径的解析与提交都在 preload 里（`hostDropFile` →
 * `window.nomiHost.dropFile`），视图只交出 File，选不了路径。
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
      const sent = hostDropFile(file);
      document.documentElement.dataset.mascotDrop = sent ? file.name : 'no-path';
      if (!sent) {
        log.debug('拖入的文件没有本机路径，忽略');
        return;
      }
      applyDirective(directiveForEvent({ kind: 'file:drop' }));
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
