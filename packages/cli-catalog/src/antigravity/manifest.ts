/** Antigravity CLI（`agy`）插件清单（纯数据；渲染进程也能 import） */
import type { CliManifest, HarnessPermissionMode } from '../manifest';

/**
 * Antigravity CLI ACP 会话模式：plan / default（逐项确认）/ accept-edits / auto（沙箱内自动编辑与安全命令）。
 */
export const ANTIGRAVITY_MODES: readonly HarnessPermissionMode[] = [
  'plan',
  'manual',
  'acceptEdits',
  'auto',
];

export const antigravityModeId = (mode: HarnessPermissionMode): string =>
  mode === 'plan'
    ? 'plan'
    : mode === 'acceptEdits'
      ? 'accept-edits'
      : mode === 'auto'
        ? 'auto'
        : 'default';

export const manifest: CliManifest = {
  id: 'antigravity',
  apiVersion: 1,
  displayName: 'Antigravity',
  icon: 'antigravity',
  binary: {
    names: ['agy'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)',
    install: {
      script: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      url: 'https://antigravity.google/docs/cli/reference',
    },
  },
  // 只有 ACP（agy acp）；复用本机登录与 ~/.gemini/antigravity-cli/settings.json
  transport: 'acp',
  ingress: 'gemini',
  capabilities: {
    officialAccount: false,
    thirdParty: false,
    images: 'native',
    permissionModes: ANTIGRAVITY_MODES.map((mode) => ({
      mode,
      modeId: antigravityModeId(mode),
    })),
    subagents: false,
    slashCommands: false,
    resume: true,
    history: false,
    fork: false,
    usageQuota: false,
    progressMonitor: false,
    terminalCommand: true,
  },
  modelSwitch: 'inplace',
  clientSpec: { client: 'antigravity' },
  fullName: 'Antigravity CLI',
  configPath: '~/.gemini/antigravity-cli/settings.json',
  host: {
    selfUpdate: 'always',
    vendor: 'google',
    acpArgs: ['acp'],
    planFollowUp: true,
    homeEnv: 'ANTIGRAVITY_CLI_HOME',
    homeDirs: ['.gemini/antigravity-cli', '.gemini/antigravity'],
    execConfig: [
      '.gemini/antigravity-cli/settings.json',
      '.gemini/antigravity/mcp_config.json',
      '.gemini/antigravity/plugins',
    ],
  },
};
