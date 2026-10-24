/**
 * Claude Code 插件的主进程实现（只依赖 node:* 与 @nomi-ai/cli-sdk，不 import electron）。
 * 会话协议走 cli-sdk 的 stream-json 驱动；转录解析、斜杠发现仍在主进程，由宿主挂到契约上。
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
} from '@nomi-ai/cli-sdk';

import { USAGE_DONE } from '../shared/exec';
import { cliHome } from '../shared/homes';
import { CLAUDE_MODE, modeFromNative, PERMISSION_MODES } from '../shared/permissions';
import { readdir, statAll, yieldAll } from '../shared/scan';

import { manifest } from './manifest';

export { manifest };

export const HOME_ENV = 'CLAUDE_CONFIG_DIR';

/** 用户自己的 Claude 配置目录（尊重 CLAUDE_CONFIG_DIR） */
export const userHome = (env: NodeJS.ProcessEnv, home: string) =>
  cliHome(HOME_ENV, '.claude', env, home);

export const permissions: PermissionCapability = {
  supported: PERMISSION_MODES,
  launch: (mode: HarnessPermissionMode) => ({
    args: ['--permission-mode', CLAUDE_MODE[mode]],
    env: {},
  }),
  modeId: (mode) => CLAUDE_MODE[mode],
  fromModeId: (id) => modeFromNative(PERMISSION_MODES, id),
};

/** 官方账号（§5.10）：一个账号 = 一个 CLAUDE_CONFIG_DIR；登录由 CLI 自己完成 */
export const accounts: AccountCapability = {
  homeEnv: HOME_ENV,
  strip: [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    'ANTHROPIC_PROFILE',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CONFIG_DIR',
  ],
  shared: [
    { name: 'projects', dir: true, createIfMissing: true },
    { name: 'history.jsonl', dir: false },
    { name: 'CLAUDE.md', dir: false },
    { name: 'keybindings.json', dir: false },
    { name: 'skills', dir: true },
    { name: 'commands', dir: true },
    { name: 'agents', dir: true },
    { name: 'rules', dir: true },
    { name: 'output-styles', dir: true },
    { name: 'todos', dir: true },
  ],
  loginArgs: ['auth', 'login', '--claudeai'],
  logoutArgs: ['auth', 'logout'],
  statusArgs: ['auth', 'status', '--json'],
};

/** 会话：<配置目录>/projects/<工作目录编码>/<会话 id>.jsonl */
export const history: HistoryCapability = {
  roots: (env, home) => [path.join(userHome(env, home), 'projects')],
  scan: (root) =>
    yieldAll(
      (async () => {
        const files: Array<{ path: string }> = [];
        for (const dir of await readdir(root)) {
          if (!dir.isDirectory()) continue;
          for (const f of await readdir(path.join(root, dir.name)))
            if (f.isFile() && f.name.endsWith('.jsonl'))
              files.push({ path: path.join(root, dir.name, f.name) });
        }
        return statAll(files);
      })(),
    ),
  resume: (sessionId) => ({ args: ['--resume', sessionId] }),
};

/** 官方启动注入：账号目录变量、剔除继承的路由 / 鉴权变量、档位与模型参数 */
export function officialLaunch(ctx: LaunchContext) {
  return {
    env: ctx.accountDir
      ? { [HOME_ENV]: ctx.accountDir, CLAUDE_CODE_DISABLE_AGENT_VIEW: '1' }
      : ({} as Record<string, string>),
    args: [
      ...permissions.launch(ctx.permissionMode).args,
      ...(ctx.model ? ['--model', ctx.model] : []),
    ],
    strip: accounts.strip.filter((k) => ctx.accountDir || k !== HOME_ENV),
  };
}

/** 每轮一个进程的退路（exec）怎样才算整轮完成 */
export const execRules = USAGE_DONE;

export function createMain(): CliMainImpl {
  return {
    session: { exec: execRules },
    launch: { official: officialLaunch },
    permissions,
    accounts,
    history,
    progress: { watchRoots: (env, home) => [path.join(userHome(env, home), 'projects')] },
    usage: { logRoots: (env, home) => [path.join(userHome(env, home), 'projects')] },
    terminal: {
      command: (o) => ({
        command: 'claude',
        args: o.resumeId ? ['--resume', o.resumeId] : [],
      }),
    },
  };
}

export const plugin = defineCliPlugin({ manifest, main: () => createMain() });
