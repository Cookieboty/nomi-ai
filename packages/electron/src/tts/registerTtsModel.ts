/**
 * TTS 模型按需下载：IPC 注册 + 与 ConfigService / 工具栏开关的接线。
 * IPC：ai:tts-model:status | download | cancel | delete | set-voice-enabled；推送 ai:tts-model:changed。
 * 语音开关变化另推 voice-settings:changed（看板娘 / 主界面同步 UI）。
 */
import type { VoiceSettings } from '@nomi-ai/types';
import { BrowserWindow } from 'electron';

import { eventBus } from '../core/EventBus';
import { guardedHandle } from '../security/guardedIpc';
import type { IConfigService } from '../services/ConfigService';

import { getFishTtsService } from './fish/FishTtsService';
import { getSherpaTtsService } from './sherpa';
import { TtsModelController } from './TtsModelController';

/** VoiceIpcHandler 在 save-voice-settings 改变 enabled 时发出 */
export const VOICE_ENABLED_EVENT = 'voice:enabled-changed';

function sendAll(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

export function registerTtsModel(config: IConfigService): TtsModelController {
  const sherpa = getSherpaTtsService();
  const setVoiceEnabled = (enabled: boolean): void => {
    const cur = config.get<VoiceSettings | undefined>('voiceSettings');
    if (cur?.enabled === enabled) return;
    config.set('voiceSettings', { ...(cur ?? {}), enabled });
    config.save().catch(() => undefined);
    sendAll('voice-settings:changed', { ...(cur ?? {}), enabled });
  };
  const ctl = new TtsModelController({
    sherpa,
    getVoiceEnabled: () => Boolean(config.get<VoiceSettings | undefined>('voiceSettings')?.enabled),
    setVoiceEnabled,
    enableEngine: () => {
      try {
        const fish = getFishTtsService();
        const cfg = fish.getConfig();
        if (!cfg.enabled) fish.saveConfig({ ...cfg, enabled: true });
      } catch {
        /* 引擎配置读写失败不影响开关本身 */
      }
    },
    usesSherpa: () => {
      try {
        return getFishTtsService().getConfig().provider === 'sherpa-theresa';
      } catch {
        return true;
      }
    },
    ttsDisabled: () => process.env.CD_TTS === 'off',
    broadcast: (s) => sendAll('ai:tts-model:changed', s),
    log: (msg, extra) => console.warn(`[tts-model] ${msg}`, extra ?? ''),
  });

  const opts = { owner: 'TtsModelController', wrapErrors: false };
  guardedHandle('ai:tts-model:status', () => ctl.state(), opts);
  guardedHandle('ai:tts-model:download', () => ctl.download(), opts);
  guardedHandle('ai:tts-model:cancel', () => ctl.cancel(), opts);
  guardedHandle('ai:tts-model:delete', () => ctl.deleteModel(), opts);
  guardedHandle(
    'ai:tts-model:set-voice-enabled',
    (enabled) => {
      if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
      return ctl.setVoiceEnabled(enabled);
    },
    opts,
  );

  // 工具栏开关：已持久化，这里负责下载 / 失败回滚
  eventBus.on(VOICE_ENABLED_EVENT, (data: { enabled: boolean }) => {
    void ctl.setVoiceEnabled(Boolean(data?.enabled), true);
  });
  return ctl;
}
