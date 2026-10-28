import { useEffect } from 'react';
import type { FC } from 'react';

import { handleMascotCommand } from './commands';
import { mascotRegistry } from './MascotBackend';

import { lipSyncStore } from '@/ai/lipSyncStore';
import { api, hasTransport } from '@/services/api';

/**
 * 与 AI 无关的驱动：TTS 音量包络 → 口型 + 说话姿态；
 * 主进程 / 工具栏的看板娘指令（动作、表情、打开角色选择）。
 */
const TALK_RMS = 0.04;
const TALK_RELEASE_MS = 1200;

const MascotDriver: FC = () => {
  useEffect(() => {
    let talking = false;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    const unLip = lipSyncStore.subscribe((rms) => {
      const backend = mascotRegistry.current();
      backend?.setMouthOpen(rms);
      if (rms > TALK_RMS) {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = null;
        if (!talking) {
          talking = true;
          backend?.setTalking(true);
        }
      } else if (talking && !silenceTimer) {
        silenceTimer = setTimeout(() => {
          talking = false;
          silenceTimer = null;
          mascotRegistry.current()?.setTalking(false);
        }, TALK_RELEASE_MS);
      }
    });
    const onLocal = (e: Event) => {
      const name = (e as CustomEvent<{ name?: string }>).detail?.name ?? 'random';
      handleMascotCommand({ type: 'motion', name });
    };
    window.addEventListener('mascot:motion', onLocal);
    const offIpc = hasTransport()
      ? api.on('mascot.command', (cmd) => handleMascotCommand(cmd))
      : undefined;
    return () => {
      unLip();
      if (silenceTimer) clearTimeout(silenceTimer);
      window.removeEventListener('mascot:motion', onLocal);
      offIpc?.();
    };
  }, []);
  return null;
};

export default MascotDriver;
