import {
  PERMISSION_MODES,
  effectiveMode,
  grokModeId,
  permissionLaunch,
  planPromptPrefix,
  supportedModes,
} from '../../../src/cli/permissionMode';
import type { HarnessPermissionMode } from '../../../src/cli/types';

describe('permissionMode', () => {
  it.each([
    ['claude', ['plan', 'manual', 'acceptEdits', 'auto', 'bypass']],
    ['codex', ['plan', 'manual', 'acceptEdits', 'auto', 'bypass']],
    ['dsh', ['plan', 'acceptEdits', 'bypass']],
    ['grok', ['plan', 'manual', 'acceptEdits', 'bypass']],
  ] as const)('%s supports %j', (backend, modes) => {
    expect([...supportedModes(backend)]).toEqual(modes);
  });

  it.each([
    ['dsh', 'manual', 'plan'],
    ['dsh', 'auto', 'acceptEdits'],
    ['grok', 'auto', 'acceptEdits'],
  ] as const)('degrades %s %s → %s', (backend, mode, to) => {
    expect(effectiveMode(backend, mode)).toEqual({ mode: to, degraded: true });
  });

  it('grok ACP 会话模式 id', () => {
    expect(PERMISSION_MODES.map(grokModeId)).toEqual([
      'plan',
      'default',
      'acceptEdits',
      'default',
      'bypassPermissions',
    ]);
  });

  it('keeps supported modes as-is', () => {
    for (const m of PERMISSION_MODES) {
      expect(effectiveMode('claude', m)).toEqual({ mode: m, degraded: false });
    }
  });

  it.each<[HarnessPermissionMode, string[]]>([
    ['plan', ['--permission-mode', 'plan']],
    ['manual', ['--permission-mode', 'default']],
    ['acceptEdits', ['--permission-mode', 'acceptEdits']],
    ['auto', ['--permission-mode', 'auto']],
    ['bypass', ['--permission-mode', 'bypassPermissions']],
  ])('claude %s', (mode, args) => {
    expect(permissionLaunch('claude', mode)).toEqual({ args, env: {} });
  });

  it.each<[HarnessPermissionMode, string[]]>([
    ['plan', ['-c', 'sandbox_mode="read-only"']],
    [
      'acceptEdits',
      ['-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true'],
    ],
    [
      'auto',
      [
        '-c',
        'sandbox_mode="workspace-write"',
        '-c',
        'sandbox_workspace_write.network_access=true',
        '-c',
        'approval_policy="on-request"',
        '-c',
        'approvals_reviewer="auto_review"',
      ],
    ],
    ['bypass', ['-c', 'sandbox_mode="danger-full-access"']],
  ])('codex %s', (mode, args) => {
    expect(permissionLaunch('codex', mode)).toEqual({ args, env: {} });
  });

  it('codex network can be turned off', () => {
    expect(permissionLaunch('codex', 'acceptEdits', { codexNetwork: false }).args).toEqual([
      '-c',
      'sandbox_mode="workspace-write"',
    ]);
  });

  it.each<[HarnessPermissionMode, string]>([
    ['plan', 'read-only'],
    ['acceptEdits', 'workspace-write'],
    ['bypass', 'danger-full-access'],
  ])('dsh %s → DSH_PERMISSION_MODE=%s', (mode, env) => {
    expect(permissionLaunch('dsh', mode)).toEqual({ args: [], env: { DSH_PERMISSION_MODE: env } });
  });

  it('grok uses --permission-mode, --yolo only for bypass', () => {
    expect(permissionLaunch('grok', 'acceptEdits').args).toEqual([
      '--permission-mode',
      'acceptEdits',
    ]);
    expect(permissionLaunch('grok', 'plan').args).toEqual(['--permission-mode', 'plan']);
    expect(permissionLaunch('grok', 'bypass').args).toEqual(['--yolo']);
  });

  it('plan prompt prefix only for CLIs without a headless plan mode', () => {
    expect(planPromptPrefix('codex')).toMatch(/plan mode/);
    expect(planPromptPrefix('dsh')).toMatch(/plan mode/);
    expect(planPromptPrefix('claude')).toBeNull();
    expect(planPromptPrefix('grok')).toBeNull();
  });
});
