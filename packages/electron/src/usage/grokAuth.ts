/**
 * Grok 官方登录状态探测。
 *
 * 只通过官方 ACP `initialize` 读取认证方式，不打开 auth.json，也不保存或记录
 * initialize 响应里的任何凭据内容。额度读取由 grokSubscription.ts 单独通过
 * 官方 CLI 的 `_x.ai/billing` 扩展完成；这个模块只负责区分 OAuth/账号登录与 API Key。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveCliBinAsync, withCliPath } from '../cli/detect';

import { killTree, STDOUT_LIMIT, resolveCliLaunch } from './limitedProcess';

export type GrokAuthMode = 'subscription' | 'api' | 'unknown';

export const GROK_AGENT_ARGS = ['agent', 'stdio'];
export const GROK_AUTH_TIMEOUT_MS = 6_000;

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;

/** 从 ACP initialize 响应中取出包含 authMethods 的结果对象。 */
function authPayload(v: unknown): Obj | null {
  const o = obj(v);
  if (!o) return null;
  if (Array.isArray(o.authMethods)) return o;
  if ('result' in o) return authPayload(o.result);
  return null;
}

/**
 * 解析官方 ACP initialize 输出。
 * `cached_token` 表示 ~/.grok/auth.json 中有官方登录态；api_key / deployment
 * 表示 API 计费。没有明确默认方式时保持 unknown，避免把登录入口误报成已登录。
 */
export function parseGrokAuthStatus(text: string): GrokAuthMode | null {
  const values: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      /* ACP 外的日志行忽略 */
    }
  }
  if (!values.length) {
    try {
      values.push(JSON.parse(text));
    } catch {
      return null;
    }
  }
  for (const value of values) {
    const p = authPayload(value);
    if (!p) continue;
    const meta = obj(p._meta);
    const defaultId =
      typeof meta?.defaultAuthMethodId === 'string'
        ? meta.defaultAuthMethodId
        : typeof p.defaultAuthMethodId === 'string'
          ? p.defaultAuthMethodId
          : '';
    if (/cached[_-]?token|oauth|grok\.com/i.test(defaultId)) {
      // grok.com 是登录入口；只有 cached_token / oauth 才表示已经登录。
      if (/cached[_-]?token|oauth/i.test(defaultId)) return 'subscription';
    }
    if (/api[_-]?key|deployment|env[_-]?key/i.test(defaultId)) return 'api';

    const methods = p.authMethods as unknown[];
    const cached = methods.some((m) => {
      const x = obj(m);
      return typeof x?.id === 'string' && /cached[_-]?token/i.test(x.id);
    });
    if (cached && defaultId === '') return 'subscription';
  }
  return null;
}

export interface GrokAuthReaderDeps {
  resolveBin?: () => Promise<string | null>;
  spawnFn?: typeof spawn;
  env?: () => NodeJS.ProcessEnv;
  tmpRoot?: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}

/** 启动一次官方 ACP，拿到 initialize 响应后立即结束进程。 */
export async function readGrokAuthStatus(d: GrokAuthReaderDeps = {}): Promise<string | null> {
  const bin = await (d.resolveBin ?? (() => resolveCliBinAsync('grok')))().catch(() => null);
  if (!bin) return null;
  const dir = fs.mkdtempSync(path.join(d.tmpRoot ?? os.tmpdir(), 'nomi-grok-auth-'));
  const env = (d.env ?? withCliPath)();
  const platform = d.platform ?? process.platform;
  const launch = resolveCliLaunch(bin, GROK_AGENT_ARGS, env, platform);
  if (!launch) {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  const file = launch.file;
  const args = launch.args;
  const child = await new Promise<ChildProcess | null>((resolve) => {
    try {
      resolve(
        (d.spawnFn ?? spawn)(file, args, {
          cwd: dir,
          // Keep USERPROFILE / HOME / GROK_HOME so the CLI finds ~/.grok on Windows GUI launches
          env: { ...env, NO_COLOR: '1' },
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
          windowsVerbatimArguments: launch.via === 'cmd-shim',
        }),
      );
    } catch {
      resolve(null);
    }
  });
  if (!child) {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }

  try {
    const result = await new Promise<string | null>((resolve) => {
      let settled = false;
      let bytes = 0;
      let buf = '';
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), d.timeoutMs ?? GROK_AUTH_TIMEOUT_MS);
      child.once('error', () => finish(null));
      child.once('close', () => finish(null));
      child.stdout?.setEncoding?.('utf8');
      child.stdout?.on('data', (chunk: string | Buffer) => {
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        bytes += Buffer.byteLength(s);
        if (bytes > STDOUT_LIMIT) {
          finish(null);
          return;
        }
        buf += s;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try {
            const parsed = JSON.parse(line) as Obj;
            if (parsed.id === 1 && parsed.result) {
              finish(JSON.stringify(parsed.result));
              return;
            }
          } catch {
            /* 非 JSON 日志行忽略 */
          }
        }
      });
      try {
        child.stdin?.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: 1,
              clientInfo: { name: 'nomi_usage', title: 'Nomi', version: '1.0.0' },
              clientCapabilities: {},
            },
          })}\n`,
        );
      } catch {
        finish(null);
      }
    });
    return result;
  } finally {
    killTree(child, 200);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响登录状态判断 */
    }
  }
}
