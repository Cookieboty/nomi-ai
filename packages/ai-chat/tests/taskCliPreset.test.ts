import { describe, expect, it } from 'vitest';

import { buildTaskCliExecutor } from '../src/components/Tasks/taskCliHelpers';
import type { RunnerPreset } from '../src/services/delegateClient';

const preset = (over: Partial<RunnerPreset>): RunnerPreset =>
  ({
    id: 'balanced',
    label: '日常均衡',
    cli: 'claude',
    source: 'official',
    accountId: 'acct-claude',
    model: 'claude-sonnet-4-6',
    reasoningEffort: 'medium',
    ...over,
  }) as RunnerPreset;

describe('buildTaskCliExecutor', () => {
  it('preset mode saves only presetId so the current preset is resolved at trigger time', () => {
    const ex = buildTaskCliExecutor(
      {
        effectiveCliMode: 'preset:balanced',
        activePreset: preset({}),
      } as never,
      null,
      '/work',
    );
    expect(ex).toEqual({
      kind: 'cli',
      cwd: '/work',
      isolation: 'worktree',
      presetId: 'balanced',
    });
  });

  it('preset switched Claude -> Codex after saving: nothing of the old cli is persisted', () => {
    const ex = buildTaskCliExecutor(
      {
        effectiveCliMode: 'preset:balanced',
        activePreset: preset({
          cli: 'codex',
          source: 'official',
          accountId: 'acct-codex',
          model: 'gpt-6.1-sol',
          reasoningEffort: 'high',
        }),
      } as never,
      null,
      '/work',
    );
    // 执行参数由内核按触发时的档位解析（executor_cli.go / tasks_cli_wiring.go），这里不能留下旧的 claude 快照
    expect(ex).not.toHaveProperty('cli');
    expect(ex).not.toHaveProperty('accountId');
    expect(ex).not.toHaveProperty('model');
    expect(ex).not.toHaveProperty('source');
    expect(ex).not.toHaveProperty('reasoningEffort');
    expect(ex).toMatchObject({ presetId: 'balanced' });
  });

  it('scheduled route preset also saves only presetId', () => {
    const ex = buildTaskCliExecutor(
      {
        effectiveCliMode: 'scheduled',
        scheduledPreset: preset({ id: 'low', cli: 'deepseek' }),
      } as never,
      null,
      '/work',
    );
    expect(ex).toEqual({ kind: 'cli', cwd: '/work', isolation: 'worktree', presetId: 'low' });
  });

  it('explicit (non-preset) executors keep their explicit cli and overrides', () => {
    const ex = buildTaskCliExecutor(
      {
        effectiveCliMode: 'cli',
        resolvedCli: 'codex',
      } as never,
      null,
      '/work',
    );
    expect(ex).toEqual({ kind: 'cli', cli: 'codex', cwd: '/work', isolation: 'worktree' });
  });

  it('explicit custom spec keeps its own parameters', () => {
    const ex = buildTaskCliExecutor(
      { effectiveCliMode: 'custom' } as never,
      {
        cli: 'claude',
        source: 'local',
        accountId: null,
        model: null,
        reasoningEffort: 'low',
      } as never,
      '/work',
    );
    expect(ex).toEqual({
      kind: 'cli',
      cli: 'claude',
      cwd: '/work',
      isolation: 'worktree',
      source: 'local',
      reasoningEffort: 'low',
    });
  });
});
