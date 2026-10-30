/** dsh（DeepSeek）插件清单（纯数据；渲染进程也能 import） */
import type { CliManifest, HarnessPermissionMode } from '../manifest';

/** 无头模式没有可回写的审批事件 → 无「逐项确认」；没有自动审批 → 无「自动」 */
export const DSH_MODES: readonly HarnessPermissionMode[] = ['plan', 'acceptEdits', 'bypass'];

export const manifest: CliManifest = {
  id: 'dsh',
  apiVersion: 1,
  displayName: 'dsh',
  icon: 'dsh',
  binary: {
    names: ['dsh'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)',
    install: { npm: '@deepseek-ai/dsh' },
  },
  // 每轮一个进程：dsh --profile headless --json
  transport: 'exec',
  ingress: 'responses',
  capabilities: {
    officialAccount: false,
    thirdParty: true,
    images: 'none',
    // 档位经环境变量 DSH_PERMISSION_MODE 设置
    permissionModes: DSH_MODES.map((mode) => ({ mode })),
    subagents: true,
    slashCommands: false,
    resume: true,
    fork: false,
    usageQuota: false,
    progressMonitor: true,
    terminalCommand: false,
  },
  // 模型写在只给这个进程用的叠加配置里（--patch），换模型要重启
  modelSwitch: 'restart',
  clientSpec: { client: 'dsh' },
};
