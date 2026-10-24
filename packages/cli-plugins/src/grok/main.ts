/**
 * Grok 插件的主进程实现（只依赖 node:* 与 @nomi-ai/cli-sdk）。
 * 会话协议走 cli-sdk 的 ACP 驱动（grok agent stdio），起不来时退回 grok -p。
 */
import path from 'node:path';

import {
  defineCliPlugin,
  type AccountCapability,
  type CliMainImpl,
  type HistoryCapability,
  type LaunchContext,
  type PermissionCapability,
} from '@nomi-ai/cli-sdk';

import { USAGE_DONE } from '../shared/exec';
import { cliHome } from '../shared/homes';
import { modeFromNative } from '../shared/permissions';
import { statAll, walkFiles, yieldAll } from '../shared/scan';

import { GROK_MODES, grokModeArgs, grokModeId, manifest } from './manifest';

export { manifest };

export const HOME_ENV = 'GROK_HOME';

export const userHome = (env: NodeJS.ProcessEnv, home: string) =>
  cliHome(HOME_ENV, '.grok', env, home);

export const permissions: PermissionCapability = {
  supported: GROK_MODES,
  launch: (mode) => ({ args: grokModeArgs(mode), env: {} }),
  modeId: grokModeId,
  fromModeId: (id) => modeFromNative(GROK_MODES, id),
};

export const accounts: AccountCapability = {
  homeEnv: HOME_ENV,
  strip: ['XAI_API_KEY', 'GROK_API_KEY', 'GROK_HOME'],
  shared: [
    { name: 'sessions', dir: true, createIfMissing: true },
    { name: 'config.toml', dir: false },
    { name: 'installed-plugins', dir: true },
    { name: 'memory-v2', dir: true },
    { name: 'bin', dir: true },
    { name: 'bundled', dir: true },
  ],
  loginArgs: ['login', '--device-auth'],
  logoutArgs: ['logout'],
};

/** 会话：<GROK_HOME>/sessions/…/<会话 id>/updates.jsonl（dirId = 会话目录名） */
export const history: HistoryCapability = {
  roots: (env, home) => [path.join(userHome(env, home), 'sessions')],
  scan: (root) =>
    yieldAll(walkFiles(root, 4, (n) => n === 'updates.jsonl', { dirId: true }).then(statAll)),
  resume: (sessionId) => ({ args: ['--resume', sessionId], loadSession: true }),
};

export function officialLaunch(ctx: LaunchContext) {
  return {
    env: ctx.accountDir ? { [HOME_ENV]: ctx.accountDir } : ({} as Record<string, string>),
    args: [...grokModeArgs(ctx.permissionMode), ...(ctx.model ? ['-m', ctx.model] : [])],
    strip: accounts.strip.filter((k) => ctx.accountDir || k !== HOME_ENV),
  };
}

/** 每轮一个进程的退路（exec）怎样才算整轮完成 */
export const execRules = USAGE_DONE;

export function createMain(): CliMainImpl {
  return {
    session: { exec: execRules },
    launch: { official: officialLaunch, placeholderModel: 'nomi' },
    permissions,
    accounts,
    history,
    progress: { watchRoots: (env, home) => [path.join(userHome(env, home), 'sessions')] },
    usage: { logRoots: (env, home) => [path.join(userHome(env, home), 'sessions')] },
    terminal: {
      command: (o) => ({ command: 'grok', args: o.resumeId ? ['--resume', o.resumeId] : [] }),
    },
  };
}

export const plugin = defineCliPlugin({ manifest, main: () => createMain() });
