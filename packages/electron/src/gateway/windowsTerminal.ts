import type * as ChildProcess from 'node:child_process';
import type * as NodeFs from 'node:fs';
import type * as NodePath from 'node:path';

import type { ScriptInput } from './TerminalCommands';

/**
 * 生成独立 Node 脚本：不依赖 Electron / asar，配置与 argv 都作为数据处理。
 * 函数内部只引用 Node 内置模块，编译后可直接序列化到用户的命令目录。
 */
async function run(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs: typeof NodeFs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path: typeof NodePath = require('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawn }: typeof ChildProcess = require('node:child_process');
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as ScriptInput & {
    messages: Record<string, string>;
  };
  const fail = (message: string, code = 1) => {
    console.error(message);
    process.exitCode = code;
  };
  if (!config.model || !config.launch) return fail(config.messages.noModel);
  // PowerShell 把 5、$true 这类参数保留为数字 / 布尔，JSON 里不是字符串；按 PowerShell 传给原生程序的写法转成字符串。
  const fromPs = (): string[] => {
    const raw: unknown = JSON.parse(process.env.NOMI_TERMINAL_ARGS ?? '[]');
    return (Array.isArray(raw) ? raw : [raw]).map((v) =>
      typeof v === 'string'
        ? v
        : typeof v === 'boolean'
          ? v
            ? 'True'
            : 'False'
          : v == null
            ? ''
            : String(v),
    );
  };
  const supplied: string[] =
    process.argv[3] === '--nomi-powershell-args' ? fromPs() : process.argv.slice(3);
  const args: string[] = [];
  let model = config.model;
  let parse = true;
  for (let n = 0; n < supplied.length; n++) {
    const arg = supplied[n];
    if (parse && arg === '--') {
      parse = false;
      args.push(arg);
    } else if (parse && arg === '--nomi-model') {
      if (n + 1 === supplied.length) return fail(config.messages.needModel, 2);
      model = supplied[++n];
    } else if (parse && arg.startsWith('--nomi-model=')) {
      model = arg.slice('--nomi-model='.length);
    } else args.push(arg);
  }
  if (!/^[A-Za-z0-9._:/@+-]+$/.test(model)) return fail(config.messages.badModel, 2);
  try {
    const health = await fetch(`${config.url}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) return fail(config.messages.down);
    await health.body?.cancel();
  } catch {
    return fail(config.messages.down);
  }
  let token: string;
  try {
    token = fs.readFileSync(config.tokenFile, 'utf8').trim();
    if (!token) return fail(config.messages.noToken);
  } catch {
    return fail(config.messages.noToken);
  }
  const env = { ...process.env };
  delete env.NOMI_TERMINAL_ARGS;
  for (const key of Object.keys(env)) {
    if (config.launch.strip.some((k) => k.toLowerCase() === key.toLowerCase())) delete env[key];
  }
  for (const [key, value] of Object.entries(config.launch.env)) {
    env[key] = value.includes('__NOMI_TOKEN__') ? token : value === config.model ? model : value;
  }
  const argv = [...config.launch.args];
  if (config.kind === 'claude') argv.push('--model', model);
  if (config.kind === 'codex') argv.push('-c', `model=${JSON.stringify(model)}`);
  let temporary: string | undefined;
  try {
    if (config.template && model !== config.model) {
      temporary = fs.mkdtempSync(path.join(path.dirname(config.template), 'override-'));
      const content = fs.readFileSync(config.template, 'utf8').split('__NOMI_MODEL__').join(model);
      if (config.kind === 'dsh') {
        const patch = path.join(temporary, 'patch.yml');
        fs.writeFileSync(patch, content, { mode: 0o600 });
        const at = argv.indexOf('--patch');
        if (at < 0) throw new Error('Missing dsh patch argument');
        argv[at + 1] = patch;
      } else if (config.kind === 'grok') {
        const home = config.launch.env.GROK_HOME;
        for (const name of fs.readdirSync(home)) {
          if (/^(config\.toml|auth\.json)$|\.lock$/.test(name)) continue;
          const target = fs.realpathSync(path.join(home, name));
          const link = path.join(temporary, name);
          if (fs.statSync(target).isDirectory()) fs.symlinkSync(target, link, 'junction');
          else fs.copyFileSync(target, link);
        }
        fs.writeFileSync(path.join(temporary, 'config.toml'), content, { mode: 0o600 });
        env.GROK_HOME = temporary;
      }
    }
    // 解析 PATH 上的可执行入口；npm/pnpm 的 cmd 解开成 node + JS，始终不用 shell 拼参数。
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path');
    const dirs = (pathKey ? (env[pathKey] ?? '') : '').split(path.delimiter);
    let file: string | undefined;
    for (const dir of dirs) {
      if (!dir) continue;
      for (const ext of ['.exe', '.cmd', '.bat']) {
        const candidate = path.join(dir.replace(/^"|"$/g, ''), config.kind + ext);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          file = candidate;
          break;
        }
      }
      if (file) break;
    }
    if (!file) return fail(config.messages.noBin, 127);
    if (/\.(cmd|bat)$/i.test(file)) {
      const dir = path.dirname(file) + path.sep;
      const quoted = [...fs.readFileSync(file, 'utf8').matchAll(/"([^"\r\n]+\.(?:m?js|cjs))"/gi)];
      const raw = quoted.at(-1)?.[1];
      const script = raw?.replace(/%~?dp0%?/gi, dir).replace(/[\\/]/g, path.sep);
      if (!script || /[%"\r\n]/.test(script) || !fs.existsSync(script)) {
        return fail(config.messages.unsafeShim, 126);
      }
      argv.unshift(script);
      file = process.execPath;
    }
    process.exitCode = await new Promise<number>((resolve) => {
      const child = spawn(file!, [...argv, ...args], { env, stdio: 'inherit', shell: false });
      const stop = () => child.kill();
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      child.once('error', (error) => {
        console.error(error.message);
      });
      child.once('close', (code) => {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        resolve(code ?? 1);
      });
    });
  } finally {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function buildWindowsRunner(): string {
  return `// Generated by Nomi; argv is never evaluated as shell code.\n(${run.toString()})().catch(e => { console.error(e.message); process.exitCode = 1; });\n`;
}
