import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { AvatarStage } from './AvatarStage';
import type { AvatarRuntimeOptions } from './host';

export interface AvatarHandle {
  /** 换角色 / 事件源 / 回调（整体替换选项） */
  update(options: AvatarRuntimeOptions): void;
  /** 卸载并释放全部资源；之后可以在同一个元素上重新 mount */
  dispose(): void;
}

/**
 * 不用 React 的宿主：把运行时挂到一个元素上（元素需要有尺寸，角色画在其中）。
 */
export function mountAvatar(element: HTMLElement, options: AvatarRuntimeOptions): AvatarHandle {
  const root = createRoot(element);
  root.render(createElement(AvatarStage, options));
  let disposed = false;
  return {
    update(next) {
      if (!disposed) root.render(createElement(AvatarStage, next));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.unmount();
    },
  };
}
