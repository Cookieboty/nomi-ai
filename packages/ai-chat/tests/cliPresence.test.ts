import { describe, expect, it } from 'vitest';

import { anyCliInstalled, anyHarnessBinPresent } from '../src/services/cliPresence';
import type { CliInstallInfo } from '../src/services/cliUpdateClient';

const row = (kind: CliInstallInfo['kind'], path: string | null) =>
  ({ kind, path }) as unknown as CliInstallInfo;

describe('界面形态：装了 agent 才显示 agent 相关界面', () => {
  it('任一内置 CLI 装了就是 true；都没装、或只有 Cursor 这类非内置的是 false', () => {
    expect(anyCliInstalled([])).toBe(false);
    expect(anyCliInstalled([row('claude', null), row('codex', null)])).toBe(false);
    expect(anyCliInstalled([row('cursor', '/usr/bin/cursor')])).toBe(false);
    expect(anyCliInstalled([row('claude', null), row('gemini', '/usr/bin/gemini')])).toBe(true);
  });

  it('仅配置了自定义启动器的内置 CLI 也会被 harness.state().bins 识别为已安装', () => {
    expect(anyHarnessBinPresent(null)).toBe(false);
    expect(anyHarnessBinPresent({ claude: null, codex: null })).toBe(false);
    expect(anyHarnessBinPresent({ cursor: '/usr/bin/cursor', claude: null })).toBe(false);
    expect(anyHarnessBinPresent({ claude: '/usr/local/bin/reclaude', codex: null })).toBe(true);
  });
});
