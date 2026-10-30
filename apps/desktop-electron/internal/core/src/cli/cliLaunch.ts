import path from 'node:path';

import { resolveCliLaunch } from '../usage/limitedProcess';

import { resolveNodeBin, windowsExecutable, withCliPath } from './detect';

export interface HarnessLaunch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** cmd.exe /c 时必须原样传递已加引号的参数 */
  verbatim: boolean;
}

/**
 * 把探测到的 CLI 路径变成 Node 能 spawn 的命令。
 * Windows 上 npm 的无扩展名脚本会先换成旁边的 `.cmd`，再解开成 `node.exe + 入口脚本`，
 * 这样对话参数走 argv，stdin 也能立刻 EOF。解不开时才退回 `cmd.exe /c`。
 */
export function resolveHarnessLaunch(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  nodeBin?: string | null,
): HarnessLaunch {
  const bin = windowsExecutable(command, platform);
  const launch = resolveCliLaunch(bin, args, env, platform);
  if (!launch) return { file: bin, args, env, verbatim: false };
  if (launch.via === 'node-script') {
    const resolved = nodeBin === undefined ? resolveNodeBin() : nodeBin;
    const file = path.isAbsolute(launch.file) ? launch.file : (resolved ?? launch.file);
    return { file, args: launch.args, env: withCliPath(env), verbatim: false };
  }
  return {
    file: launch.file,
    args: launch.args,
    env,
    verbatim: launch.via === 'cmd-shim',
  };
}
