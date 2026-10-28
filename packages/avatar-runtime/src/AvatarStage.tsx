import { useEffect, useMemo, useRef } from 'react';
import type { FC } from 'react';

import { AvatarCanvas } from './canvas/AvatarCanvas';
import { driveAvatar } from './driver';
import {
  AvatarContext,
  hitboxesOf,
  type AvatarContextValue,
  type AvatarInteractionEvent,
  type AvatarRuntimeOptions,
} from './host';

export type AvatarStageProps = AvatarRuntimeOptions;

/**
 * 运行时的 React 入口：按角色的 `mode` 挂上 Rive / sprite / static 画布（Rive 起不来时回退到分层 2D），
 * 订阅事件源驱动表情、动作与口型，把互动经 `onInteraction` 报出去。
 *
 * 卸载时释放全部资源（后端、wasm 实例、图片、计时器、订阅），可以换角色重新挂载（§10.7）。
 */
export const AvatarStage: FC<AvatarStageProps> = ({
  character,
  resolveAsset,
  events = null,
  onInteraction,
  windowHost = null,
  riveWasmUrl,
  onMark,
  debugHandles = false,
}) => {
  // 回调走 ref：宿主每次渲染给新函数时不重建画布
  const interactionRef = useRef(onInteraction);
  const markRef = useRef(onMark);
  useEffect(() => {
    interactionRef.current = onInteraction;
    markRef.current = onMark;
  });

  useEffect(() => (events ? driveAvatar(events) : undefined), [events]);

  const ctx = useMemo<AvatarContextValue>(
    () => ({
      character,
      hitboxes: hitboxesOf(character.layout),
      events,
      onInteraction: (e: AvatarInteractionEvent) => interactionRef.current?.(e),
      windowHost,
      riveWasmUrl,
      mark: (name: string, ...detail: unknown[]) => markRef.current?.(name, ...detail),
      debugHandles,
    }),
    [character, events, windowHost, riveWasmUrl, debugHandles],
  );

  return (
    <AvatarContext.Provider value={ctx}>
      <AvatarCanvas character={character} resolveAsset={resolveAsset} />
    </AvatarContext.Provider>
  );
};

export default AvatarStage;
