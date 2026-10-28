import type { AvatarEvent, AvatarEventPayload, AvatarHost } from '../../src/seams/avatar';

/**
 * FakeAvatarHost —— 单测用假 host。
 * - 记录所有 host 方法调用
 * - 提供 emit(evt, payload) 主动触发 seam 转发
 */
export interface FakeAvatarHostRecord {
  playMotion: Array<{ group: string; index?: number }>;
  setExpression: string[];
  driveLipSync: number[];
}

export interface FakeAvatarHost extends AvatarHost {
  readonly record: FakeAvatarHostRecord;
  emit<E extends AvatarEvent>(evt: E, payload: AvatarEventPayload<E>): void;
  fail(kind: 'playMotion' | 'setExpression', err: Error): void;
}

export function createFakeAvatarHost(): FakeAvatarHost {
  const listeners = new Map<AvatarEvent, Set<(p: unknown) => void>>();
  const failures = new Map<'playMotion' | 'setExpression', Error>();

  const record: FakeAvatarHostRecord = {
    playMotion: [],
    setExpression: [],
    driveLipSync: [],
  };

  return {
    record,
    async playMotion(group, index) {
      const err = failures.get('playMotion');
      if (err) throw err;
      record.playMotion.push({ group, index });
    },
    async setExpression(name) {
      const err = failures.get('setExpression');
      if (err) throw err;
      record.setExpression.push(name);
    },
    driveLipSync(rms) {
      record.driveLipSync.push(rms);
    },
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      const set = listeners.get(evt)!;
      set.add(fn as (p: unknown) => void);
      return () => {
        set.delete(fn as (p: unknown) => void);
      };
    },
    emit(evt, payload) {
      listeners.get(evt)?.forEach((fn) => fn(payload));
    },
    fail(kind, err) {
      failures.set(kind, err);
    },
  };
}
