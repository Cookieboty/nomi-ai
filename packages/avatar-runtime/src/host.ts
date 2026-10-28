/**
 * 运行时的输入与输出（docs/design/core-host-decoupling.md §10.6）：
 *
 * - 输入：角色（manifest 的引擎相关字段 + mapping，类型来自 `@nomi-ai/character-contract`）、
 *   `resolveAsset(path) → url`、一个语义事件源 `AvatarEventSource`（./events.ts）；
 * - 输出：互动事件（`onInteraction`：点击、双击、摸头、悬停、抓起、落地……）；
 *   放在透明桌面窗口里时，再经可选的 `AvatarWindowHost` 报告命中（点击穿透）、拖拽与包围盒。
 *
 * 宿主（renderer）用契约客户端实现这些接口；运行时自己不访问任何宿主全局。
 */
import type {
  PackCapabilities,
  PackLayout,
  PackMapping,
  PackMode,
} from '@nomi-ai/character-contract';
import { createContext, useContext } from 'react';

import type { AvatarEventSource } from './events';
import type { ReactionKind } from './interaction/gestures';
import type { BodyRegion } from './interaction/regions';
import type { Rect } from './interaction/shape';
import type { Box } from './layoutStore';
import type { PackHitboxes } from './spriteInteraction';

/** 运行时需要的角色数据：manifest 里与引擎有关的部分。 */
export interface AvatarCharacter {
  id: string;
  mode: PackMode;
  /**
   * 资源路径：包内相对路径（经 `resolveAsset` 转成 URL），或已经是 URL（`scheme:`、`./`、`/` 开头，
   * 原样使用）。缺省的资源不加载。
   */
  assets: {
    rive?: string | null;
    /** sprite / 分层 2D 骨架的 manifest.json */
    spriteManifest?: string | null;
    static?: string | null;
  };
  rive?: { artboard?: string; stateMachine?: string } | null;
  /** 命中区与气泡锚点（角色框的比例）；没有时按几何推断 */
  layout?: PackLayout | null;
  capabilities?: PackCapabilities;
  /**
   * 语义 → 引擎资源（§10.5）。C2 只接收并保存，C3 才按它翻译情绪 / 活动 / 手势；
   * 现在的表情与动作仍由表情导演直接给出。
   */
  mapping?: PackMapping | null;
}

/** 互动输出：一次互动反应（已经按冷却与设置过滤）。 */
export interface AvatarInteractionEvent {
  /** click / double（clicked）、pat / hover（touched）、grab / land / wall（物理） */
  kind: ReactionKind;
  region: BodyRegion | 'any';
  /** 反应附带的台词 key（宿主显示气泡） */
  line?: string;
  /** 这句台词要不要朗读（点击类） */
  speak: boolean;
}

export interface DragPoint {
  screenX: number;
  screenY: number;
}

/**
 * 透明桌面窗口（可选）：运行时报告命中与拖拽，宿主据此切换点击穿透、移动窗口。
 * 浏览器页面里不提供，拖拽与穿透就不发生。调用都是即发即弃。
 */
export interface AvatarWindowHost {
  /** 宿主平台（'linux' 时按像素形状设置窗口形状） */
  platform(): Promise<string>;
  dragStart(p: DragPoint): void;
  dragMove(p: DragPoint): void;
  dragEnd(): void;
  /** 光标是否落在角色或界面上（否则点击穿透） */
  setHit(hit: boolean): void;
  /** 角色身体框（窗口坐标）与窗口尺寸 */
  setGeometry(g: Box & { vw: number; vh: number }): void;
  /** Linux：窗口形状 = 角色像素扫描线 + 界面矩形 */
  setShape(rects: Rect[]): void;
}

export interface AvatarRuntimeOptions {
  character: AvatarCharacter;
  /** 包内相对路径 → URL */
  resolveAsset(path: string): string;
  /** 语义事件源；不提供时角色只做待机与互动 */
  events?: AvatarEventSource | null;
  onInteraction?: (event: AvatarInteractionEvent) => void;
  windowHost?: AvatarWindowHost | null;
  /** Rive wasm 的 URL（宿主打包进来的那份；CSP 不允许 CDN）。缺省用 Rive 运行时自带的地址 */
  riveWasmUrl?: string;
  /** 性能 / 就绪打点（'mascot-model-loaded' 等） */
  onMark?: (name: string, ...detail: unknown[]) => void;
  /** 开发态：把后端挂到 globalThis.__nomiMascot / __nomiRig 供 CDP 调试 */
  debugHandles?: boolean;
}

/** 已经是 URL（scheme、`./`、`../`、`/` 开头）的路径原样使用，其余经 resolveAsset。 */
export function isResolvedUrl(path: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\.{0,2}\/)/i.test(path);
}

export function assetUrl(
  path: string | null | undefined,
  resolveAsset: (path: string) => string,
): string {
  if (!path) return '';
  return isResolvedUrl(path) ? path : resolveAsset(path);
}

/** manifest 的 layout → 交互用的命中区（没有声明 hitboxes 时返回 null，按几何推断）。 */
export function hitboxesOf(layout: PackLayout | null | undefined): PackHitboxes | null {
  if (!layout?.hitboxes) return null;
  return {
    regions: layout.hitboxes as PackHitboxes['regions'],
    ...(layout.bubbleAnchor ? { bubbleAnchor: layout.bubbleAnchor } : {}),
  };
}

/**
 * 经 `validatePack` 规范化后的包（或 `virtual:character-pack` 的数据）→ `AvatarCharacter`。
 * 资源路径保持包内相对，由调用方的 `resolveAsset` 拼出 URL。
 */
export function avatarCharacterFromPack(pack: {
  id?: string;
  manifest?: { id: string; rive?: AvatarCharacter['rive']; capabilities?: PackCapabilities };
  mode: PackMode;
  layout?: PackLayout | null;
  mapping?: PackMapping | null;
  rive?: AvatarCharacter['rive'];
  capabilities?: PackCapabilities;
  assets: { rive: string | null; spriteManifest: string | null; static: string | null };
}): AvatarCharacter {
  return {
    id: pack.id ?? pack.manifest?.id ?? 'character',
    mode: pack.mode,
    assets: {
      rive: pack.assets.rive,
      spriteManifest: pack.assets.spriteManifest,
      static: pack.assets.static,
    },
    rive: pack.rive ?? pack.manifest?.rive ?? null,
    layout: pack.layout ?? null,
    capabilities: pack.capabilities ?? pack.manifest?.capabilities,
    mapping: pack.mapping ?? null,
  };
}

/** 画布读取的运行时上下文（由 AvatarStage 提供）。 */
export interface AvatarContextValue {
  character: AvatarCharacter | null;
  hitboxes: PackHitboxes | null;
  events: AvatarEventSource | null;
  onInteraction: (event: AvatarInteractionEvent) => void;
  windowHost: AvatarWindowHost | null;
  riveWasmUrl?: string;
  mark: (name: string, ...detail: unknown[]) => void;
  debugHandles: boolean;
}

const noop = (): void => undefined;

export const DEFAULT_AVATAR_CONTEXT: AvatarContextValue = {
  character: null,
  hitboxes: null,
  events: null,
  onInteraction: noop,
  windowHost: null,
  mark: noop,
  debugHandles: false,
};

export const AvatarContext = createContext<AvatarContextValue>(DEFAULT_AVATAR_CONTEXT);

export function useAvatarContext(): AvatarContextValue {
  return useContext(AvatarContext);
}
