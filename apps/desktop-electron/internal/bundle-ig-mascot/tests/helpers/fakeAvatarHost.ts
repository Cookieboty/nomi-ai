import type { AvatarHost } from '../../src/seams/avatar';

/**
 * FakeAvatarHost —— 单测用假 host：记录收到的语义事件，可以让某个方法失败。
 */
export interface FakeAvatarHostRecord {
  emotion: Array<{ name: string; weight?: number }>;
  gesture: string[];
  activity: string[];
  speaking: number[];
}

type Method = 'emotion' | 'gesture' | 'activity';

export interface FakeAvatarHost extends AvatarHost {
  readonly record: FakeAvatarHostRecord;
  fail(kind: Method, err: Error): void;
}

export function createFakeAvatarHost(): FakeAvatarHost {
  const failures = new Map<Method, Error>();
  const record: FakeAvatarHostRecord = { emotion: [], gesture: [], activity: [], speaking: [] };
  const check = (kind: Method) => {
    const err = failures.get(kind);
    if (err) throw err;
  };
  return {
    record,
    async emotion(name, weight) {
      check('emotion');
      record.emotion.push(weight === undefined ? { name } : { name, weight });
    },
    async gesture(name) {
      check('gesture');
      record.gesture.push(name);
    },
    async activity(name) {
      check('activity');
      record.activity.push(name);
    },
    speaking(level) {
      record.speaking.push(level);
    },
    fail(kind, err) {
      failures.set(kind, err);
    },
  };
}
