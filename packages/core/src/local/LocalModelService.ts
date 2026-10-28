/**
 * 本地模型管理：
 *  - 小模型目录（GGUF）按需下载（复用语音的 downloadVerified：许可展示、进度、取消、sha256）
 *  - 按需下载 llama.cpp 的 llama-server（MIT），在 127.0.0.1 随机端口启动，
 *    自动注册 / 更新为「llama.cpp（本机）」OpenAI 兼容 provider；启动 / 停止 / 删除
 *  - Ollama：列出 / 拉取 / 删除本机模型（Ollama 自身需用户安装）
 *  - 离线模式：开启「仅本地模型」并切换到本机模型
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { broadcastMascotCommand } from '../ai/mascotCommand';
import type { AppEvents } from '../core/appEvents';
import type { DesktopService } from '../desktop/DesktopService';
import { t as tr } from '../i18n';
import { downloadVerified, extractTarGz, extractZip } from '../voice/download';

import {
  LLAMA_RUNTIME,
  LOCAL_LLMS,
  SERVER_NAMES,
  fitLevel,
  recommend,
  runtimeFor,
  serverArgs,
  type LocalLlm,
} from './llmCatalog';

interface Logger {
  info(m: string, x?: unknown): void;
  warn(m: string, x?: unknown): void;
}

/** ProviderService 的最小子集（ai-runtime） */
/** 统一网关（GatewayService）的最小子集：Nomi 对话的模型以网关为准 */
export interface GatewayLike {
  state(): { providers: Array<{ id: string; presetId?: string }> };
  upsertProvider(input: {
    id?: string;
    name: string;
    presetId?: string;
    urls: { chat?: string };
    models: Array<{ id: string; enabled: boolean }>;
  }): { id: string };
  setAssignment(client: 'nomi', patch: { models: { main: string } }): void;
  confirmPrivateHost(hostPort: string): void;
}

export interface LocalDeps {
  root: string;
  logger: Logger;
  desktop: DesktopService;
  /** GatewayStore 是唯一供应商来源；本机 llama.cpp 只登记到网关 */
  gateway: () => GatewayLike | null;
  fetchImpl?: typeof fetch;
  /** 通知界面（`ai:local:*` 发给所有窗口） */
  events: AppEvents;
}

interface Settings {
  activeModel?: string;
  autoStart: boolean;
  providerId?: string;
  /** 网关里对应的供应商 id */
  gatewayProviderId?: string;
  threads?: number;
  ollamaUrl: string;
}

type ServerStatus = 'stopped' | 'starting' | 'running' | 'error';

const PROVIDER_NAME = 'electron.common.llama-cpp-local';
const LOCAL_PRESET_ID = 'llamacpp';
const RUNTIME_ID = 'llama-runtime';

export class LocalModelService {
  private settings: Settings;
  private downloads = new Map<string, { ctrl: AbortController; received: number; total: number }>();
  private proc: ChildProcess | null = null;
  private status: ServerStatus = 'stopped';
  private port = 0;
  private running?: string;
  private lastError = '';
  private log: string[] = [];

