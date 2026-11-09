/** MiniMax Code 插件清单（纯数据；渲染进程也能 import） */
import type { CliManifest, HarnessPermissionMode } from '../manifest';

/** MiniMax Code ACP 会话模式（0.6.12 session/new 的 availableModes）：只有 plan 与 default（逐项确认） */
export const MINIMAX_MODES: readonly HarnessPermissionMode[] = ['plan', 'manual'];

export const minimaxModeId = (mode: HarnessPermissionMode): string =>
  mode === 'plan' ? 'plan' : 'default';

export const manifest: CliManifest = {
  id: 'minimax',
  apiVersion: 1,
  displayName: 'MiniMax Code',
  icon: 'minimax',
  binary: {
    names: ['mcode'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)',
    install: { npm: '@minimax-ai/code', url: 'https://agent.minimax.io/docs/cli/quick-start' },
  },
  // 只有 ACP（mcode acp）；档位经 session/set_mode 设置。第三方模型写在私有 config.yaml 里，换模型要重启后续接会话
  transport: 'acp',
  ingress: 'chat',
  capabilities: {
    officialAccount: true,
    thirdParty: true,
    images: 'native',
    permissionModes: MINIMAX_MODES.map((mode) => ({ mode, modeId: minimaxModeId(mode) })),
    subagents: false,
    slashCommands: false,
    resume: true,
    fork: false,
    usageQuota: false,
    progressMonitor: false,
    terminalCommand: true,
  },
  modelSwitch: 'restart',
  clientSpec: { client: 'minimax' },
};
