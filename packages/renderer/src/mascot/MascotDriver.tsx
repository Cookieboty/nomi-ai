import { playMotionNow } from '@nomi-ai/avatar-runtime';
import { useEffect } from 'react';
import type { FC } from 'react';

import { avatarEvents } from '../avatar/events';

import { handleMascotCommand } from './commands';

import { lipSyncStore } from '@/ai/lipSyncStore';
import { api, hasTransport } from '@/services/api';

/**
 * 宿主事件 → avatar-runtime 的语义事件（`avatarEvents`）：TTS 音量包络（口型）；内核的语义事件
 * `avatar.event`（情绪 / 手势 / 活动 / 等回复，§10.5）；主进程推来的全局光标与窗口物理事件；
 * 主进程的看板娘指令（打开面板、说一句、朗读回复）。口型、表情与动作怎么做由运行时按角色包的
 * mapping.json 决定。
 *
 * 本窗口自己的动作菜单（`mascot:motion`）列的是当前后端的动作名，直接交给引擎播放，不经映射。
 */
const MascotDriver: FC = () => {
  useEffect(() => {
    const unLip = lipSyncStore.subscribe((level) => avatarEvents.emit({ type: 'speaking', level }));
    const onLocal = (e: Event) => {
      const name = (e as CustomEvent<{ name?: string }>).detail?.name ?? 'random';
      playMotionNow(name);
    };
    window.addEventListener('mascot:motion', onLocal);
    const live = hasTransport();
    const offIpc = live ? api.on('mascot.command', (cmd) => handleMascotCommand(cmd)) : undefined;
    const offAvatar = live ? api.on('avatar.event', (e) => avatarEvents.emit(e)) : undefined;
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
      offAvatar?.();
      offCursor?.();
      offPhysics?.();
    };
  }, []);
  return null;
};

export default MascotDriver;
