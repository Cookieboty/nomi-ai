/**
 * 从 Dock / Finder / 桌面启动的应用拿到的 PATH 很短（macOS 通常只有 /usr/bin:/bin:/usr/sbin:/sbin），
 * 用户在 .zshrc / .bashrc 里配的 nvm、volta、fnm、asdf、mise、自定义 npm prefix 等都看不到（#76）。
 * 启动时用登录交互 shell 读一次真正的 PATH，追加到 process.env.PATH 后面（只补不删，原有顺序优先）。
 * 读不到（超时 / 没有 shell / Windows）就保持原样，探测时还有 detect.ts 的兜底目录。
 */
import { execFile } from 'node:child_process';
import path from 'node:path';

const START = '__NOMI_PATH_START__';
const END = '__NOMI_PATH_END__';
const TIMEOUT_MS = 4000;

/** 从 shell 输出里取出标记之间的 PATH（rc 文件可能打印欢迎语、版本提示等，忽略） */
export function parseShellPath(out: string): string | null {
  const i = out.lastIndexOf(START);
  if (i < 0) return null;
  const j = out.indexOf(END, i + START.length);
  if (j < 0) return null;
  const value = out.slice(i + START.length, j).trim();
  return value || null;
}

/** 把 extra 里新出现的目录按原顺序追加到 cur 后面（去重，去空） */
export function mergePath(cur: string, extra: string, delimiter = path.delimiter): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [...cur.split(delimiter), ...extra.split(delimiter)]) {
    const dir = d.trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out.join(delimiter);
}

function readLoginShellPath(shell: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s' "${START}\${PATH}${END}"`],
      {
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        windowsHide: true,
        // oh-my-zsh 等在交互 shell 里会检查更新 / 弹提示：关掉，避免拖慢或卡住
        env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_DISABLE_COMPFIX: 'true' },
      },
      (err, stdout) => resolve(err && !stdout ? null : parseShellPath(String(stdout))),
    );
  });
}

let ready: Promise<void> | null = null;

/**
 * 启动时调用一次（幂等）。返回的 Promise 不会 reject；探测 CLI 的异步路径会等它（见 waitForShellPath）。
 * @param onMerged PATH 有新增目录时回调（清掉「未找到」的探测缓存）
 */
export function loadLoginShellPath(onMerged?: (added: string[]) => void): Promise<void> {
  if (ready) return ready;
  if (process.platform === 'win32') return (ready = Promise.resolve());
  const shell =
    process.env.SHELL?.trim() || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  ready = readLoginShellPath(shell)
    .then((value) => {
      if (!value) return;
      const before = process.env.PATH ?? '';
      const merged = mergePath(before, value);
      if (merged === before) return;
      const had = new Set(before.split(path.delimiter));
      process.env.PATH = merged;
      onMerged?.(merged.split(path.delimiter).filter((d) => !had.has(d)));
    })
    .catch(() => undefined);
  return ready;
}

/** 异步探测前等登录 shell 的 PATH（最多 ms 毫秒；没启动过就不等） */
export async function waitForShellPath(ms = TIMEOUT_MS + 500): Promise<void> {
  if (!ready) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    ready,
    new Promise<void>((r) => {
      timer = setTimeout(r, ms);
    }),
  ]);
  clearTimeout(timer);
}

/** 测试用 */
export function resetShellPathForTest(): void {
  ready = null;
}
