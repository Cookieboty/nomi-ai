import { describe, expect, it } from 'vitest';

import { appContract } from '../src/app';

const proc = appContract.procedures['tasks.create'];

const base = {
  title: '每日巡检',
  goal: 'g',
  trigger: { kind: 'manual' as const },
  grant: { level: 2 as const, paths: [], connections: [] },
  executor: { kind: 'cli' as const, cwd: '/work', isolation: 'worktree' as const },
};

describe('tasks.create cli executor', () => {
  it('accepts a preset-only executor (cli omitted, presetId set)', () => {
    const r = proc.input.safeParse({
      ...base,
      executor: { ...base.executor, presetId: 'balanced' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects a cli executor with neither cli nor presetId', () => {
    const r = proc.input.safeParse({ ...base });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.some((i) => i.path.join('.') === 'executor.cli')).toBe(true);
  });

  it('accepts an explicit executor', () => {
    const r = proc.input.safeParse({
      ...base,
      executor: { ...base.executor, cli: 'claude', source: 'local' },
    });
    expect(r.success).toBe(true);
  });
});
