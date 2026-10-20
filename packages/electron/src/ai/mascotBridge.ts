import { definePlugin, type PluginContext } from '@nomi-ai/bundle-ig-base';
import {
  Live2dKey,
  Live2dSeamPlugin,
  WaifuToolsPlugin,
  type Live2dHost,
} from '@nomi-ai/bundle-ig-mascot/plugins';

import { broadcastMascotCommand } from './mascotCommand';

/** ctx.live2d 的主进程 host：把 AI 工具调用（播放动作 / 切换表情）转发给渲染进程。 */
export function createIpcMascotHost(send = broadcastMascotCommand): Live2dHost {
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
    setParameter(id: string, value: number) {
      send({ type: 'parameter', id, value });
    },
    on() {
      return () => undefined;
    },
  };
}

const MascotIpcHostPlugin = definePlugin<Record<string, never>>({
  name: 'MascotIpcHostPlugin',
  requires: ['Live2dSeamPlugin'],
  apply(ctx: PluginContext) {
    const svc = ctx.inject(Live2dKey);
    if (!svc) {
      ctx.logger.warn('[MascotIpcHostPlugin] ctx.live2d not available');
      return;
    }
    svc.attachHost(createIpcMascotHost());
  },
});

/** 追加到 AI 插件清单末尾：注册 live2d_play_motion / live2d_set_expression 工具并接到渲染进程。 */
export const mascotIgPlugins = [
  { plugin: Live2dSeamPlugin, config: {} },
  { plugin: WaifuToolsPlugin, config: { autoConfirm: true } },
  { plugin: MascotIpcHostPlugin, config: {} },
];
