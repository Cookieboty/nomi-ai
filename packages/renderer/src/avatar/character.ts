/**
 * 当前角色 → avatar-runtime 的输入（`AvatarCharacter` + `resolveAsset`）。
 *
 * 内置包给包内相对路径（`resolveAsset` 拼上 `./character/`）；运行时覆盖包（Scheme B）给的是
 * `character-pack://` URL，运行时原样使用。字段缺省时的回退顺序与 characterConfig 的取值函数一致。
 */
import type { AvatarCharacter } from '@nomi-ai/avatar-runtime';

import {
  BUNDLED_PACK,
  getCharacterId,
  getCharacterMode,
  getHitboxes,
  getOverlay,
  getRiveConfig,
  getSpriteManifestPath,
} from '../mascot/characterConfig';

/** 内置包的包内路径 → URL（`./character/…`） */
export function resolveBundledAsset(path: string): string {
  return `${BUNDLED_PACK.base}${path}`;
}

/**
 * 在角色包就绪后调用（`useCharacterPackReady()` 为 true）。
 * @param manifestPath 模型列表里当前模型的 sprite manifest（分层 2D 回退用）
 */
export function currentAvatarCharacter(manifestPath: string): AvatarCharacter {
  const overlay = getOverlay();
  const rive = getRiveConfig();
  const hitboxes = getHitboxes();
  return {
    id: getCharacterId(),
    mode: getCharacterMode(),
    assets: {
      rive: overlay?.riveUrl || BUNDLED_PACK.assets.rive || null,
      static: overlay?.staticUrl || BUNDLED_PACK.assets.static || null,
      spriteManifest: getSpriteManifestPath(manifestPath),
    },
    rive: { artboard: rive.artboard, stateMachine: rive.stateMachine },
    layout: hitboxes
      ? {
          hitboxes: hitboxes.regions as NonNullable<AvatarCharacter['layout']>['hitboxes'],
          ...(hitboxes.bubbleAnchor ? { bubbleAnchor: hitboxes.bubbleAnchor } : {}),
        }
      : null,
    capabilities: overlay ? undefined : BUNDLED_PACK.capabilities,
    mapping: overlay ? null : BUNDLED_PACK.mapping,
  };
}
