/**
 * 从各 CLI 自己读取模型目录（不写死任何模型 / 档位，见 modelCatalog.ts）。
 *
 * - Claude Code：起一个 stream-json 进程，只发 `initialize` 控制请求，读响应里的 `models`，
 *   不发任何对话、不耗额度；响应里没有默认档位，另读 CLAUDE_CODE_EFFORT_LEVEL / settings.json
 * - Codex：`codex debug models`（JSON；随当前生效的配置 / 供应商刷新）+ config.toml 顶层默认值
 * - Grok：`grok agent stdio`（ACP）`initialize` → `session/new` 读 `models`，随即 `session/close`
 *
 * 进程都由调用方按标签同样的方式拉起（同一份可执行文件与环境变量），读完即拆。
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

import { AcpConnection } from './gemini/acp';
import {
  parseClaudeModels,
  parseCodexModels,
  parseGrokModels,
  readClaudeEffortSetting,
  readCodexConfigDefaults,
  type BackendModelCatalog,
  type CliBackend,
} from './modelCatalog';

/** 单次读取的超时（Codex 会联网刷新目录、Claude 冷启动要加载插件，留足余量） */
export const MODEL_DISCOVERY_TIMEOUT_MS = 30_000;

export interface ModelDiscoveryDeps {
  /** 按标签同样的方式拉起该 CLI（解析可执行文件、Node 脚本、环境变量）；找不到 CLI 返回 null */
  spawn: (backend: CliBackend, args: string[]) => ChildProcessWithoutNullStreams | null;
  /**
   * Claude Code 不传 --effort 时的默认档位来源（与拉起进程用同一份环境）：
   * effortEnv = CLAUDE_CODE_EFFORT_LEVEL（优先），settingsPath = <CLAUDE_CONFIG_DIR 或 ~/.claude>/settings.json
   */
  claudeDefaults?: { effortEnv?: string; settingsPath?: string };
  /** Codex 的 config.toml 路径（读不传参数时的默认模型） */
  codexConfigPath: string;
  /** Grok 自己维护的模型缓存 / 设置缓存（ACP 版本返回不完整时兜底） */
  grokModelsCachePath?: string;
  grokSettingsCachePath?: string;
  timeoutMs?: number;
}

/** 读某个后端的模型目录；失败时抛错（调用方转成 catalog.error） */
export function discoverModels(
  backend: CliBackend,
  deps: ModelDiscoveryDeps,
): Promise<BackendModelCatalog> {
  const timeoutMs = deps.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS;
  if (backend === 'claude') return discoverClaude(deps, timeoutMs);
  if (backend === 'codex') return discoverCodex(deps, timeoutMs);
  if (backend === 'grok') return discoverGrok(deps, timeoutMs);
  return Promise.reject(new Error(`no model discovery for ${backend}`));
}

function spawnOrThrow(deps: ModelDiscoveryDeps, backend: CliBackend, args: string[]) {
  const child = deps.spawn(backend, args);
  if (!child) throw new Error(`${backend} CLI not found`);
  return child;
}

/** 收集 stderr 尾部，失败时作为原因 */
function stderrTail(child: ChildProcessWithoutNullStreams): () => string {
  let tail = '';
  child.stderr.on('data', (c: Buffer) => {
    tail = (tail + String(c)).slice(-600);
  });
  return () => tail.trim().split('\n').slice(-3).join(' ').trim();
}

/** 读完 / 失败后拆进程；超时也拆 */
function withTimeout<T>(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  run: (done: (v: T) => void, fail: (e: Error) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`timed out after ${timeoutMs}ms`))),
      timeoutMs,
    );
    child.on('error', (e) => finish(() => reject(e)));
    run(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}

function discoverClaude(deps: ModelDiscoveryDeps, timeoutMs: number) {
  const child = spawnOrThrow(deps, 'claude', [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
  ]);
  const stderr = stderrTail(child);
  const requestId = 'nomi-models';
  return withTimeout<BackendModelCatalog>(child, timeoutMs, (done, fail) => {
    let buf = '';
    child.stdout.on('data', (c: Buffer) => {
      buf += String(c);
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        let j: Record<string, unknown>;
        try {
          j = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (j.type !== 'control_response') continue;
        const r = (j.response ?? {}) as Record<string, unknown>;
        if (r.request_id !== requestId) continue;
        if (r.subtype === 'error') {
          fail(new Error(String(r.error ?? 'initialize failed')));
          return;
        }
        done(parseClaudeModels(r.response, { effort: claudeConfiguredEffort(deps) }));
        return;
      }
    });
    child.on('close', (code) => fail(new Error(stderr() || `claude exited (${code})`)));
    child.stdin.write(
      `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } })}\n`,
    );
  });
}

