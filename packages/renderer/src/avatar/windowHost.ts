/**
 * avatar-runtime 的透明窗口宿主（`AvatarWindowHost`）：命中 / 拖拽 / 包围盒 / 窗口形状经契约
 * `mascot.*` 报给主进程，平台经 `window.platform`。
 *
 * 上报是即发即弃的（原来是单向消息）：失败不影响交互。拖拽上报串行、按帧合并 move
 * （每次都是契约往返，指针事件频率远高于刷新率，见 ./dragReporter.ts）。
 */
import type { AvatarWindowHost } from '@nomi-ai/avatar-runtime';

import { api } from '../services/api';

import { createDragReporter } from './dragReporter';

const fire = (p: Promise<unknown>): void => void p.catch(() => undefined);

export function createMascotWindowHost(): AvatarWindowHost {
  const drag = createDragReporter({
    dragStart: (p) => api.mascot.dragStart(p),
    dragMove: (p) => api.mascot.dragMove(p),
    dragEnd: () => api.mascot.dragEnd(),
  });
  return {
    platform: () => api.window.platform(),
    dragStart: (p) => drag.start(p),
    dragMove: (p) => drag.move(p),
    dragEnd: () => drag.end(),
    setHit: (hit) => fire(api.mascot.setHit({ hit })),
    setGeometry: (g) => fire(api.mascot.setGeometry(g)),
    setShape: (rects) => fire(api.mascot.setShape({ rects })),
  };
}
