/** Claude Code 插件清单（纯数据；渲染进程也能 import） */
import type { CliManifest } from '@nomi-ai/cli-sdk';

import { CLAUDE_MODE, PERMISSION_MODES } from '../shared/permissions';

export const manifest: CliManifest = {
  id: 'claude',
  apiVersion: 1,
  displayName: 'Claude Code',
  icon: 'claude',
  binary: {
    names: ['claude'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)',
    install: { npm: '@anthropic-ai/claude-code', url: 'https://docs.claude.com/claude-code' },
  },
  transport: 'stream-json',
  fallbackTransport: 'exec',
  ingress: 'messages',
  capabilities: {
    officialAccount: true,
    thirdParty: true,
    images: 'native',
    permissionModes: PERMISSION_MODES.map((mode) => ({
      mode,
      args: ['--permission-mode', CLAUDE_MODE[mode]],
      modeId: CLAUDE_MODE[mode],
    })),
    subagents: true,
    slashCommands: true,
    resume: true,
    fork: false,
    usageQuota: true,
    progressMonitor: true,
    terminalCommand: true,
  },
  modelSwitch: 'inplace',
  clientSpec: { client: 'claude' },
};
