/** Gemini CLI 插件清单（纯数据；渲染进程也能 import） */
import type { CliManifest, HarnessPermissionMode } from '@nomi-ai/cli-sdk';

/** Gemini ACP：plan / default（可审批）/ autoEdit / yolo；没有「自动」（降为自动改文件） */
export const GEMINI_MODES: readonly HarnessPermissionMode[] = [
  'plan',
  'manual',
  'acceptEdits',
  'bypass',
];

/** ACP 会话模式 id（0.62.0 session/new 返回的 availableModes） */
export const geminiModeId = (mode: HarnessPermissionMode): string =>
  mode === 'plan'
    ? 'plan'
    : mode === 'acceptEdits' || mode === 'auto'
      ? 'autoEdit'
      : mode === 'bypass'
        ? 'yolo'
        : 'default';

export const manifest: CliManifest = {
  id: 'gemini',
  apiVersion: 1,
  displayName: 'Gemini',
  icon: 'gemini',
  binary: {
    names: ['gemini'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)',
    install: { npm: '@google/gemini-cli', url: 'https://github.com/google-gemini/gemini-cli' },
  },
  // 只有 ACP（gemini --acp）；档位经 session/set_mode 设置，启动参数不带
  transport: 'acp',
  ingress: 'gemini',
  capabilities: {
    officialAccount: true,
    thirdParty: true,
    images: 'native',
    permissionModes: GEMINI_MODES.map((mode) => ({ mode, modeId: geminiModeId(mode) })),
    subagents: false,
    slashCommands: true,
    resume: true,
    fork: false,
    usageQuota: false,
    progressMonitor: true,
    terminalCommand: true,
  },
  modelSwitch: 'inplace',
  clientSpec: { client: 'gemini' },
};
