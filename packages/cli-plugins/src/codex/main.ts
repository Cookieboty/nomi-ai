/**
 * Codex 插件的主进程实现（只依赖 node:* 与 @nomi-ai/cli-sdk）。
 * 会话协议走 cli-sdk 的 app-server 驱动，起不来时退回 `codex exec`。
 */
import path from 'node:path';

import {
  defineCliPlugin,
  type AccountCapability,
  type CliMainImpl,
  type HarnessPermissionMode,
  type HistoryCapability,
  type LaunchContext,
  type PermissionCapability,
  type SlashDiscoveryCapability,
  type SlashSource,
} from '@nomi-ai/cli-sdk';

import { USAGE_DONE } from '../shared/exec';
import { cliHome } from '../shared/homes';
import { modeFromNative, PERMISSION_MODES, PLAN_PROMPT_PREFIX } from '../shared/permissions';
import { statAll, walkFiles, yieldAll } from '../shared/scan';
import { historyParse } from '../shared/transcript';

import { manifest } from './manifest';
import { modelArgs } from './models';
import { parseCodexTranscript } from './transcript';

export { manifest };
export { parseCodexTranscript };
export { modelArgs, parseCodexModels, readCodexConfigDefaults } from './models';

export const HOME_ENV = 'CODEX_HOME';

/** 账号目录里强制文件存储凭据（钥匙串条目不区分目录） */
const FILE_STORE = ['-c', 'cli_auth_credentials_store="file"'];

export const userHome = (env: NodeJS.ProcessEnv, home: string) =>
  cliHome(HOME_ENV, '.codex', env, home);

/**
 * 档位 → 启动参数。全部走 `-c`：`exec resume` 不接受 --sandbox / --approve-for-me。
 * 逐项确认在 exec 下没有审批通道：按只读跑，不悄悄放开写入。
 */
function launch(mode: HarnessPermissionMode, opts: { network?: boolean } = {}) {
  const sandbox =
    mode === 'plan' || mode === 'manual'
      ? 'read-only'
      : mode === 'bypass'
        ? 'danger-full-access'
        : 'workspace-write';
  const args = ['-c', `sandbox_mode="${sandbox}"`];
  if (sandbox === 'workspace-write' && opts.network !== false)
    args.push('-c', 'sandbox_workspace_write.network_access=true');
  if (mode === 'auto')
    args.push('-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"');
  return { args, env: {} as Record<string, string> };
}

export const permissions: PermissionCapability = {
  supported: PERMISSION_MODES,
  launch,
  // Codex 的 on-request 是「自动审批」
  fromModeId: (id) => modeFromNative(PERMISSION_MODES, id, { onRequest: 'auto' }),
  planPrefix: PLAN_PROMPT_PREFIX,
};

export const accounts: AccountCapability = {
  homeEnv: HOME_ENV,
  strip: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_HOME'],
  shared: [
    { name: 'sessions', dir: true, createIfMissing: true },
    { name: 'archived_sessions', dir: true },
    { name: 'config.toml', dir: false },
    { name: 'skills', dir: true },
    { name: 'prompts', dir: true },
    { name: 'AGENTS.md', dir: false },
  ],
  loginArgs: ['login', '--device-auth', ...FILE_STORE],
  logoutArgs: ['logout'],
  statusArgs: ['login', 'status'],
  accountArgs: FILE_STORE,
};

/** 会话：<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl(.zst)；archived_sessions/ 不列出 */
export const history: HistoryCapability = {
  roots: (env, home) => [path.join(userHome(env, home), 'sessions')],
  scan: (root) =>
    yieldAll(walkFiles(root, 4, (n) => /^rollout-.*\.jsonl(?:\.zst)?$/.test(n)).then(statAll)),
  parse: historyParse('codex', parseCodexTranscript),
  resume: (sessionId) => ({ args: ['resume', sessionId], loadSession: true }),
};

export function officialLaunch(ctx: LaunchContext) {
  return {
    env: ctx.accountDir ? { [HOME_ENV]: ctx.accountDir } : ({} as Record<string, string>),
    args: [
      ...(ctx.accountDir ? FILE_STORE : []),
      ...launch(ctx.permissionMode).args,
      ...(ctx.model ? ['-c', `model="${ctx.model}"`] : []),
    ],
    strip: accounts.strip.filter((k) => ctx.accountDir || k !== HOME_ENV),
  };
}

/** 每轮一个进程的退路（exec）怎样才算整轮完成 */
export const execRules = USAGE_DONE;

/** 斜杠命令的公开布局：项目与用户级 .agents/skills */
export const slash: SlashDiscoveryCapability = {
  sources: ({ projectChain, home }) => [
    ...projectChain.map((dir): SlashSource => ({
      kind: 'skills',
      path: path.join(dir, '.agents', 'skills'),
      scope: 'project',
    })),
    { kind: 'skills', path: path.join(home, '.agents', 'skills'), scope: 'user' },
  ],
};

export function createMain(): CliMainImpl {
  return {
    session: { exec: execRules },
    slash,
    launch: { official: officialLaunch, modelArgs },
    permissions,
    accounts,
    history,
    progress: { watchRoots: (env, home) => [path.join(userHome(env, home), 'sessions')] },
    usage: { logRoots: (env, home) => [path.join(userHome(env, home), 'sessions')] },
    terminal: {
      command: (o) => ({ command: 'codex', args: o.resumeId ? ['resume', o.resumeId] : [] }),
    },
  };
}

export const plugin = defineCliPlugin({ manifest, main: () => createMain() });
