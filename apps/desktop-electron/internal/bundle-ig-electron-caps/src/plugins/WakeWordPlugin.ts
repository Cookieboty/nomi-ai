import { definePlugin, type PluginContext } from '@nomi-ai/bundle-ig-base';

import { KeyStoreKey } from '../seams/keyStore';

export interface WakeWordConfig {
  enabled?: boolean;
  /** 内置关键词，如 'porcupine', 'jarvis', 'alexa'；或自定义 .ppn 路径 */
  keywords?: Array<string | { path: string; label: string }>;
  /** 灵敏度 0~1 */
  sensitivity?: number;
  /** 音频输入设备 id（未来注入） */
  inputDeviceId?: string;
}

/**
 * 唤醒词插件骨架：默认关闭。
 * P3-7 真实实现时：
 *   - 依赖 @picovoice/porcupine-node
 *   - accessKey 走 ctx.keyStore.get('porcupine')
 *   - 音频从 ctx.audioIn（P4 定义）拉 PCM
 *   - 命中时 ctx.emit('wakeword/detected', { label, ts })
 */
export const WakeWordPlugin = definePlugin<WakeWordConfig>({
  name: 'WakeWordPlugin',
  apply(ctx: PluginContext, cfg: WakeWordConfig) {
    const enabled = cfg.enabled ?? false;
    if (!enabled) {
      ctx.logger.info('WakeWordPlugin disabled');
      return;
    }

    const keyStore = ctx.inject(KeyStoreKey);
    if (!keyStore) {
      ctx.logger.warn('WakeWordPlugin: keyStore unavailable; wake word will not start');
      return;
    }

    ctx.logger.warn('WakeWordPlugin: real Porcupine binding not implemented (P3-7 TODO)');
    // TODO(P3-7):
    // const accessKey = await keyStore.get('porcupine');
    // const { Porcupine, BuiltinKeyword } = require('@picovoice/porcupine-node');
    // const engine = new Porcupine(accessKey, keywords, sensitivities);
    // audioIn.on('frame', (pcm) => {
    //   const idx = engine.process(pcm);
    //   if (idx >= 0) ctx.emit('wakeword/detected', { label: labels[idx], ts: Date.now() });
    // });
  },
});
