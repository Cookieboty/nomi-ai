import { defineService } from '@nomi-ai/bundle-ig-base';

/**
 * 命中区域（由角色渲染后端定义，常见如 Head / Body / Chest / Arm）。
 * bundle 不做枚举强绑，字符串透传。
 */
export type AvatarHitArea = string;

export interface AvatarTouchPayload {
  hitArea: AvatarHitArea;
  /** 相对模型 canvas 的坐标（0~1），可选 */
  x?: number;
  y?: number;
  /** 触发时间戳（ms） */
  at: number;
}

export interface AvatarMotionEndPayload {
  group: string;
  index?: number;
  /** 是否被后续动画打断 */
  interrupted?: boolean;
}

export type AvatarEvent = 'touch' | 'motion:end';

export type AvatarEventPayload<E extends AvatarEvent> = E extends 'touch'
  ? AvatarTouchPayload
  : E extends 'motion:end'
    ? AvatarMotionEndPayload
    : never;

/**
 * 角色渲染宿主接口。
 * 由消费方（主进程 IPC 桥 / renderer）通过 `AvatarService.attachHost` 注入实际实现，
 * 本 bundle 只面向本接口编程，做到与具体渲染库解耦。
 */
export interface AvatarHost {
  playMotion(group: string, index?: number): Promise<void>;
  setExpression(name: string): Promise<void>;
  driveLipSync(rms: number): void;
  /** hitArea 事件、动作播完事件由 host 反向广播 */
  on<E extends AvatarEvent>(evt: E, fn: (p: AvatarEventPayload<E>) => void): () => void;
}

/**
 * ctx.avatar 对外提供的 service。
 * 与 Host 接口同形但语义更严：
 *   - RMS 会做 clamp 到 [0, 1]
 *   - playMotion / setExpression 若无 host 会 no-op 且落 warn 日志
 *   - on 支持 'touch' / 'motion:end'，本 service 内部转发
 */
export interface AvatarService {
  playMotion(group: string, index?: number): Promise<void>;
  setExpression(name: string): Promise<void>;
  driveLipSync(rms: number): void;
  on<E extends AvatarEvent>(evt: E, fn: (p: AvatarEventPayload<E>) => void): () => void;
  /** 供 consumer runtime 注入 host（P8） */
  attachHost(host: AvatarHost): () => void;
  /** 当前是否已挂载 host */
  hasHost(): boolean;
}

export const AvatarKey = defineService<AvatarService>('ctx.avatar');
