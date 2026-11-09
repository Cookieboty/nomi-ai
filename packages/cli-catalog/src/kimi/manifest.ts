/** Kimi Code 插件清单（纯数据；渲染进程也能 import） */
import type { CliManifest, HarnessPermissionMode } from '../manifest';

/**
 * Kimi Code ACP 会话模式（2.5.2 session/new 的 availableModes）：plan / default（逐项确认）/
 * yolo（日常改动与命令自动、危险操作仍询问）/ auto（全部自动）。没有「只自动改文件」这一档。
 */
export const KIMI_MODES: readonly HarnessPermissionMode[] = ['plan', 'manual', 'auto', 'bypass'];

export const kimiModeId = (mode: HarnessPermissionMode): string =>
  mode === 'plan' ? 'plan' : mode === 'auto' ? 'yolo' : mode === 'bypass' ? 'auto' : 'default';

export const manifest: CliManifest = {
  id: 'kimi',
  apiVersion: 1,
  displayName: 'Kimi Code',
  icon: 'kimi',
  binary: {
    names: ['kimi'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)',
    install: { npm: '@moonshot-ai/kimi-code', url: 'https://github.com/MoonshotAI/kimi-code' },
  },
  // 只有 ACP（kimi acp）；档位经 session/set_mode 设置。第三方模型写在私有 config.toml 里，换模型要重启后续接会话
  transport: 'acp',
  ingress: 'chat',
  capabilities: {
    officialAccount: true,
    thirdParty: true,
    images: 'native',
    permissionModes: KIMI_MODES.map((mode) => ({ mode, modeId: kimiModeId(mode) })),
    subagents: false,
    slashCommands: false,
    resume: true,
    history: false,
    fork: false,
    usageQuota: false,
    progressMonitor: false,
    terminalCommand: true,
  },
  modelSwitch: 'restart',
  clientSpec: { client: 'kimi' },
  configPath: '~/.kimi-code/config.toml',
  host: { minNode: 22, vendor: 'moonshot', acpArgs: ['acp'] },
};