  constructor(private readonly d: LocalDeps) {
    fs.mkdirSync(this.modelsDir, { recursive: true });
    let raw: Partial<Settings> = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) as Partial<Settings>;
    } catch {
      /* default */
    }
    this.settings = {
      activeModel: typeof raw.activeModel === 'string' ? raw.activeModel : undefined,
      autoStart: raw.autoStart === true,
      providerId: typeof raw.providerId === 'string' ? raw.providerId : undefined,
      gatewayProviderId:
        typeof raw.gatewayProviderId === 'string' ? raw.gatewayProviderId : undefined,
      threads: Number.isInteger(raw.threads) ? raw.threads : undefined,
      ollamaUrl:
        typeof raw.ollamaUrl === 'string' && /^https?:\/\//.test(raw.ollamaUrl)
          ? raw.ollamaUrl
          : 'http://127.0.0.1:11434',
    };
  }

  private get settingsFile() {
    return path.join(this.d.root, 'settings.json');
  }
  private get modelsDir() {
    return path.join(this.d.root, 'models');
  }
  private get runtimeDir() {
    return path.join(this.d.root, 'llama.cpp', LLAMA_RUNTIME.tag);
  }
  private save() {
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
  }
  private broadcast(ch: string, p: unknown) {
    this.d.events.publish(ch, p);
  }
  private changed() {
    this.broadcast('ai:local:changed', null);
  }
  private audit(tool: string, args: Record<string, unknown>, result: string, ms = 0) {
    this.d.desktop.audit.append({
      tool,
      args,
      decision: 'user',
      result,
      ms,
      source: 'settings',
    } as never);
  }

  modelPath(m: LocalLlm) {
    return path.join(this.modelsDir, `${m.id}.gguf`);
  }
  installed(m: LocalLlm) {
    try {
      return fs.statSync(this.modelPath(m)).size === m.bytes;
    } catch {
      return false;
    }
  }
  serverBin(): string | null {
    for (const n of SERVER_NAMES)
      for (const p of [
        path.join(this.runtimeDir, n),
        path.join(this.runtimeDir, 'bin', n),
        path.join(this.runtimeDir, 'build', 'bin', n),
      ])
        if (fs.existsSync(p)) return p;
    return null;
  }

  state() {
    const ramGb = Math.round(os.totalmem() / 2 ** 30);
    const rec = recommend(ramGb);
    const runtime = runtimeFor();
    return {
      ramGb,
      recommended: rec.id,
      models: LOCAL_LLMS.map((m) => ({
        ...m,
        installed: this.installed(m),
        fit: fitLevel(m, ramGb),
        downloading: this.downloads.has(m.id) ? this.dlView(m.id) : undefined,
      })),
      runtime: {
        tag: LLAMA_RUNTIME.tag,
        license: LLAMA_RUNTIME.license,
        licenseUrl: LLAMA_RUNTIME.licenseUrl,
        sourceUrl: LLAMA_RUNTIME.sourceUrl,
        supported: !!runtime,
        bytes: runtime?.bytes ?? 0,
        installed: !!this.serverBin(),
        downloading: this.downloads.has(RUNTIME_ID) ? this.dlView(RUNTIME_ID) : undefined,
      },
      server: {
        status: this.status,
        model: this.running,
        port: this.port || undefined,
        baseURL: this.port ? `http://127.0.0.1:${this.port}/v1` : undefined,
        error: this.lastError || undefined,
        log: this.log.slice(-8),
      },
      settings: this.settings,
      offline: this.d.desktop.broker.localOnly,
    };
  }
  private dlView(id: string) {
    const r = this.downloads.get(id)!;
    return { received: r.received, total: r.total };
  }

  setSettings(p: Partial<Settings>) {
    if (typeof p.autoStart === 'boolean') this.settings.autoStart = p.autoStart;
    if (
      p.threads === undefined ||
      (Number.isInteger(p.threads) && p.threads > 0 && p.threads <= 64)
    )
      this.settings.threads = p.threads;
    if (typeof p.ollamaUrl === 'string' && /^https?:\/\//.test(p.ollamaUrl))
      this.settings.ollamaUrl = p.ollamaUrl.replace(/\/+$/, '');
    this.save();
    this.changed();
    return this.settings;
  }

  // ───────────── 下载 ─────────────
  async download(id: string): Promise<{ ok: boolean; error?: string }> {
    const isRuntime = id === RUNTIME_ID;
    const m = LOCAL_LLMS.find((x) => x.id === id);
    const rt = runtimeFor();
    if (!isRuntime && !m) return { ok: false, error: tr('electron.common.unknown-model') };
    if (isRuntime && !rt)
      return { ok: false, error: tr('electron.common.no-prebuilt-llama-cpp-for-this-computer-s') };
    if (this.downloads.has(id)) return { ok: false, error: tr('electron.common.downloading') };
    const ctrl = new AbortController();
    const total = isRuntime ? rt!.bytes : m!.bytes;
    const rec = { ctrl, received: 0, total };
    this.downloads.set(id, rec);
    this.changed();
    const t0 = Date.now();
    try {
      const dest = isRuntime
        ? path.join(this.d.root, `${RUNTIME_ID}.download`)
        : this.modelPath(m!);
      await downloadVerified({
        url: isRuntime ? rt!.url : m!.url,
        sha256: isRuntime ? rt!.sha256 : m!.sha256,
        dest,
        expectedBytes: total,
        signal: ctrl.signal,
        onProgress: (p) => {
          rec.received = p.received;
          rec.total = p.total || total;
          this.broadcast('ai:local:progress', { id, received: rec.received, total: rec.total });
        },
        fetchImpl: this.d.fetchImpl as never,
      });
      if (isRuntime) {
        const buf = fs.readFileSync(dest);
        fs.rmSync(this.runtimeDir, { recursive: true, force: true });
        if (rt!.archive === 'zip') extractZip(buf, this.runtimeDir);
        else extractTarGz(buf, this.runtimeDir);
        fs.rmSync(dest, { force: true });
        const bin = this.serverBin();
        if (!bin) throw new Error(tr('electron.common.llama-server-not-found-after-unpacking'));
        if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
      }
      this.audit('local_model_download', { id }, 'ok', Date.now() - t0);
      broadcastMascotCommand({ type: 'motion', name: 'clap' });
      return { ok: true };
    } catch (e) {
      const aborted = ctrl.signal.aborted;
      const msg = aborted
        ? tr('electron.common.cancelled')
        : e instanceof Error
          ? e.message
          : String(e);
      if (!aborted) this.d.logger.warn('本地模型下载失败', { id, error: msg });
      return { ok: false, error: msg };
    } finally {
      this.downloads.delete(id);
      this.changed();
    }
  }
  /** 下载 llama.cpp 运行时（与模型共用下载进度与取消） */
  downloadRuntime(): Promise<{ ok: boolean; error?: string }> {
    return this.download(RUNTIME_ID);
  }
  cancel(id: string) {
    const r = this.downloads.get(id);
    r?.ctrl.abort();
    return !!r;
  }
  async remove(id: string) {
    const m = LOCAL_LLMS.find((x) => x.id === id);
    if (!m) return false;
    if (this.running === id) await this.stop();
    fs.rmSync(this.modelPath(m), { force: true });
    if (this.settings.activeModel === id) this.settings.activeModel = undefined;
    this.save();
    this.audit('local_model_remove', { id }, 'ok');
    this.changed();
    return true;
  }
  removeRuntime() {
    if (this.proc) throw new Error(tr('electron.common.please-stop-the-local-model-first'));
    fs.rmSync(path.dirname(this.runtimeDir), { recursive: true, force: true });
    this.changed();
    return true;
  }

  // ───────────── 推理服务 ─────────────
  async start(id: string): Promise<{ baseURL: string; providerId: string }> {
    const m = LOCAL_LLMS.find((x) => x.id === id);
    if (!m || !this.installed(m))
      throw new Error(tr('electron.common.please-download-this-model-first'));
    const bin = this.serverBin();
    if (!bin)
      throw new Error(tr('electron.common.please-download-the-llama-cpp-inference-engine-first'));
    if (this.proc) await this.stop();
    this.status = 'starting';
    this.lastError = '';
    this.log = [];
    this.port = await freePort();
    this.running = id;
    this.changed();
    const args = serverArgs({
      model: this.modelPath(m),
      port: this.port,
      ctx: m.ctx,
      threads: this.settings.threads,
    });
    const proc = spawn(bin, args, {
      cwd: path.dirname(bin),
      env: {
        ...process.env,
        LD_LIBRARY_PATH: [path.dirname(bin), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    const onData = (b: Buffer) => {
      for (const line of b.toString().split('\n'))
        if (line.trim()) this.log.push(line.slice(0, 200));
      if (this.log.length > 200) this.log = this.log.slice(-100);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.status !== 'stopped') {
        this.status = 'error';
        this.lastError = tr(
          'electron.common.the-inference-server-exited-unexpectedly-code',
          code,
          this.log.slice(-2).join(' ').slice(0, 200),
        );
      }
      this.changed();
    });
    proc.on('error', (e) => {
      this.status = 'error';
      this.lastError = tr('electron.common.couldn-t-start-llama-server', e.message);
      this.changed();
    });
    const t0 = Date.now();
    const ok = await this.waitHealthy(90_000);
    if (!ok) {
      const err =
        this.lastError || tr('electron.common.the-inference-server-timed-out-while-starting');
      await this.stop();
      this.status = 'error';
      this.lastError = err;
      this.changed();
      throw new Error(err);
    }
    this.status = 'running';
    const baseURL = `http://127.0.0.1:${this.port}/v1`;
    const providerId = this.registerProvider(m, baseURL);
    this.settings.activeModel = id;
    this.save();
    this.audit('local_model_start', { id, port: this.port }, 'ok', Date.now() - t0);
    broadcastMascotCommand({ type: 'motion', name: 'nod' });
    this.d.desktop.say(tr('electron.common.local-model-is-ready-your-chats-won-t', m.name));
    this.changed();
    return { baseURL, providerId };
  }

  private async waitHealthy(timeoutMs: number) {
    const f = this.d.fetchImpl ?? fetch;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (!this.proc) return false;
      try {
        const r = await f(`http://127.0.0.1:${this.port}/health`);
        if (r.ok) return true;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  /** 在网关登记 / 更新「llama.cpp（本机）」供应商（端口每次启动可能不同） */
  private registerProvider(m: LocalLlm, baseURL: string): string {
    const id = this.registerInGateway(m, baseURL);
    this.settings.providerId = id;
    this.settings.gatewayProviderId = id;
    this.save();
    return id;
  }

  /** 网关登记（地址是本机回环，需要确认；没有 Key） */
  private registerInGateway(m: LocalLlm, baseURL: string): string {
    const gw = this.d.gateway();
    if (!gw) throw new Error(tr('electron.common.ai-service-not-ready'));
    try {
      const u = new URL(baseURL);
      gw.confirmPrivateHost(`${u.hostname}:${u.port || '80'}`);
      const existing = gw
        .state()
        .providers.find(
          (p) => p.id === this.settings.gatewayProviderId || p.presetId === LOCAL_PRESET_ID,
        );
      const v = gw.upsertProvider({
        ...(existing ? { id: existing.id } : {}),
        name: tr(PROVIDER_NAME),
        presetId: LOCAL_PRESET_ID,
        urls: { chat: baseURL },
        models: [{ id: m.id, enabled: true }],
      });
      return v.id;
    } catch (e) {
      this.d.logger.warn('register local model in gateway failed', e);
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  async stop() {
    const p = this.proc;
    this.status = 'stopped';
    this.proc = null;
    this.running = undefined;
    this.port = 0;
    if (p && p.exitCode === null) {
      p.kill();
      await new Promise((r) => {
        const t = setTimeout(() => {
          try {
            p.kill('SIGKILL');
          } catch {
            /* gone */
          }
          r(null);
        }, 3000);
        p.once('exit', () => {
          clearTimeout(t);
          r(null);
        });
      });
    }
    this.changed();
    return true;
  }

  /** 设为当前对话模型（只写 GatewayStore 的 nomi.main） */
  useAsChat() {
    const gw = this.d.gateway();
    if (!gw || !this.settings.gatewayProviderId || this.status !== 'running' || !this.running)
      throw new Error(tr('electron.common.the-local-model-isn-t-running-yet'));
    gw.setAssignment('nomi', {
      models: { main: `${this.settings.gatewayProviderId}/${this.running}` },
    });
    this.changed();
    return true;
  }

  /** 离线模式：仅本地模型 + 切到本机模型（若在运行） */
  async setOffline(on: boolean) {
    this.d.desktop.broker.setLocalOnly(on);
    this.d.desktop.audit.append({
      tool: 'set_local_only',
      args: { v: on },
      decision: 'user',
      result: 'ok',
      source: 'settings',
    } as never);
    if (on && this.status === 'running') this.useAsChat();
    this.audit('offline_mode', { on }, 'ok');
    this.changed();
    return this.state().offline;
  }

  async autoStart() {
    const id = this.settings.activeModel;
    if (this.settings.autoStart && id)
      await this.start(id).catch((e) =>
        this.d.logger.warn('本地模型自动启动失败', { error: String(e) }),
      );
  }

  // ───────────── Ollama ─────────────
  private async ollama<T>(p: string, init?: RequestInit): Promise<T> {
    const f = this.d.fetchImpl ?? fetch;
    let r: Response;
    try {
      r = await f(`${this.settings.ollamaUrl}${p}`, init);
    } catch {
      throw new Error(tr('electron.common.ollama-not-detected-please-install-and-start-ollama'));
    }
    if (!r.ok) throw new Error(tr('electron.common.ollama-returned-http', r.status));
    return (await r.json()) as T;
  }
  async ollamaList() {
    const j = await this.ollama<{
      models?: Array<{
        name: string;
        size: number;
        modified_at: string;
        details?: { parameter_size?: string; quantization_level?: string; family?: string };
      }>;
    }>('/api/tags');
    return (j.models ?? []).map((m) => ({
      name: m.name,
      size: m.size,
      modifiedAt: m.modified_at,
      params: m.details?.parameter_size,
      quant: m.details?.quantization_level,
      family: m.details?.family,
    }));
  }
  async ollamaPull(name: string) {
    if (!/^[\w.\-/:]+$/.test(name))
      throw new Error(tr('electron.common.model-names-may-only-contain-letters-digits-and'));
    const id = `ollama:${name}`;
    if (this.downloads.has(id)) throw new Error(tr('electron.common.pulling'));
    const ctrl = new AbortController();
    const rec = { ctrl, received: 0, total: 0 };
    this.downloads.set(id, rec);
    const f = this.d.fetchImpl ?? fetch;
    try {
      const r = await f(`${this.settings.ollamaUrl}/api/pull`, {
        method: 'POST',
        body: JSON.stringify({ name, stream: true }),
        signal: ctrl.signal,
      }).catch(() => {
        throw new Error(tr('electron.common.ollama-not-detected-install-first'));
      });
      if (!r.ok || !r.body)
        throw new Error(tr('electron.common.ollama-pull-failed-http', r.status));
      const reader = r.body.getReader();
      const td = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += td.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const j = JSON.parse(line) as {
            status?: string;
            completed?: number;
            total?: number;
            error?: string;
          };
          if (j.error) throw new Error(j.error);
          if (j.total) {
            rec.total = j.total;
            rec.received = j.completed ?? 0;
          }
          this.broadcast('ai:local:progress', {
            id,
            received: rec.received,
            total: rec.total,
            status: j.status,
          });
        }
      }
      this.audit('ollama_pull', { name }, 'ok');
      return true;
    } finally {
      this.downloads.delete(id);
      this.changed();
    }
  }
  async ollamaDelete(name: string) {
    const f = this.d.fetchImpl ?? fetch;
    const r = await f(`${this.settings.ollamaUrl}/api/delete`, {
      method: 'DELETE',
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error(tr('electron.common.delete-failed-http', r.status));
    this.audit('ollama_delete', { name }, 'ok');
    this.changed();
    return true;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
    });
  });
}

export { RUNTIME_ID };
let inst: LocalModelService | null = null;
export function initLocalModelService(d: LocalDeps) {
  inst = new LocalModelService(d);
  return inst;
}
export function getLocalModelService() {
  return inst;
}
