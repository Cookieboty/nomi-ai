/**
 * 语音输入服务（主进程）：设置、按需下载本地模型（进度 + 许可 + 校验）、识别分派
 * （本地 whisper.cpp / OpenAI 兼容服务）、语音活动广播（看板娘表情 / 打断 TTS）、
 * 从看板娘把识别结果投递到对话窗口。所有 IPC 都在 `ai:voice:*` 下。
 *
 * 隐私：录音只在内存 / 临时文件里，识别完立即删除；不落盘、不进日志。
 * 云端识别首次使用必须用户确认；桌面能力「仅本地模型」开启时拒绝云端识别。审计只记来源 / 引擎 / 时长。
 */
import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow, type IpcMainInvokeEvent } from 'electron';

import { t as tr } from '../i18n';
import { guardedHandle } from '../security/guardedIpc';

import { assetsFor, findAsset, type VoiceAsset } from './catalog';
import { transcribeOpenAICompat } from './cloudAsr';
import { downloadVerified, extractTarGz, extractZip } from './download';
import {
  DEFAULT_VOICE_SETTINGS,
  cloudTargetId,
  sanitizeVoiceSettings,
  type VoiceSettings,
} from './settings';
import { SileroStream, toFloat32, warmup } from './sileroNode';
import { findCliIn, findCliOnPath, runWhisperCli } from './whisperCpp';

type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

export type VoiceActivity = 'idle' | 'listening' | 'hearing' | 'transcribing' | 'wake-armed';

export interface VoiceDeps {
  root: string;
  logger: Logger;
  providers?: () => Array<{ id: string; name: string; baseURL: string }>;
  credentials?: (
    id: string,
  ) => { id: string; name: string; baseURL: string; apiKey?: string } | null;
  localOnly?: () => boolean;
  audit?: (e: {
    tool: string;
    args: Record<string, unknown>;
    decision: 'user' | 'auto' | 'denied' | 'error';
    result: string;
    ms?: number;
    provider?: string;
  }) => void;
  openChat?: () => Promise<BrowserWindow>;
  isLocalURL?: (u: string) => boolean;
}

export class VoiceError extends Error {
  constructor(
    readonly code:
      | 'no_engine'
      | 'no_model'
      | 'no_provider'
      | 'cloud_not_acked'
      | 'local_only'
      | 'empty'
      | 'failed',
    message: string,
  ) {
    super(message);
  }
}

const isLocalDefault = (u: string) => {
  try {
    const h = new URL(u).hostname;
    return h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h);
  } catch {
    return false;
  }
};

export class VoiceService {
  private settings: VoiceSettings;
  private readonly downloads = new Map<
    string,
    { ctrl: AbortController; received: number; total: number }
  >();
  private activity: VoiceActivity = 'idle';
  private readonly vads = new Map<string, SileroStream>();
  private readonly vadOwners = new Set<number>();
  private vadSeq = 0;
  private ipcDone = false;

  constructor(private readonly d: VoiceDeps) {
    this.settings = this.load();
  }

  private get settingsFile() {
    return path.join(this.d.root, 'settings.json');
  }
  private get modelsDir() {
    return path.join(this.d.root, 'models');
  }

