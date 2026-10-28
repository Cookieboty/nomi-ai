import { useEffect } from 'react';
import type { FC } from 'react';

import { avatarEvents } from '../avatar/events';

import { handleMascotCommand } from './commands';

import { lipSyncStore } from '@/ai/lipSyncStore';
import { api, hasTransport } from '@/services/api';

/**
 * 与 AI 无关的宿主事件 → avatar-runtime 的语义事件（`avatarEvents`）：
 * TTS 音量包络（口型）；主进程推来的全局光标与窗口物理事件；主进程 / 工具栏的看板娘指令
 * （动作、表情、打开面板、说一句、朗读回复）。口型与姿态怎么动由运行时决定。
 */
const MascotDriver: FC = () => {
  useEffect(() => {
    const unLip = lipSyncStore.subscribe((level) => avatarEvents.emit({ type: 'speaking', level }));
    const onLocal = (e: Event) => {
      const name = (e as CustomEvent<{ name?: string }>).detail?.name ?? 'random';
      handleMascotCommand({ type: 'motion', name });
    };
    window.addEventListener('mascot:motion', onLocal);
    const live = hasTransport();
    const offIpc = live ? api.on('mascot.command', (cmd) => handleMascotCommand(cmd)) : undefined;
    const offCursor = live
      ? api.on('mascot.cursor', (p) =>
          avatarEvents.emit({ type: 'cursor', x: p.x, y: p.y, inside: p.inside }),
        )
      : undefined;
    const offPhysics = live
      ? api.on('mascot.physicsEvent', (e) =>
          avatarEvents.emit({
            type: 'physics',
            kind: e.type,
            speed: 'speed' in e && typeof e.speed === 'number' ? e.speed : 0,
          }),
        )
      : undefined;
    return () => {
      unLip();
      window.removeEventListener('mascot:motion', onLocal);
      offIpc?.();
      offCursor?.();
      offPhysics?.();
    };
  }, []);
  return null;
};

export default MascotDriver;
