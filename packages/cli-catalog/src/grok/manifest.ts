/** Grok Build 插件清单（纯数据；渲染进程也能 import） */
import type { CliManifest, HarnessPermissionMode } from '../manifest';
import { CLAUDE_MODE } from '../shared/permissions';

/** ACP 会话模式只有 plan / default / acceptEdits / bypassPermissions / dontAsk。
 * 没有像 Codex auto_review 那样能自己判断风险的档：「自动」落到 acceptEdits（自动接受文件编辑、
 * 其余动作仍按本地权限逻辑判断），而不是 bypass（那等于完全放开）。 */
export const GROK_MODES: readonly HarnessPermissionMode[] = [
  'plan',
  'manual',
  'acceptEdits',
  'auto',
  'bypass',
];

/** ACP session/set_mode 的 mode id（1.0.62 实测；不认识的 id 也回 {}，所以只发这里列出的） */
export const grokModeId = (mode: HarnessPermissionMode): string =>
  mode === 'manual' ? 'default' : mode === 'auto' ? 'acceptEdits' : CLAUDE_MODE[mode];

/** 无头模式的启动参数：只有完全放开才是 --yolo */
export const grokModeArgs = (mode: HarnessPermissionMode): string[] =>
  mode === 'bypass'
    ? ['--yolo']
    : ['--permission-mode', mode === 'auto' ? 'acceptEdits' : CLAUDE_MODE[mode]];

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
    history: true,
    fork: false,
    usageQuota: true,
    progressMonitor: true,
    terminalCommand: true,
    steer: true,
  },
  // 占位模型名 nomi：第三方换模型只改绑定；官方仍按 ACP set_model 原地切
  modelSwitch: 'gateway',
  clientSpec: { client: 'grok', placeholderModel: 'nomi' },
  configPath: '~/.grok/config.toml',
  host: {
    minNode: 18,
    selfUpdate: 'always',
    vendor: 'xai',
    acpArgs: ['agent', 'stdio'],
    planFollowUp: true,
    nomiCommand: true,
    homeEnv: 'GROK_HOME',
    homeDirs: ['.grok'],
  },
};