  private load(): VoiceSettings {
    try {
      return sanitizeVoiceSettings(JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')));
    } catch {
      return { ...DEFAULT_VOICE_SETTINGS };
    }
  }

  private save(): void {
    fs.mkdirSync(this.d.root, { recursive: true });
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
  }

  getSettings(): VoiceSettings {
    return this.settings;
  }

  setSettings(patch: unknown): VoiceSettings {
    const merged = {
      ...this.settings,
      ...(patch && typeof patch === 'object' ? patch : {}),
    } as Record<string, unknown>;
    // cloudAcked 只能通过 ackCloud 增加
    merged.cloudAcked = this.settings.cloudAcked;
    this.settings = sanitizeVoiceSettings(merged, this.settings);
    this.save();
    this.broadcast('ai:voice:changed', null);
    return this.settings;
  }

  assetDir(a: VoiceAsset): string {
    return path.join(this.modelsDir, a.id);
  }

  assetPath(a: VoiceAsset): string {
    return a.fileName ? path.join(this.assetDir(a), a.fileName) : this.assetDir(a);
  }

  installed(a: VoiceAsset): boolean {
    if (a.kind === 'whisper-bin') return !!findCliIn(this.assetDir(a));
    return fs.existsSync(this.assetPath(a));
  }

  /** 识别引擎是否可用，以及缺什么 */
  locateCli(): { path: string; source: 'downloaded' | 'custom' | 'path' } | null {
    const s = this.settings;
    if (s.whisperCliPath && fs.existsSync(s.whisperCliPath))
      return { path: s.whisperCliPath, source: 'custom' };
    for (const a of assetsFor().filter((x) => x.kind === 'whisper-bin')) {
      const p = findCliIn(this.assetDir(a));
      if (p) return { path: p, source: 'downloaded' };
    }
    const onPath = findCliOnPath();
    return onPath ? { path: onPath, source: 'path' } : null;
  }

  readiness(): { ok: boolean; code?: VoiceError['code']; message?: string; local: boolean } {
    const s = this.settings;
    if (s.engine === 'whisper-cpp') {
      if (!this.locateCli())
        return {
          ok: false,
          local: true,
          code: 'no_engine',
          message:
            process.platform === 'darwin'
              ? tr(
                  '未找到 whisper.cpp：请先 `brew install whisper-cpp`，或在设置里指定 whisper-cli 路径。',
                )
              : tr('还没有下载 whisper.cpp 引擎。'),
        };
      const m = findAsset(s.whisperModel);
      if (!m || !this.installed(m))
        return { ok: false, local: true, code: 'no_model', message: tr('还没有下载识别模型。') };
      return { ok: true, local: true };
    }
    const target = this.cloudTarget();
    if (!target)
      return { ok: false, local: false, code: 'no_provider', message: tr('请选择识别服务。') };
    if (!target.local && this.d.localOnly?.())
      return {
        ok: false,
        local: false,
        code: 'local_only',
        message: tr('已开启「仅本地模型」，不能把录音发送到云端。'),
      };
    if (!target.local && !s.cloudAcked.includes(cloudTargetId(s)))
      return {
        ok: false,
        local: false,
        code: 'cloud_not_acked',
        message: tr('录音将发送给「{0}」识别，需要你确认一次。', target.name),
      };
    return { ok: true, local: target.local };
  }

  private cloudTarget(): { name: string; baseURL: string; apiKey?: string; local: boolean } | null {
    const s = this.settings;
    const isLocal = this.d.isLocalURL ?? isLocalDefault;
    if (s.customBaseURL)
      return {
        name: new URL(s.customBaseURL).host,
        baseURL: s.customBaseURL,
        local: isLocal(s.customBaseURL),
      };
    if (!s.providerId) return null;
    const c = this.d.credentials?.(s.providerId);
    if (!c) return null;
    return { name: c.name, baseURL: c.baseURL, apiKey: c.apiKey, local: isLocal(c.baseURL) };
  }

  ackCloud(): VoiceSettings {
    const id = cloudTargetId(this.settings);
    if (id && !this.settings.cloudAcked.includes(id)) {
      this.settings = { ...this.settings, cloudAcked: [...this.settings.cloudAcked, id] };
      this.save();
      this.d.audit?.({
        tool: 'voice_cloud_ack',
        args: { target: id },
        decision: 'user',
        result: 'ok',
      });
    }
    return this.settings;
  }

  state() {
    return {
      settings: this.settings,
      platform: `${process.platform}-${process.arch}`,
      assets: assetsFor().map((a) => {
        const dl = this.downloads.get(a.id);
        return {
          id: a.id,
          kind: a.kind,
          name: a.name,
          description: a.description,
          bytes: a.bytes,
          license: a.license,
          licenseUrl: a.licenseUrl,
          sourceUrl: a.sourceUrl,
          installed: this.installed(a),
          downloading: dl ? { received: dl.received, total: dl.total } : null,
        };
      }),
      cli: this.locateCli(),
      readiness: this.readiness(),
      vadReady: this.vadModelPath() !== null,
      providers: (this.d.providers?.() ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        local: (this.d.isLocalURL ?? isLocalDefault)(p.baseURL),
      })),
      activity: this.activity,
    };
  }

  vadModelPath(): string | null {
    const a = findAsset('silero-vad');
    return a && this.installed(a) ? this.assetPath(a) : null;
  }

  async download(id: string): Promise<{ ok: boolean; error?: string }> {
    const a = findAsset(id);
    if (!a || !assetsFor().includes(a)) return { ok: false, error: tr('未知或不适用于本机的资源') };
    if (this.downloads.has(id)) return { ok: false, error: tr('正在下载') };
    const ctrl = new AbortController();
    const rec = { ctrl, received: 0, total: a.bytes };
    this.downloads.set(id, rec);
    const started = Date.now();
    this.progress(id, rec.received, rec.total, 'start');
    try {
      const dir = this.assetDir(a);
      const dest = a.archive ? path.join(this.modelsDir, `${a.id}.download`) : this.assetPath(a);
      await downloadVerified({
        url: a.url,
        sha256: a.sha256,
        dest,
        expectedBytes: a.bytes,
        signal: ctrl.signal,
        onProgress: (p) => {
          rec.received = p.received;
          rec.total = p.total || a.bytes;
          this.progress(id, rec.received, rec.total, 'progress');
        },
      });
      if (a.archive) {
        const buf = fs.readFileSync(dest);
        fs.rmSync(dir, { recursive: true, force: true });
        if (a.archive === 'zip') extractZip(buf, dir);
        else extractTarGz(buf, dir);
        fs.rmSync(dest, { force: true });
        if (!findCliIn(dir)) throw new Error(tr('解包后没有找到 whisper-cli'));
      }
      this.d.audit?.({
        tool: 'voice_model_download',
        args: { id },
        decision: 'user',
        result: 'ok',
        ms: Date.now() - started,
      });
      this.progress(id, rec.total, rec.total, 'done');
      // 当前选中的模型还没下载时，自动改用刚下好的模型（少一步操作）
      if (a.kind === 'whisper-model') {
        const cur = findAsset(this.settings.whisperModel);
        if (!cur || !this.installed(cur)) this.setSettings({ whisperModel: a.id });
      }
      return { ok: true };
    } catch (e) {
      const aborted = ctrl.signal.aborted;
      const msg = aborted ? tr('已取消') : e instanceof Error ? e.message : String(e);
      this.progress(id, rec.received, rec.total, aborted ? 'cancelled' : 'error', msg);
      if (!aborted) this.d.logger.warn('语音模型下载失败', { id, error: msg } as never);
      return { ok: false, error: msg };
    } finally {
      this.downloads.delete(id);
      this.broadcast('ai:voice:changed', null);
    }
  }

  cancel(id: string): boolean {
    const d = this.downloads.get(id);
    d?.ctrl.abort();
    return !!d;
  }

  remove(id: string): boolean {
    const a = findAsset(id);
    if (!a) return false;
    fs.rmSync(this.assetDir(a), { recursive: true, force: true });
    this.broadcast('ai:voice:changed', null);
    return true;
  }

  /** 识别：wav = 16kHz 单声道 PCM16 */
  async transcribe(
    wav: Uint8Array,
    opts: { source: string; purpose?: 'command' | 'wake' },
  ): Promise<string> {
    const s = this.settings;
    const started = Date.now();
    // 唤醒词检测只走本地，绝不上传
    const engine = opts.purpose === 'wake' ? 'whisper-cpp' : s.engine;
    if (!(wav instanceof Uint8Array) || wav.byteLength < 44 + 3200)
      throw new VoiceError('empty', tr('录音太短了'));
    if (wav.byteLength > 25 * 1024 * 1024)
      throw new VoiceError('failed', tr('录音太长了（上限约 13 分钟）'));
    let text: string;
    if (engine === 'whisper-cpp') {
      const cli = this.locateCli();
      if (!cli) throw new VoiceError('no_engine', tr('未找到 whisper.cpp 引擎'));
      const m = findAsset(s.whisperModel);
      if (!m || !this.installed(m)) throw new VoiceError('no_model', tr('还没有下载识别模型'));
      text = await runWhisperCli({
        cli: cli.path,
        model: this.assetPath(m),
        wav,
        language:
          opts.purpose === 'wake' &&
          s.language === 'auto' &&
          /[\u4e00-\u9fff]/.test(s.wakeWord.phrase)
            ? 'zh'
            : s.language,
        // 不把唤醒词放进 prompt：whisper 会把 prompt 当作已说过的上文而略去这些词
        prompt:
          s.language === 'zh' ||
          (opts.purpose === 'wake' && /[\u4e00-\u9fff]/.test(s.wakeWord.phrase))
            ? tr('以下是普通话的句子。')
            : undefined,
        timeoutMs: opts.purpose === 'wake' ? 20_000 : 120_000,
      });
    } else {
      const r = this.readiness();
      if (!r.ok) throw new VoiceError(r.code ?? 'failed', r.message ?? tr('识别服务不可用'));
      const t = this.cloudTarget()!;
      text = await transcribeOpenAICompat({
        baseURL: t.baseURL,
        apiKey: t.apiKey,
        model: s.cloudModel,
        wav,
        language: s.language,
        signal: AbortSignal.timeout(120_000),
      });
    }
    if (opts.purpose !== 'wake')
      this.d.audit?.({
        tool: 'voice_transcribe',
        args: { source: opts.source, engine, seconds: Math.round((wav.byteLength - 44) / 32000) },
        decision: 'auto',
        result: text ? 'ok' : 'empty',
        ms: Date.now() - started,
        provider: engine === 'whisper-cpp' ? 'whisper.cpp' : cloudTargetId(s),
      });
    return text;
  }

  setActivity(a: VoiceActivity, source: string): void {
    const prev = this.activity;
    this.activity = a;
    this.broadcast('ai:voice:activity', { activity: a, source });
    // 用户一开口就打断正在播报的 TTS（barge-in）
    if (
      this.settings.bargeIn &&
      (a === 'hearing' || (a === 'listening' && source.endsWith(':ptt'))) &&
      prev !== a
    )
      this.broadcast('ai:voice:bargeIn', { source });
  }

  async sendToChat(text: string): Promise<void> {
    if (!this.d.openChat || !text.trim()) return;
    const chat = await this.d.openChat();
    const payload = { text: text.trim(), autoSend: this.settings.autoSend };
    const deliver = () => !chat.isDestroyed() && chat.webContents.send('ai:voice:inject', payload);
    if (chat.webContents.isLoading())
      chat.webContents.once('did-finish-load', () => setTimeout(deliver, 500));
    else deliver();
  }

  private progress(id: string, received: number, total: number, phase: string, error?: string) {
    this.broadcast('ai:voice:progress', { id, received, total, phase, error });
  }

  private broadcast(ch: string, payload: unknown) {
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed()) w.webContents.send(ch, payload);
  }

  registerIpc(): void {
    if (this.ipcDone) return;
    this.ipcDone = true;
    const handle = (ch: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) =>
      guardedHandle(ch, fn, { owner: 'VoiceService', wrapErrors: false, passEvent: true });
    handle('ai:voice:state', () => this.state());
    handle('ai:voice:setSettings', (_e, patch) => this.setSettings(patch));
    handle('ai:voice:ackCloud', () => this.ackCloud());
    handle('ai:voice:download', (_e, id) => this.download(String(id)));
    handle('ai:voice:cancel', (_e, id) => this.cancel(String(id)));
    handle('ai:voice:remove', (_e, id) => this.remove(String(id)));
    // VAD：每个窗口一个 Silero 会话；没有模型时渲染进程退回能量检测
    handle('ai:voice:vadOpen', async (e) => {
      const p = this.vadModelPath();
      if (!p) return { kind: 'energy' };
      const err = await warmup(p);
      if (err) {
        this.d.logger.warn('Silero VAD 加载失败，改用能量检测', { error: err } as never);
        return { kind: 'energy', error: err };
      }
      // 每个会话独立的 RNN 状态（同一窗口可有多个控制器）
      const wc = e.sender;
      const handle = `${wc.id}:${++this.vadSeq}`;
      this.vads.set(handle, new SileroStream(p));
      if (!this.vadOwners.has(wc.id)) {
        this.vadOwners.add(wc.id);
        wc.once('destroyed', () => {
          this.vadOwners.delete(wc.id);
          for (const k of [...this.vads.keys()]) if (k.startsWith(`${wc.id}:`)) this.vads.delete(k);
        });
      }
      return { kind: 'silero', handle };
    });
    handle('ai:voice:vadProb', async (e, h, frame) => {
      const key = String(h);
      if (!key.startsWith(`${e.sender.id}:`)) return 0;
      const v = this.vads.get(key);
      if (!v) return 0;
      const f = toFloat32(frame);
      return f ? v.prob(f) : 0;
    });
    handle('ai:voice:vadClose', (e, h) => {
      const key = String(h);
      if (key.startsWith(`${e.sender.id}:`)) this.vads.delete(key);
    });
    handle('ai:voice:transcribe', async (_e, wav, opts) => {
      const o = (opts ?? {}) as { source?: string; purpose?: 'command' | 'wake' };
      try {
        const buf = wav instanceof Uint8Array ? wav : new Uint8Array(wav as ArrayBuffer);
        const text = await this.transcribe(buf, {
          source: String(o.source ?? 'chat'),
          purpose: o.purpose,
        });
        return { ok: true, text };
      } catch (err) {
        const code = err instanceof VoiceError ? err.code : 'failed';
        return { ok: false, code, error: err instanceof Error ? err.message : String(err) };
      }
    });
    handle('ai:voice:activity', (_e, a, source) => {
      const ok = ['idle', 'listening', 'hearing', 'transcribing', 'wake-armed'].includes(String(a));
      if (ok) this.setActivity(a as VoiceActivity, String(source ?? ''));
      return ok;
    });
    handle('ai:voice:sendToChat', (_e, text) => this.sendToChat(String(text ?? '').slice(0, 4000)));
  }
}

let instance: VoiceService | null = null;
export function getVoiceService(deps?: VoiceDeps): VoiceService {
  if (!instance) {
    if (!deps) throw new Error('VoiceService not initialised');
    instance = new VoiceService(deps);
  }
  return instance;
}
