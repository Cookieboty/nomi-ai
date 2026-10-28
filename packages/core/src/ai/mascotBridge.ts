import { definePlugin, type PluginContext } from '@nomi-ai/bundle-ig-base';
import {
  AvatarKey,
  AvatarSeamPlugin,
  WaifuToolsPlugin,
  type AvatarHost,
} from '@nomi-ai/bundle-ig-mascot/plugins';

import { broadcastMascotCommand } from './mascotCommand';

/** ctx.avatar 的主进程 host：把 AI 工具调用（播放动作 / 切换表情）转发给渲染进程。 */
export function createIpcMascotHost(send = broadcastMascotCommand): AvatarHost {
  return {
    async playMotion(group: string) {
      send({ type: 'motion', name: group });
    },
    async setExpression(name: string) {
      send({ type: 'expression', name });
    },
    driveLipSync() {
      /* 口型由渲染进程本地 TTS 包络驱动 */
    },
    on() {
      return () => undefined;
    },
  };
}

const MascotIpcHostPlugin = definePlugin<Record<string, never>>({
  name: 'MascotIpcHostPlugin',
  requires: ['AvatarSeamPlugin'],
  apply(ctx: PluginContext) {
    const svc = ctx.inject(AvatarKey);
    if (!svc) {
      ctx.logger.warn('[MascotIpcHostPlugin] ctx.avatar not available');
      return;
    }
    svc.attachHost(createIpcMascotHost());
  },
});

/** 追加到 AI 插件清单末尾：注册 avatar_gesture / avatar_emotion 工具并接到渲染进程。 */
export const mascotIgPlugins = [
  { plugin: AvatarSeamPlugin, config: {} },
  { plugin: WaifuToolsPlugin, config: { autoConfirm: true } },
  { plugin: MascotIpcHostPlugin, config: {} },
];
