/**
 * 真实 CLI 二进制的运行器：每次运行都用新的临时目录作 HOME / 配置目录，
 * 不读也不写用户自己的 ~/.claude、~/.codex、~/.grok（来源隔离 S1）。
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TOKENS } from './gateway';

export type CliName = 'grok' | 'codex' | 'claude';

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** 超时被杀（CLI 一直没结束） */
  timedOut?: boolean;
}

/** 本机有没有这个 CLI（没有就跳过对应测试） */
export function hasCli(name: CliName): boolean {
  try {
    execFileSync(name, ['--version'], { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

export function cliVersion(name: CliName): string {
  try {
    return execFileSync(name, ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim();
  } catch {
    return 'unknown';
  }
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nomi-e2e-cli-${prefix}-`));
}

/** 去掉会改变路由或鉴权的继承变量，只留运行需要的 */
function baseEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'LANG', 'TERM', 'TMPDIR', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  env.HOME = home;
  env.USERPROFILE = home;
  return env;
}

function run(
  cmd: string,
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CliRun> {
  return new Promise((resolve) => {
    // 独立进程组：有的 CLI 是壳脚本再拉起真正的二进制（如 grok），超时要把整组杀掉，否则管道不关、测试卡住
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: o.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const killGroup = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, o.timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      // 子孙进程可能还握着管道：给 1 秒收尾，然后整组清掉
      setTimeout(() => {
        killGroup();
        resolve({ code: timedOut ? null : code, stdout, stderr, timedOut });
      }, 1000);
    });
  });
}

/** Grok：私有 GROK_HOME 里放指向网关的 config.toml（与 Nomi 第三方会话一致，含辅助模型覆盖） */
export async function runGrok(gatewayUrl: string, model: string, prompt: string): Promise<CliRun> {
  const home = tmp('grok');
  const grokHome = path.join(home, '.grok');
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(
    path.join(grokHome, 'config.toml'),
    [
      '[model.nomi]',
      `model = "${model}"`,
      `base_url = "${gatewayUrl}/v1"`,
      'name = "Nomi"',
      'env_key = "NOMI_GROK_API_KEY"',
      'api_backend = "responses"',
      'max_retries = 1',
      '',
      '[models]',
      'default = "nomi"',
      'session_summary = "nomi"',
      'prompt_suggestion = "nomi"',
      '',
    ].join('\n'),
  );
  const env = { ...baseEnv(home), GROK_HOME: grokHome, NOMI_GROK_API_KEY: TOKENS.grok };
  return run('grok', ['-p', prompt, '--disable-web-search'], { cwd: home, env, timeoutMs: 90_000 });
}

/** Codex：临时 CODEX_HOME + -c 指向网关（与 Nomi 第三方会话的注入方式一致） */
export async function runCodex(gatewayUrl: string, model: string, prompt: string): Promise<CliRun> {
  const home = tmp('codex');
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const env = { ...baseEnv(home), CODEX_HOME: codexHome, NOMI_GATEWAY_KEY: TOKENS.codex };
  return run(
    'codex',
    [
      'exec',
      '--skip-git-repo-check',
      '-c',
      'model_provider="nomi_gateway"',
      '-c',
      `model_providers.nomi_gateway={ name="Nomi", base_url="${gatewayUrl}/v1", wire_api="responses", env_key="NOMI_GATEWAY_KEY" }`,
      '-m',
      model,
      prompt,
    ],
    { cwd: home, env, timeoutMs: 120_000 },
  );
}

/** Claude Code：临时 CLAUDE_CONFIG_DIR + 网关地址与令牌（与 Nomi 第三方会话一致） */
export async function runClaude(
  gatewayUrl: string,
  model: string,
  prompt: string,
  extraEnv: Record<string, string> = {},
): Promise<CliRun> {
  const home = tmp('claude');
  const cfgDir = path.join(home, '.claude');
  fs.mkdirSync(cfgDir, { recursive: true });
  const env = {
    ...baseEnv(home),
    CLAUDE_CONFIG_DIR: cfgDir,
    ANTHROPIC_BASE_URL: gatewayUrl,
    ANTHROPIC_AUTH_TOKEN: TOKENS.claude,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    ...extraEnv,
  };
  return run(
    'claude',
    ['-p', prompt, '--model', model, '--tools', '', '--strict-mcp-config', '--setting-sources', ''],
    { cwd: home, env, timeoutMs: 120_000 },
  );
}
