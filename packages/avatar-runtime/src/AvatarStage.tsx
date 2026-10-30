import { useEffect, useMemo, useRef } from 'react';
import type { FC } from 'react';

import { AvatarCanvas } from './canvas/AvatarCanvas';
import { driveAvatar } from './driver';
import type { AvatarHitbox, AvatarOutputEvent } from './events';
import {
  AvatarContext,
  hitboxesOf,
  type AvatarContextValue,
  type AvatarInteractionEvent,
  type AvatarRuntimeOptions,
} from './host';
import type { BodyRegion } from './interaction/regions';
import { mappedSemantics } from './mapping';
import { defaultAvatarRuntime } from './runtime';

export type AvatarStageProps = AvatarRuntimeOptions;

function hitboxOf(region: BodyRegion | 'any'): AvatarHitbox {
  return region === 'hands' ? 'hand' : region;
}

/** 互动反应 → 角色 → AI 的语义事件（摸 = touched，点击 / 双击 = clicked；悬停与物理不报） */
export function semanticOfInteraction(e: AvatarInteractionEvent): AvatarOutputEvent | null {
  const hitbox = hitboxOf(e.region);
  switch (e.kind) {
    case 'pat':
      return { type: 'touched', hitbox };
    case 'click':
      return { type: 'clicked', hitbox };
    case 'double':
      return { type: 'clicked', hitbox, double: true };
    default:
      return null;
  }
}

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
  onAvatarEvent,
  windowHost = null,
  riveWasmUrl,
  onMark,
  debugHandles = false,
  runtime = defaultAvatarRuntime,
}) => {
  // 回调走 ref：宿主每次渲染给新函数时不重建画布
  const interactionRef = useRef(onInteraction);
  const avatarEventRef = useRef(onAvatarEvent);
  const markRef = useRef(onMark);
  useEffect(() => {
    interactionRef.current = onInteraction;
    avatarEventRef.current = onAvatarEvent;
    markRef.current = onMark;
  });

  // 当前角色的映射（语义 → 资源）；卸载时回到默认映射。随后报告场景：角色与能表现的语义名。
  // 包声明的表情一起传：旧模板兜底要知道 `sad → tears` 的 tears 是不是这个包自己的表情
  const { id: characterId, mapping } = character;
  const expressions = character.capabilities?.expressions;
  useEffect(() => {
    const restore = runtime.mapping.set(mapping, expressions);
    avatarEventRef.current?.({
      type: 'scene',
      characterId,
      ...mappedSemantics(runtime.mapping.current()),
    });
    return restore;
  }, [characterId, mapping, expressions, runtime]);

  useEffect(() => (events ? driveAvatar(events, runtime) : undefined), [events, runtime]);
  // 卸载时清掉这个运行时的表情回落计时器与冷却
  useEffect(() => () => runtime.mood.reset(), [runtime]);

  const ctx = useMemo<AvatarContextValue>(
    () => ({
      character,
      hitboxes: hitboxesOf(character.layout),
      events,
      onInteraction: (e: AvatarInteractionEvent) => {
        interactionRef.current?.(e);
        const semantic = semanticOfInteraction(e);
        if (semantic) avatarEventRef.current?.(semantic);
      },
      windowHost,
      riveWasmUrl,
      mark: (name: string, ...detail: unknown[]) => markRef.current?.(name, ...detail),
      debugHandles,
      runtime,
    }),
    [character, events, windowHost, riveWasmUrl, debugHandles, runtime],
  );

  return (
    <AvatarContext.Provider value={ctx}>
      <AvatarCanvas character={character} resolveAsset={resolveAsset} />
    </AvatarContext.Provider>
  );
};

export default AvatarStage;
