import { describe, expect, it } from 'vitest';

import { cliTabPlaceholder } from '../src/utils/cliTabPlaceholder';

describe('cliTabPlaceholder', () => {
  it('uses a backend/status specific hint instead of the Nomi model hint', () => {
    expect(cliTabPlaceholder({ title: 'Codex', backend: 'codex', status: 'idle' })).toBe(
      '发给 Codex…',
    );
    expect(cliTabPlaceholder({ title: 'Tests', backend: 'codex', status: 'idle' })).toBe(
      '发给 Tests（Codex）…',
    );
    expect(cliTabPlaceholder({ title: 'x', backend: 'claude', status: 'running' })).toContain(
      'Claude Code 正在处理',
    );
    expect(cliTabPlaceholder({ title: 'x', backend: 'dsh', status: 'queued' })).toContain(
      'dsh 排队中',
    );
    expect(cliTabPlaceholder({ title: 'x', backend: 'dsh', status: 'queued' })).not.toContain(
      'AI模型',
    );
  });
});
