import { createLogger, Icon } from '@nomi-ai/ui';
import { UserRound } from 'lucide-react';
import React from 'react';

const log = createLogger('canvas-boundary');

/**
 * 3D 画布错误边界：WebGL 不可用（驱动 / 虚拟显示）时只让角色区域降级，
 * 气泡、工具栏、桌面工具确认框等其余界面仍然可用。
 */
export class CanvasBoundary extends React.Component<
  {
    children: React.ReactNode;
    /** 变化时清除失败状态并重新挂载子树（例如换了模型）；不传则保持「失败后一直降级」 */
    resetKey?: string;
  },
  { failed: boolean; failedKey?: string }
> {
  state: { failed: boolean; failedKey?: string } = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { failed: boolean; failedKey?: string },
  ): { failed: boolean; failedKey?: string } | null {
    // 失败时记录当时的 key；key 一变（用户换了模型 / 重试）就复位
    if (state.failed && state.failedKey === undefined)
      return { ...state, failedKey: props.resetKey ?? '' };
    if (state.failed && state.failedKey !== (props.resetKey ?? ''))
      return { failed: false, failedKey: undefined };
    return null;
  }

  componentDidCatch(error: unknown): void {
    log.error('3D 渲染失败，已降级', error);
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <div
          data-testid="mascot-canvas-fallback"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            color: 'var(--cd-color-text-subtle, #94a3b8)',
          }}
        >
          <Icon icon={UserRound} size={56} />
        </div>
      );
    }
    return this.props.children;
  }
}
