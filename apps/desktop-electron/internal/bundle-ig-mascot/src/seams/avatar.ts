import { defineService } from '@nomi-ai/bundle-ig-base';
import type {
  SemanticActivity,
  SemanticEmotion,
  SemanticGesture,
} from '@nomi-ai/character-contract';

/**
 * AI 与角色之间只传语义事件（docs/design/core-host-decoupling.md §10.5）：
 *
 * - AI → 角色：`emotion(name, weight)`、`gesture(name)`、`activity(name)`、`speaking(level)`，
 *   名字来自 `@nomi-ai/character-contract` 的词表；具体播哪个表情 / 动作由角色包的 mapping.json
 *   决定（avatar-runtime），本 bundle 与 AI 侧代码不认识任何片段 / 动作 / 表情资源名。
 * - 角色 → AI：`touched(hitbox)`、`clicked(hitbox)`、`scene(…)`，由角色窗口经契约 `ai.avatar.report`
 *   报给主进程，再经 `on(evt)` 分发给订阅者。
 */

/** 角色身上的命中区（契约命中区名，any = 没有落在具体区域） */
export type AvatarHitbox = 'head' | 'face' | 'body' | 'hand' | 'hem' | 'legs' | 'any';

export interface AvatarTouchedPayload {
  hitbox: AvatarHitbox;
  /** 时间戳（ms） */
  at: number;
}

export interface AvatarClickedPayload {
  hitbox: AvatarHitbox;
  double?: boolean;
  at: number;
}

/** 当前场景：哪个角色、它能表现哪些语义名（角色包有映射的） */
export interface AvatarScenePayload {
  characterId: string;
  emotions: string[];
  activities: string[];
  gestures: string[];
  at: number;
}

/** 角色窗口报来的事件（去掉时间戳，由 service 盖上） */
export type AvatarReport =
  | { type: 'touched'; hitbox: AvatarHitbox }
  | { type: 'clicked'; hitbox: AvatarHitbox; double?: boolean }
  | (Omit<AvatarScenePayload, 'at'> & { type: 'scene' });

export type AvatarEvent = 'touched' | 'clicked' | 'scene';

export type AvatarEventPayload<E extends AvatarEvent> = E extends 'touched'
  ? AvatarTouchedPayload
  : E extends 'clicked'
    ? AvatarClickedPayload
    : E extends 'scene'
      ? AvatarScenePayload
      : never;

/**
 * 角色宿主接口（AI → 角色）。由消费方（主进程把语义事件经契约发给角色窗口）通过
 * `AvatarService.attachHost` 注入，本 bundle 只面向本接口编程，与具体渲染库解耦。
 */
export interface AvatarHost {
  emotion(name: SemanticEmotion, weight?: number): Promise<void>;
  gesture(name: SemanticGesture): Promise<void>;
  activity(name: SemanticActivity): Promise<void>;
  /** 说话的口型包络 0..1（0 = 停止） */
  speaking(level: number): void;
}

/**
 * ctx.avatar 对外提供的 service。与 Host 同形但语义更严：
 *   - 不在词表里的名字忽略并落 warn 日志（不会转给 host）
 *   - weight / level clamp 到 [0, 1]
 *   - 没有 host 时 no-op 且落 warn 日志（tolerateNoHost=false 时抛错）
 *   - report(…) 把角色窗口报来的事件分发给 on(evt) 的订阅者
 */
export interface AvatarService extends AvatarHost {
  report(event: AvatarReport): void;
  on<E extends AvatarEvent>(evt: E, fn: (p: AvatarEventPayload<E>) => void): () => void;
  /** 最近一次报告的场景；角色窗口还没报告时为 null */
  scene(): AvatarScenePayload | null;
  /** 供消费方注入 host */
  attachHost(host: AvatarHost): () => void;
  /** 当前是否已挂载 host */
  hasHost(): boolean;
}

export const AvatarKey = defineService<AvatarService>('ctx.avatar');