/** 环境变量优先（`auto` 等非档位值视为没设），其次设置文件；都没有为 null（CLI 按模型决定） */
export function claudeConfiguredEffort(deps: ModelDiscoveryDeps): string | null {
  const fromEnv = deps.claudeDefaults?.effortEnv?.trim();
  if (fromEnv && fromEnv !== 'auto') return fromEnv;
  const file = deps.claudeDefaults?.settingsPath;
  if (!file) return null;
  try {
    return readClaudeEffortSetting(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function discoverCodex(deps: ModelDiscoveryDeps, timeoutMs: number) {
  const child = spawnOrThrow(deps, 'codex', ['debug', 'models']);
  child.stdin.end();
  const stderr = stderrTail(child);
  return withTimeout<BackendModelCatalog>(child, timeoutMs, (done, fail) => {
    let out = '';
    child.stdout.on('data', (c: Buffer) => {
      out += String(c);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        fail(new Error(stderr() || `codex exited (${code})`));
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(out);
      } catch {
        fail(new Error('codex debug models: invalid JSON'));
        return;
      }
      let config = {};
      try {
        config = readCodexConfigDefaults(fs.readFileSync(deps.codexConfigPath, 'utf8'));
      } catch {
        /* 没有 config.toml：没有显式默认模型 / 档位 */
      }
      done(parseCodexModels(json, config));
    });
  });
}

function discoverGrok(deps: ModelDiscoveryDeps, timeoutMs: number) {
  const child = spawnOrThrow(deps, 'grok', ['agent', 'stdio']);
  const stderr = stderrTail(child);
  return withTimeout<BackendModelCatalog>(child, timeoutMs, (done, fail) => {
    const conn = new AcpConnection(child, {
      onNotification: () => undefined,
      // 只读目录，不接受代理发来的任何请求（权限、读写文件…）
      onRequest: () => Promise.reject(new Error('not supported')),
    });
    const opts = { timeoutMs };
    void (async () => {
      try {
        await conn.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, opts);
        const session = await conn.request<Record<string, unknown>>(
          'session/new',
          { cwd: os.tmpdir(), mcpServers: [] },
          opts,
        );
        const acpCatalog = parseGrokModels(session);
        const cacheCatalog = readGrokCache(deps);
        // Grok 1.0.60 的 ACP 在部分登录 / 版本组合下只返回部分模型；
        // models_cache.json 是 CLI 刚从同一模型接口写下的完整目录，补齐缺项但保留 ACP 顺序。
        const catalog = cacheCatalog
          ? {
              ...acpCatalog,
              models: [
                ...acpCatalog.models,
                ...cacheCatalog.models.filter(
                  (m) => !acpCatalog.models.some((existing) => existing.id === m.id),
                ),
              ],
              defaultModel: acpCatalog.defaultModel ?? cacheCatalog.defaultModel,
            }
          : acpCatalog;
        // 只为读目录建的会话：关掉，不留在 Grok 的会话列表里（失败不影响结果）
        const sessionId = typeof session.sessionId === 'string' ? session.sessionId : '';
        if (sessionId) {
          await conn.request('session/close', { sessionId }, { timeoutMs: 3_000 }).catch(() => {
            /* 尽力而为 */
          });
        }
        done(catalog);
      } catch (e) {
        const reason = stderr();
        fail(reason ? new Error(reason) : e instanceof Error ? e : new Error(String(e)));
      }
    })();
  }).catch((error: unknown) => {
    // ACP 启动可能被 Grok 的 managed policy 锁权限拦住；CLI 自己的缓存仍然是
    // 最近一次真实模型接口返回，优先让模型选择器可用，发送消息时再由 CLI 报具体认证错误。
    return readGrokCache(deps) ?? Promise.reject(error);
  });
}

/** 从 Grok 自己的缓存读取完整模型目录；读取失败时继续使用 ACP 结果。 */
function readGrokCache(deps: ModelDiscoveryDeps): BackendModelCatalog | null {
  const file = deps.grokModelsCachePath;
  if (!file) return null;
  try {
    const catalog = parseGrokModels(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (deps.grokSettingsCachePath) {
      try {
        const settings = JSON.parse(fs.readFileSync(deps.grokSettingsCachePath, 'utf8')) as {
          payload?: unknown;
        };
        const payload =
          typeof settings.payload === 'string' ? JSON.parse(settings.payload) : settings.payload;
        const defaultModel =
          payload && typeof payload === 'object'
            ? ((payload as { settings?: { default_model?: unknown }; default_model?: unknown })
                .default_model ??
              (payload as { settings?: { default_model?: unknown } }).settings?.default_model)
            : undefined;
        if (typeof defaultModel === 'string') {
          const found = catalog.models.find((m) => m.id === defaultModel);
          if (found) return { ...catalog, defaultModel: found };
        }
      } catch {
        /* 设置缓存不是模型目录的必要条件 */
      }
    }
    return catalog.models.length ? catalog : null;
  } catch {
    return null;
  }
}
