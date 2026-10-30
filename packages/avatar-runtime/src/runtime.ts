/**
 * 运行时实例（docs/design/core-host-decoupling.md §10.6、§10.7）：一个角色用到的全部可变状态——
 * 后端注册表、布局（包围盒 / 头部 / 光标 / 工具栏槽位）、互动设置、映射、情绪与自动动作冷却、
 * 互动反应冷却。同一页面挂两个角色时各用一个实例，互不影响。
 *
 * `defaultAvatarRuntime` 是页面的主运行时：模块级出口（`mascotRegistry`、`layoutStore`、
 * `interactionSettings`、`applyDirective`、`react`……）都是它的成员，桌面角色窗口只挂一个角色，
 * 宿主的工具栏、气泡直接读它们。再挂一个角色时传 `runtime={createAvatarRuntime()}`。
 */
import { AvatarReactions, avatarReactions } from './interaction/reactions';
import { InteractionSettings, interactionSettings } from './interaction/settings';
import { createLayoutStore, layoutStore, type LayoutStore } from './layoutStore';
import { AvatarMapping, avatarMapping } from './mapping';
import { MascotRegistry, mascotRegistry } from './MascotBackend';
import { AvatarMood, avatarMood } from './mood';

export interface AvatarRuntime {
  readonly registry: MascotRegistry;
  readonly layout: LayoutStore;
  readonly interaction: InteractionSettings;
  readonly mapping: AvatarMapping;
  readonly mood: AvatarMood;
  readonly reactions: AvatarReactions;
  /**
   * 调试 / e2e 观察用的状态标记（渲染器、包围盒、命中、拖拽……）：主运行时写 `<html data-mascot-*>`，
   * 其它实例写自己的对象（测试从这里读），不覆盖主运行时的标记。
   */
  readonly dataset: Record<string, string | undefined>;
  /** 写一个状态标记（`undefined` 删除）；画布与交互层经它写 `dataset` */
  flag(name: string, value?: string): void;
}

function flagOf(this: AvatarRuntime, name: string, value?: string): void {
  if (value === undefined) delete this.dataset[name];
  else this.dataset[name] = value;
}

export interface CreateAvatarRuntimeOptions {
  /** 互动设置持久化的 localStorage key；缺省只在内存里（不和主运行时抢同一个 key） */
  interactionStorageKey?: string | null;
}

/** 新建一个独立的运行时实例（页面里的第二个及以后的角色） */
export function createAvatarRuntime(options: CreateAvatarRuntimeOptions = {}): AvatarRuntime {
  const dataset: Record<string, string | undefined> = {};
  const registry = new MascotRegistry({ dataset: () => dataset });
  const interaction = new InteractionSettings({
    storageKey: options.interactionStorageKey ?? null,
  });
  const mapping = new AvatarMapping();
  return {
    registry,
    layout: createLayoutStore(),
    interaction,
    mapping,
    mood: new AvatarMood(registry, mapping),
    reactions: new AvatarReactions(registry, interaction, () => dataset),
    dataset,
    flag: flagOf,
  };
}

const offPage: Record<string, string | undefined> = {};

/** 页面主运行时：写 `<html data-mascot-*>`，互动设置持久化到 localStorage */
export const defaultAvatarRuntime: AvatarRuntime = {
  registry: mascotRegistry,
  layout: layoutStore,
  interaction: interactionSettings,
  mapping: avatarMapping,
  mood: avatarMood,
  reactions: avatarReactions,
  get dataset() {
    return typeof document === 'undefined' ? offPage : document.documentElement.dataset;
  },
  flag: flagOf,
};
