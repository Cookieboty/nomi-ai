/**
 * Gemini 插件的主进程实现（只依赖 node:* 与 @nomi-ai/cli-sdk）。会话协议走 cli-sdk 的 ACP 驱动。
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
import { geminiRoot } from '../shared/homes';
import { modeFromNative } from '../shared/permissions';
import { readdir, statAll, yieldAll } from '../shared/scan';

import { GEMINI_MODES, geminiModeId, manifest } from './manifest';

export { manifest };

/** GEMINI_CLI_HOME 指向「放 .gemini 的主目录」（账号目录本身） */
export const HOME_ENV = 'GEMINI_CLI_HOME';

/** 用户的 .gemini 所在主目录 */
export const userHome = (env: NodeJS.ProcessEnv, home: string) => geminiRoot(env, home);

export const permissions: PermissionCapability = {
  supported: GEMINI_MODES,
  // 模式经 ACP session/set_mode 设置，启动参数不带
  launch: () => ({ args: [], env: {} }),
  modeId: geminiModeId,
  fromModeId: (id) => modeFromNative(GEMINI_MODES, id),
};

export const accounts: AccountCapability = {
  homeEnv: HOME_ENV,
  strip: [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GEMINI_BASE_URL',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GEMINI_CLI_HOME',
    'GEMINI_FORCE_ENCRYPTED_FILE_STORAGE',
    'GEMINI_FORCE_ENCRYPTED_FILE',
  ],
  // 共享条目相对账号目录（CLI 在其中建 .gemini/）
  shared: [
    { name: '.gemini/tmp', dir: true, createIfMissing: true },
    { name: '.gemini/settings.json', dir: false },
    { name: '.gemini/GEMINI.md', dir: false },
    { name: '.gemini/commands', dir: true },
    { name: '.gemini/extensions', dir: true },
    { name: '.gemini/trustedFolders.json', dir: false },
    { name: '.gemini/projects.json', dir: false },
  ],
  // 没有 login 子命令：起 ACP 进程后调用 authenticate（oauth-personal），由 CLI 自己开浏览器；没有登出命令
  loginArgs: ['--acp'],
};

/** 会话：<主目录>/.gemini/tmp/<项目>/chats/session-*.jsonl；子代理在 chats/<父会话 id>/ 下，不列出 */
export const history: HistoryCapability = {
  roots: (env, home) => [path.join(userHome(env, home), '.gemini', 'tmp')],
  scan: (root) =>
    yieldAll(
      (async () => {
        const files: Array<{ path: string }> = [];
        for (const proj of await readdir(root)) {
          if (!proj.isDirectory()) continue;
          const chats = path.join(root, proj.name, 'chats');
          for (const f of await readdir(chats))
            if (f.isFile() && /^session-.*\.jsonl?$/.test(f.name))
              files.push({ path: path.join(chats, f.name) });
        }
        return statAll(files);
      })(),
    ),
  resume: (sessionId) => ({ args: ['--resume', sessionId], loadSession: true }),
};

export function officialLaunch(ctx: LaunchContext) {
  return {
    env: ctx.accountDir ? { [HOME_ENV]: ctx.accountDir } : ({} as Record<string, string>),
    args: ctx.model ? ['-m', ctx.model] : [],
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
    progress: { watchRoots: (env, home) => [path.join(userHome(env, home), '.gemini', 'tmp')] },
    terminal: {
      command: (o) => ({ command: 'gemini', args: o.resumeId ? ['--resume', o.resumeId] : [] }),
    },
  };
}

export const plugin = defineCliPlugin({ manifest, main: () => createMain() });
