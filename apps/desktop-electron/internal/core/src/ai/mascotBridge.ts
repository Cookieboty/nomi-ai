import { definePlugin, type PluginContext } from '@nomi-ai/bundle-ig-base';
import {
  AvatarKey,
  AvatarSeamPlugin,
  CompanionAgentPresetPlugin,
  CompanionToolsPlugin,
  type AvatarHost,
} from '@nomi-ai/bundle-ig-mascot/plugins';

import type { AppEvents } from '../core/appEvents';

import { publishAvatarCue, type AvatarCue } from './mascotCommand';

/**
 * ctx.avatar 的主进程 host：把 AI 侧的语义事件（情绪 / 手势 / 活动）经契约事件 `avatar.event`
 * 发给角色窗口，角色包的 mapping.json 决定实际表现（§10.5）。
 */
export function createIpcMascotHost(send: (cue: AvatarCue) => unknown): AvatarHost {
  return {
    async emotion(name, weight) {
      send(weight === undefined ? { type: 'emotion', name } : { type: 'emotion', name, weight });
    },
    async gesture(name) {
      send({ type: 'gesture', name });
    },
    async activity(name) {
      send({ type: 'activity', name });
    },
    speaking() {
      /* 口型由角色窗口本地的 TTS 包络驱动 */
    },
  };
}

function mascotIpcHostPlugin(events: AppEvents) {
  return definePlugin<Record<string, never>>({
    name: 'MascotIpcHostPlugin',
    requires: ['AvatarSeamPlugin'],
    apply(ctx: PluginContext) {
      const svc = ctx.inject(AvatarKey);
      if (!svc) {
        ctx.logger.warn('[MascotIpcHostPlugin] ctx.avatar not available');
        return;
      }
      svc.attachHost(createIpcMascotHost((cue) => publishAvatarCue(events, cue)));
    },
  });
}

/**
 * 追加到 AI 插件清单末尾：ctx.avatar（语义事件）、avatar_gesture / avatar_emotion 工具、
 * companion preset（角色身份来自 PersonaIdentityKey，见 persona/igPlugin.ts），并接到角色窗口。
 * 语义事件经这个内核实例的应用事件总线发出（一个进程可以有多个内核，不用模块级出口）。
 */
export function createMascotIgPlugins(events: AppEvents) {
  return [
    { plugin: AvatarSeamPlugin, config: {} },
    { plugin: CompanionToolsPlugin, config: { autoConfirm: true } },
    { plugin: CompanionAgentPresetPlugin, config: {} },
    { plugin: mascotIpcHostPlugin(events), config: {} },
  ];
}
export { COMPANION_PRESET } from '@nomi-ai/bundle-ig-mascot/plugins';
