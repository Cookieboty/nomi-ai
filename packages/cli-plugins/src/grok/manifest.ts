/** Grok Build 插件清单（纯数据；渲染进程也能 import） */
import type { CliManifest, HarnessPermissionMode } from '@nomi-ai/cli-sdk';

import { CLAUDE_MODE } from '../shared/permissions';

/** ACP 会话模式只有 plan / default / acceptEdits / bypassPermissions / dontAsk，没有「自动」 */
export const GROK_MODES: readonly HarnessPermissionMode[] = [
  'plan',
  'manual',
  'acceptEdits',
  'bypass',
];

/** ACP session/set_mode 的 mode id（1.0.62 实测；不认识的 id 也回 {}，所以只发这里列出的） */
export const grokModeId = (mode: HarnessPermissionMode): string =>
  mode === 'manual' || mode === 'auto' ? 'default' : CLAUDE_MODE[mode];

/** 无头模式的启动参数：完全放开为 --yolo */
export const grokModeArgs = (mode: HarnessPermissionMode): string[] =>
  mode === 'bypass' ? ['--yolo'] : ['--permission-mode', CLAUDE_MODE[mode]];

export const manifest: CliManifest = {
  id: 'grok',
  apiVersion: 1,
  displayName: 'Grok',
  icon: 'grok',
  binary: {
    names: ['grok'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)',
    install: { npm: '@xai-official/grok', url: 'https://docs.x.ai/build/cli' },
  },
  // 长驻会话：grok agent stdio（ACP）；退路：grok -p（streaming-json）
  transport: 'acp',
  fallbackTransport: 'exec',
  ingress: 'responses',
  capabilities: {
    officialAccount: true,
    thirdParty: true,
    images: 'native',
    permissionModes: GROK_MODES.map((mode) => ({
      mode,
      args: grokModeArgs(mode),
      modeId: grokModeId(mode),
    })),
    subagents: false,
    slashCommands: true,
    resume: true,
    fork: false,
    usageQuota: true,
    progressMonitor: true,
    terminalCommand: true,
  },
  modelSwitch: 'inplace',
  clientSpec: { client: 'grok', placeholderModel: 'nomi' },
};
