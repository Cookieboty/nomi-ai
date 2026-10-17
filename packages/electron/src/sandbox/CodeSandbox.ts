import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CodeLanguage, CodeRunResult, CodeSandboxApi } from '../desktop/p3tools';

const MAX_OUT = 20_000;

/** 运行环境的最小化环境变量：不继承 API key、令牌等 */
export function minimalEnv(tmp: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ['PATH', 'SYSTEMROOT', 'WINDIR', 'LANG', 'TZ'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return { ...env, HOME: tmp, USERPROFILE: tmp, TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...extra };
}

/**
 * 代码执行器（自研，隔离程度因语言而异）：
 * - JavaScript：用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE）+ Node 权限模型 `--permission`，
 *   只允许读写本次的临时目录，禁止子进程 / worker / 原生插件
 * - Python：系统 python3，`-I`（只是 Python 自身的「隔离模式」：忽略用户 site / 环境变量，**不是**安全隔离），
 *   在临时目录里运行。**没有系统级隔离**——代码以当前用户权限运行，可读写用户文件、访问网络。
 *   真正的平台沙箱（sandbox-exec / bwrap / AppContainer）尚未实现，因此上层必须对 Python 二次确认并如实告知。
 * - 共同：最小化环境变量、超时强制终止、输出截断、运行后删除临时目录
 */
export class CodeSandbox implements CodeSandboxApi {
  private pyCache: string | null | undefined;

  constructor(private readonly opts: { nodeBin?: string; runAsNode?: boolean } = {}) {}

  private python(): string | null {
    if (this.pyCache !== undefined) return this.pyCache;
    for (const c of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
      try {
        const r = spawnSync(c, ['-c', 'import sys;print(sys.version_info[0])'], { timeout: 4000 });
        if (r.status === 0 && String(r.stdout).trim() === '3') return (this.pyCache = c);
      } catch {
        /* ignore */
      }
    }
    return (this.pyCache = null);
  }

  async available(): Promise<CodeLanguage[]> {
    const out: CodeLanguage[] = ['javascript'];
    if (this.python()) out.push('python');
    return out;
  }

  async run(
    lang: CodeLanguage,
    code: string,
    opts: { timeoutMs: number; stdin?: string },
    signal?: AbortSignal,
  ): Promise<CodeRunResult> {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-sbx-')));
    const t0 = Date.now();
    try {
      let cmd: string;
      let args: string[];
      let env: NodeJS.ProcessEnv;
      if (lang === 'javascript') {
        const file = path.join(tmp, 'main.cjs');
        fs.writeFileSync(file, code);
        cmd = this.opts.nodeBin ?? process.execPath;
        args = [
          '--permission',
          `--allow-fs-read=${tmp}`,
          `--allow-fs-write=${tmp}`,
          '--disallow-code-generation-from-strings',
          '--max-old-space-size=256',
          file,
        ];
        env = minimalEnv(tmp, this.opts.runAsNode === false ? {} : { ELECTRON_RUN_AS_NODE: '1' });
      } else {
        const py = this.python();
        if (!py) throw new Error('python unavailable');
        const file = path.join(tmp, 'main.py');
        fs.writeFileSync(file, code);
        cmd = py;
        args = ['-I', file];
        env = minimalEnv(tmp, { PYTHONIOENCODING: 'utf-8' });
      }
      return await new Promise<CodeRunResult>((resolve) => {
        const child = spawn(cmd, args, { cwd: tmp, env, windowsHide: true });
        let stdout = '';
        let stderr = '';
        let truncated = false;
        let timedOut = false;
        const cap = (cur: string, chunk: Buffer) => {
          if (cur.length >= MAX_OUT) {
            truncated = true;
            return cur;
          }
          const s = cur + chunk.toString('utf8');
          if (s.length > MAX_OUT) truncated = true;
          return s.slice(0, MAX_OUT);
        };
        child.stdout.on('data', (c: Buffer) => (stdout = cap(stdout, c)));
        child.stderr.on('data', (c: Buffer) => (stderr = cap(stderr, c)));
        const kill = () => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs);
        signal?.addEventListener('abort', kill, { once: true });
        child.on('error', (e) => {
          stderr += String(e.message);
        });
        child.on('close', (codeNum) => {
          clearTimeout(timer);
          resolve({ exitCode: codeNum, stdout, stderr, timedOut, truncated, ms: Date.now() - t0 });
        });
        if (opts.stdin) child.stdin.write(opts.stdin);
        child.stdin.end();
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}
