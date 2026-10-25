/** Codex 插件清单（纯数据；渲染进程也能 import） */
import type { CliManifest } from '@nomi-ai/cli-sdk';

import { PERMISSION_MODES } from '../shared/permissions';

export const manifest: CliManifest = {
  id: 'codex',
  apiVersion: 1,
  displayName: 'Codex',
  icon: 'codex',
  binary: {
    names: ['codex'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)',
    install: { npm: '@openai/codex', url: 'https://github.com/openai/codex' },
  },
  transport: 'app-server',
  fallbackTransport: 'exec',
  ingress: 'responses',
  capabilities: {
    officialAccount: true,
    thirdParty: true,
    // localImage / --image：图片写到会话临时目录，传绝对路径
    images: 'path',
    // 档位全部经启动参数（-c sandbox_mode / approval_policy）设置
    permissionModes: PERMISSION_MODES.map((mode) => ({ mode })),
    // exec --json exposes collab_tool_call events which the plugin maps to
    // unified agent timeline events. app-server may omit the same details, so
    // the UI still treats the agent card as summary-only unless events arrive.
    subagents: true,
    slashCommands: true,
    resume: true,
    fork: false,
    usageQuota: true,
    progressMonitor: true,
    terminalCommand: true,
  },
  modelSwitch: 'inplace',
  clientSpec: { client: 'codex' },
};
