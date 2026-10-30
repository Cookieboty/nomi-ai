/** Claude Code 默认档位的来源：initialize 里没有，按 CLI 自己的优先级读环境变量 / 设置文件 */
jest.unmock('fs');
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claudeConfiguredEffort } from '../../../src/cli/modelDiscovery';

describe('claudeConfiguredEffort', () => {
  let dir: string;
  let settingsPath: string;
  const deps = (claudeDefaults: { effortEnv?: string; settingsPath?: string }) => ({
    spawn: () => null,
    codexConfigPath: '',
    claudeDefaults,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-claude-effort-'));
    settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ effortLevel: 'medium' }));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('CLAUDE_CODE_EFFORT_LEVEL 优先于 settings.json', () => {
    expect(claudeConfiguredEffort(deps({ effortEnv: 'max', settingsPath }))).toBe('max');
  });

  it('环境变量为 auto / 空时读 settings.json 的 effortLevel', () => {
    expect(claudeConfiguredEffort(deps({ effortEnv: 'auto', settingsPath }))).toBe('medium');
    expect(claudeConfiguredEffort(deps({ effortEnv: ' ', settingsPath }))).toBe('medium');
  });

  it('都没有时为 null（由 CLI 按模型决定）', () => {
    expect(claudeConfiguredEffort(deps({ settingsPath: path.join(dir, 'missing.json') }))).toBe(
      null,
    );
    expect(claudeConfiguredEffort(deps({}))).toBeNull();
  });
});
