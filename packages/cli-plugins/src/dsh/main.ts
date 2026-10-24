/**
 * dsh 插件的主进程实现（只依赖 node:* 与 @nomi-ai/cli-sdk）。每轮一个进程（exec 驱动）。
 */
import path from 'node:path';

import {
  defineCliPlugin,
  type CliMainImpl,
  type ExecRules,
  type HarnessPermissionMode,
  type HistoryCapability,
  type LaunchContext,
  type PermissionCapability,
} from '@nomi-ai/cli-sdk';

import { cliHome } from '../shared/homes';
import { modeFromNative, PLAN_PROMPT_PREFIX } from '../shared/permissions';
import { readdir, statAll, yieldAll } from '../shared/scan';

import { DSH_MODES, manifest } from './manifest';

export { manifest };

export const HOME_ENV = 'DSH_HOME';

export const userHome = (env: NodeJS.ProcessEnv, home: string) =>
  cliHome(HOME_ENV, '.dsh', env, home);

function launch(mode: HarnessPermissionMode) {
  const sandbox =
    mode === 'plan' ? 'read-only' : mode === 'bypass' ? 'danger-full-access' : 'workspace-write';
  return { args: [] as string[], env: { DSH_PERMISSION_MODE: sandbox } };
}

export const permissions: PermissionCapability = {
  supported: DSH_MODES,
  launch,
  fromModeId: (id) => modeFromNative(DSH_MODES, id),
  planPrefix: PLAN_PROMPT_PREFIX,
};

/** 会话：<DSH_HOME>/sessions/<工作目录>/session-<uuid>/session.v4.jsonl(.zstd)（dirId = 会话目录名） */
export const history: HistoryCapability = {
  roots: (env, home) => [path.join(userHome(env, home), 'sessions')],
  scan: (root) =>
    yieldAll(
      (async () => {
        const files: Array<{ path: string; dirId: string }> = [];
        for (const proj of await readdir(root)) {
          if (!proj.isDirectory()) continue;
          for (const s of await readdir(path.join(root, proj.name))) {
            if (!s.isDirectory() || !s.name.startsWith('session-')) continue;
            const dir = path.join(root, proj.name, s.name);
            const f = (await readdir(dir)).find(
              (x) => x.isFile() && /^session\.v\d+\.jsonl/.test(x.name),
            );
            if (f) files.push({ path: path.join(dir, f.name), dirId: s.name });
          }
        }
        return statAll(files);
      })(),
    ),
  resume: (sessionId) => ({ args: ['--session-id', sessionId] }),
};

export function officialLaunch(ctx: LaunchContext) {
  const p = launch(ctx.permissionMode);
  return { env: p.env, args: ['--profile', 'headless', '--json'], strip: [] as string[] };
}

/**
 * dsh 的收尾：带用量的 done，或 final（done 且不带会话 id）算整轮完成；
 * Node 太旧时 dsh 不报错、无输出、退出码 0，要按失败处理。
 */
export const execRules: ExecRules = {
  completes: (ev) => ev.type === 'done' && (!!ev.usage || !ev.sessionId),
  silentExitIsError: true,
};

export function createMain(): CliMainImpl {
  return {
    session: { exec: execRules },
    launch: { official: officialLaunch },
    permissions,
    history,
    progress: { watchRoots: (env, home) => [path.join(userHome(env, home), 'sessions')] },
    usage: { logRoots: (env, home) => [path.join(userHome(env, home), 'sessions')] },
  };
}

export const plugin = defineCliPlugin({ manifest, main: () => createMain() });
