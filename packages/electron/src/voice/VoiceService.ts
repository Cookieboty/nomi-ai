/**
 * 语音输入服务（主进程）：设置、按需下载本地模型（进度 + 许可 + 校验）、识别分派
 * （本地 whisper.cpp / OpenAI 兼容服务）、语音活动广播（看板娘表情 / 打断 TTS）、
 * 从看板娘把识别结果投递到对话窗口。所有 IPC 都在 `ai:voice:*` 下。
 *
 * 隐私：录音只在内存 / 临时文件里，识别完立即删除；不落盘、不进日志。
 * 云端识别首次使用必须用户确认；桌面能力「仅本地模型」开启时拒绝云端识别。审计只记来源 / 引擎 / 时长。
 *
 * 豆包流式语音识别 2.0（#61，engine = 'volc'）：渲染进程按住说话时边录边推 PCM（ai:voice:stream*），
 * 主进程转发给火山 WebSocket，临时结果只回给发起的窗口。API Key 用 safeStorage 加密单独保存
 * （不在 settings.json 里，公开 IPC 只回 hasKey）；「仅本地模型」在建连前和每次推音频时都检查。
 */
import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron';

import { t as tr } from '../i18n';
import { guardedHandle } from '../security/guardedIpc';
import { canEncryptSecrets, decryptSecret, encryptSecret } from '../security/secretStorage';

import { assetsFor, findAsset, type VoiceAsset } from './catalog';
import { transcribeOpenAICompat } from './cloudAsr';
import { downloadVerified, extractTarGz, extractZip } from './download';
import {
  DEFAULT_VOICE_SETTINGS,
  VOLC_RESOURCES,
  VOLC_TARGET_ID,
  cloudTargetId,
  sanitizeVoiceSettings,
  type VoiceSettings,
} from './settings';
import { SileroStream, toFloat32, warmup } from './sileroNode';
import {
  VOLC_ASR_HOST,
  VOLC_PACKET_BYTES,
  VolcAsrError,
  VolcAsrSession,
  probeVolc,
  type WsFactory,
} from './volcAsr';
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
  /** 测试注入：豆包 WebSocket 传输与地址（生产固定为官方端点） */
  volcWs?: WsFactory;
  volcUrl?: string;
  volcTimeouts?: { connectMs?: number; finalMs?: number; idleMs?: number; probeWaitMs?: number };
  /** 测试注入：整段识别时每个 200ms 包之间的间隔 */
  volcPaceMs?: number;
}

/** 一次流式识别（按住说话）的主进程状态 */
interface VolcStream {
  session: VolcAsrSession;
  owner: number;
  source: string;
  started: number;
  bytes: number;
  /** 只在开启「失败后回退离线」时保留，用于本地重识别；结束即丢弃 */
  pcm: Buffer[] | null;
  /**
   * recording：还在推音频；finalizing：已松开，在等握手 / 最终结果 / 本地回退。
   * 结束中的会话仍登记在 streams 里，取消、切引擎、清 Key、窗口销毁都能撤销它（#67）。
   */
  phase: 'recording' | 'finalizing';
  /** 被撤销的原因：之后不回退、不交付晚到的结果 */
  revoked: VoiceError | null;
}

const MAX_STREAM_BYTES = 25 * 1024 * 1024;
const MAX_PUSH_BYTES = 64 * 1024;
const MAX_STREAMS_PER_SENDER = 2;

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

const localOnlyError = () =>
  new VoiceError('local_only', tr('已开启「仅本地模型」，不能把录音发送到云端。'));

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
  private readonly streams = new Map<string, VolcStream>();
  private readonly streamOwners = new Set<number>();
  private streamSeq = 0;

  constructor(private readonly d: VoiceDeps) {
    this.settings = this.load();
  }

  private get settingsFile() {
    return path.join(this.d.root, 'settings.json');
  }
  private get modelsDir() {
    return path.join(this.d.root, 'models');
  }
  private get volcKeyFile() {
    return path.join(this.d.root, 'volc-key.json');
  }

  // ───────────── 豆包 API Key（safeStorage 加密，单独文件） ─────────────
  private volcKey(): string {
    try {
      const j = JSON.parse(fs.readFileSync(this.volcKeyFile, 'utf8')) as { key?: unknown };
      return typeof j.key === 'string' ? decryptSecret(j.key) : '';
    } catch {
      return '';
    }
  }

  hasVolcKey(): boolean {
    return !!this.volcKey();
  }

  /** 保存 / 替换 Key。安全存储不可用时拒绝（不写明文，#35） */
  setVolcKey(raw: unknown): { ok: boolean; error?: string } {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!key || key.length > 256 || /\s/.test(key))
      return { ok: false, error: tr('API Key 格式不正确') };
    const unavailable = tr('系统安全存储不可用，无法保存 API Key。');
    if (!canEncryptSecrets()) return { ok: false, error: unavailable };
    let enc: string;
    try {
      enc = encryptSecret(key, unavailable);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    fs.mkdirSync(this.d.root, { recursive: true });
    fs.writeFileSync(this.volcKeyFile, JSON.stringify({ key: enc }), { mode: 0o600 });
    this.d.audit?.({
      tool: 'voice_volc_key',
      args: { action: 'set' },
      decision: 'user',
      result: 'ok',
    });
    this.broadcast('ai:voice:changed', null);
    return { ok: true };
  }

  clearVolcKey(): boolean {
    this.cancelStreams();
    fs.rmSync(this.volcKeyFile, { force: true });
    this.d.audit?.({
      tool: 'voice_volc_key',
      args: { action: 'clear' },
      decision: 'user',
      result: 'ok',
    });
    this.broadcast('ai:voice:changed', null);
    return true;
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
    // 不再使用豆包时立即停止进行中的云端会话
    if (this.settings.engine !== 'volc') this.cancelStreams();
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
    if (s.engine === 'volc') {
      if (!this.hasVolcKey())
        return {
          ok: false,
          local: false,
          code: 'no_provider',
          message: tr('请先在语音设置里填写豆包语音的 API Key。'),
        };
      if (this.d.localOnly?.())
        return {
          ok: false,
          local: false,
          code: 'local_only',
          message: tr('已开启「仅本地模型」，不能把录音发送到云端。'),
        };
      if (!s.cloudAcked.includes(VOLC_TARGET_ID))
        return {
          ok: false,
          local: false,
          code: 'cloud_not_acked',
          message: tr('录音将发送给「{0}」识别，需要你确认一次。', tr('豆包语音（火山引擎）')),
        };
      return { ok: true, local: false };
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
      volc: {
        hasKey: this.hasVolcKey(),
        host: VOLC_ASR_HOST,
        resources: [...VOLC_RESOURCES],
        canStoreKey: canEncryptSecrets(),
        /** 回退用的本地识别是否就绪（引擎 + 已选模型都在） */
        fallbackReady: this.localReady(),
      },
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
    let fallback = false;
    if (engine === 'whisper-cpp') {
      text = await this.localTranscribe(wav, opts.purpose);
    } else if (engine === 'volc') {
      const r = this.readiness();
      if (!r.ok) throw new VoiceError(r.code ?? 'failed', r.message ?? tr('识别服务不可用'));
      const pcm = wav.subarray(44);
      try {
        text = await this.volcBatch(pcm);
      } catch (e) {
        text = await this.volcFallback(e, pcm);
        fallback = true;
      }
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
        args: {
          source: opts.source,
          engine,
          seconds: Math.round((wav.byteLength - 44) / 32000),
          ...(fallback ? { fallback: 'whisper.cpp' } : {}),
        },
        decision: 'auto',
        result: text ? 'ok' : 'empty',
        ms: Date.now() - started,
        provider: engine === 'whisper-cpp' ? 'whisper.cpp' : cloudTargetId(s),
      });
    return text;
  }

  /** 本地 whisper.cpp 引擎 + 已选模型都在 */
  localReady(): boolean {
    const m = findAsset(this.settings.whisperModel);
    return !!this.locateCli() && !!m && this.installed(m);
  }

  private async localTranscribe(wav: Uint8Array, purpose?: 'command' | 'wake'): Promise<string> {
    const s = this.settings;
    const opts = { purpose };
    const cli = this.locateCli();
    if (!cli) throw new VoiceError('no_engine', tr('未找到 whisper.cpp 引擎'));
    const m = findAsset(s.whisperModel);
    if (!m || !this.installed(m)) throw new VoiceError('no_model', tr('还没有下载识别模型'));
    return runWhisperCli({
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
  }

  // ───────────── 豆包流式识别 ─────────────
  private newVolcSession(onPartial?: (text: string) => void): VolcAsrSession {
    const to = this.d.volcTimeouts ?? {};
    return new VolcAsrSession({
      apiKey: this.volcKey(),
      resourceId: this.settings.volcResourceId,
      url: this.d.volcUrl,
      ws: this.d.volcWs,
      connectTimeoutMs: to.connectMs,
      finalTimeoutMs: to.finalMs,
      idleTimeoutMs: to.idleMs,
      onPartial,
      // 真正发送音频前再查一次：握手 / 等最终结果期间开启「仅本地模型」，缓存的音频也不再外发
      mayUpload: () => !this.d.localOnly?.(),
    });
  }

  /** 整段音频（免按键分句）走豆包：建连后按 200ms 分包推送 */
  private async volcBatch(pcm: Uint8Array): Promise<string> {
    const session = this.newVolcSession();
    await session.start();
    const pace = this.d.volcPaceMs ?? 40;
    for (let o = 0; o < pcm.byteLength; o += VOLC_PACKET_BYTES) {
      if (this.d.localOnly?.()) {
        session.cancel();
        throw new VoiceError('local_only', tr('已开启「仅本地模型」，不能把录音发送到云端。'));
      }
      session.push(pcm.subarray(o, Math.min(pcm.byteLength, o + VOLC_PACKET_BYTES)));
      if (pace) await new Promise((r) => setTimeout(r, pace));
    }
    return session.finish();
  }

  /** 云端失败：用户开启了回退且本地模型已安装时改用 whisper.cpp；否则抛出可读错误 */
  private async volcFallback(e: unknown, pcm: Uint8Array): Promise<string> {
    if (e instanceof VoiceError) throw e;
    const err = e instanceof VolcAsrError ? e : null;
    if (err?.kind === 'cancelled') throw new VoiceError('empty', err.message);
    const message = err?.message ?? (e instanceof Error ? e.message : String(e));
    if (this.settings.volcFallback && err) {
      if (this.localReady() && pcm.byteLength >= 3200) {
        this.d.logger.warn('豆包识别失败，改用本地 whisper.cpp', { kind: err.kind } as never);
        return this.localTranscribe(pcmToWav(pcm), 'command');
      }
      throw new VoiceError('failed', tr('{0}；本地离线模型未安装，无法回退。', message));
    }
    const code: VoiceError['code'] =
      err?.kind === 'auth' || err?.kind === 'not_granted'
        ? 'no_provider'
        : err?.kind === 'empty'
          ? 'empty'
          : 'failed';
    throw new VoiceError(code, message);
  }

  private sendStream(wc: WebContents, payload: Record<string, unknown>) {
    if (!wc.isDestroyed()) wc.send('ai:voice:stream', payload);
  }

  streamStart(
    wc: WebContents,
    source: string,
  ): { ok: true; id: string } | { ok: false; code: VoiceError['code']; error: string } {
    if (this.settings.engine !== 'volc')
      return { ok: false, code: 'no_provider', error: tr('当前识别引擎不支持流式识别') };
    const r = this.readiness();
    if (!r.ok) return { ok: false, code: r.code ?? 'failed', error: r.message ?? '' };
    // 同一窗口最多 MAX 个会话（含结束中的）：多出来的（旧的）直接取消
    const mine = [...this.streams.entries()].filter(([, v]) => v.owner === wc.id);
    for (const [k, v] of mine.slice(0, Math.max(0, mine.length - MAX_STREAMS_PER_SENDER + 1)))
      this.revokeStream(k, v);
    const id = `${wc.id}:${++this.streamSeq}`;
    const session = this.newVolcSession((text) => {
      const rec = this.streams.get(id);
      if (rec?.session === session && rec.phase === 'recording')
        this.sendStream(wc, { id, type: 'partial', text });
    });
    this.streams.set(id, {
      session,
      owner: wc.id,
      source: source.slice(0, 32),
      started: Date.now(),
      bytes: 0,
      pcm: this.settings.volcFallback ? [] : null,
      phase: 'recording',
      revoked: null,
    });
    if (!this.streamOwners.has(wc.id)) {
      this.streamOwners.add(wc.id);
      wc.once('destroyed', () => {
        this.streamOwners.delete(wc.id);
        for (const [k, v] of [...this.streams.entries()])
          if (v.owner === wc.id) this.revokeStream(k, v);
      });
    }
    // 建连失败（鉴权 / 未开通等）尽早告诉界面；最终错误仍由 streamStop 返回
    session.start().catch((e: unknown) => {
      if (this.streams.get(id)?.session !== session) return;
      const err = e instanceof VolcAsrError ? e : null;
      if (err?.kind === 'cancelled') return;
      this.sendStream(wc, { id, type: 'error', error: err?.message ?? String(e) });
    });
    return { ok: true, id };
  }

  private ownStream(wc: WebContents, id: string): VolcStream | null {
    const rec = this.streams.get(id);
    return rec && rec.owner === wc.id ? rec : null;
  }

  streamPush(wc: WebContents, id: string, pcm: unknown): boolean {
    const rec = this.ownStream(wc, id);
    if (!rec || rec.phase !== 'recording') return false;
    const buf =
      pcm instanceof Uint8Array ? pcm : pcm instanceof ArrayBuffer ? new Uint8Array(pcm) : null;
    if (!buf || buf.byteLength === 0 || buf.byteLength > MAX_PUSH_BYTES) return false;
    // 运行中切到「仅本地模型」/ 换了引擎：立即停止，后续音频不再外发
    if (this.d.localOnly?.() || this.settings.engine !== 'volc') {
      const err = localOnlyError();
      this.revokeStream(id, rec, err);
      this.sendStream(wc, { id, type: 'error', code: err.code, error: err.message });
      return false;
    }
    rec.bytes += buf.byteLength;
    if (rec.bytes > MAX_STREAM_BYTES) {
      const err = new VoiceError('failed', tr('录音太长了（上限约 13 分钟）'));
      this.revokeStream(id, rec, err);
      this.sendStream(wc, { id, type: 'error', error: err.message });
      return false;
    }
    if (rec.pcm) rec.pcm.push(Buffer.from(buf));
    rec.session.push(buf);
    return true;
  }

  async streamStop(
    wc: WebContents,
    id: string,
  ): Promise<
    | { ok: true; text: string; fallback?: boolean }
    | { ok: false; code: VoiceError['code']; error: string }
  > {
    const rec = this.ownStream(wc, id);
    // 重复 stop（已在结束中）与未知会话一样：不重复发结束帧、不重复交付
    if (!rec || rec.phase !== 'recording')
      return { ok: false, code: 'failed', error: tr('识别会话已结束') };
    // 结束期间仍登记在 streams 里（等握手 / 最终结果 / 回退），撤销入口照样能找到它
    rec.phase = 'finalizing';
    try {
      return await this.finishStream(id, rec);
    } finally {
      // 只删自己这条登记（被撤销时已删）
      if (this.streams.get(id) === rec) this.streams.delete(id);
    }
  }

  private async finishStream(
    id: string,
    rec: VolcStream,
  ): Promise<
    | { ok: true; text: string; fallback?: boolean }
    | { ok: false; code: VoiceError['code']; error: string }
  > {
    const pcm = rec.pcm ? Buffer.concat(rec.pcm) : new Uint8Array(0);
    rec.pcm = null;
    let text: string;
    let fallback = false;
    try {
      if (this.d.localOnly?.()) {
        const err = localOnlyError();
        this.revokeStream(id, rec, err);
        throw err;
      }
      try {
        text = (await rec.session.finish()).trim();
      } catch (e) {
        // 已撤销：不回退，这段录音不再处理
        const revoked = this.revokedReason(rec);
        if (revoked) throw revoked;
        text = (await this.volcFallback(e, pcm)).trim();
        fallback = true;
      }
      // 等结果 / 本地回退期间被撤销：丢弃晚到的结果
      const revoked = this.revokedReason(rec);
      if (revoked) throw revoked;
    } catch (err) {
      const code = err instanceof VoiceError ? err.code : 'failed';
      this.d.audit?.({
        tool: 'voice_transcribe',
        args: { source: rec.source, engine: 'volc', seconds: Math.round(rec.bytes / 32000) },
        decision: 'auto',
        result: 'error',
        ms: Date.now() - rec.started,
        provider: VOLC_TARGET_ID,
      });
      return { ok: false, code, error: err instanceof Error ? err.message : String(err) };
    }
    this.d.audit?.({
      tool: 'voice_transcribe',
      args: {
        source: rec.source,
        engine: 'volc',
        seconds: Math.round(rec.bytes / 32000),
        ...(fallback ? { fallback: 'whisper.cpp' } : {}),
      },
      decision: 'auto',
      result: text ? 'ok' : 'empty',
      ms: Date.now() - rec.started,
      provider: VOLC_TARGET_ID,
    });
    return fallback ? { ok: true, text, fallback } : { ok: true, text };
  }

  /** 取消（录音中或结束中）：关连接、丢弃结果；别的窗口不能取消 */
  streamCancel(wc: WebContents, id: string): boolean {
    const rec = this.ownStream(wc, id);
    if (!rec) return false;
    this.revokeStream(id, rec);
    return true;
  }

  /** 切引擎 / 清 Key：撤销所有会话，包括已松开、还在等结果的 */
  private cancelStreams(): void {
    for (const [k, v] of [...this.streams.entries()]) this.revokeStream(k, v);
  }

  /**
   * 撤销一个会话：立即关连接、丢掉缓存音频与回退用的 PCM；进行中的 streamStop 随后返回 reason，
   * 不回退、不交付晚到的结果。已经发出去的音频收不回来，这里保证的是之后不再发送和处理。
   */
  private revokeStream(id: string, rec: VolcStream, reason?: VoiceError): void {
    rec.revoked ??= reason ?? new VoiceError('empty', tr('已取消'));
    rec.pcm = null;
    rec.session.cancel();
    if (this.streams.get(id) === rec) this.streams.delete(id);
  }

  /** 会话是否已被撤销（含会话自己因「仅本地模型」在发送前取消的情况） */
  private revokedReason(rec: VolcStream): VoiceError | null {
    if (rec.revoked) return rec.revoked;
    if (rec.session.error?.kind === 'cancelled' && this.d.localOnly?.()) return localOnlyError();
    return null;
  }

  /** 用户点「测试连接」：只建连 + 发参数包，不发送音频 */
  async volcTest(): Promise<{ ok: boolean; message: string }> {
    if (this.settings.engine !== 'volc')
      return { ok: false, message: tr('请先把识别引擎切换为豆包流式语音识别 2.0') };
    const r = this.readiness();
    if (!r.ok) return { ok: false, message: r.message ?? '' };
    const to = this.d.volcTimeouts ?? {};
    try {
      await probeVolc({
        apiKey: this.volcKey(),
        resourceId: this.settings.volcResourceId,
        url: this.d.volcUrl,
        ws: this.d.volcWs,
        connectTimeoutMs: to.connectMs,
        waitMs: to.probeWaitMs,
      });
      this.d.audit?.({ tool: 'voice_volc_test', args: {}, decision: 'user', result: 'ok' });
      return {
        ok: true,
        message: tr('已连接到豆包语音并通过鉴权（没有发送音频，未做识别测试）。'),
      };
    } catch (e) {
      this.d.audit?.({ tool: 'voice_volc_test', args: {}, decision: 'user', result: 'error' });
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
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
    // 豆包流式语音识别 2.0（#61）
    handle('ai:voice:volcSetKey', (_e, key) => this.setVolcKey(key));
    handle('ai:voice:volcClearKey', () => this.clearVolcKey());
    handle('ai:voice:volcTest', () => this.volcTest());
    handle('ai:voice:streamStart', (e, o) =>
      this.streamStart(e.sender, String((o as { source?: unknown } | null)?.source ?? 'chat')),
    );
    handle('ai:voice:streamPush', (e, id, pcm) => this.streamPush(e.sender, String(id), pcm));
    handle('ai:voice:streamStop', (e, id) => this.streamStop(e.sender, String(id)));
    handle('ai:voice:streamCancel', (e, id) => this.streamCancel(e.sender, String(id)));
  }
}

/** 16kHz 单声道 PCM16 → WAV（44 字节头） */
export function pcmToWav(pcm: Uint8Array): Uint8Array {
  const out = Buffer.alloc(44 + pcm.byteLength);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + pcm.byteLength, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24);
  out.writeUInt32LE(32000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(pcm.byteLength, 40);
  out.set(pcm, 44);
  return out;
}

let instance: VoiceService | null = null;
export function getVoiceService(deps?: VoiceDeps): VoiceService {
  if (!instance) {
    if (!deps) throw new Error('VoiceService not initialised');
    instance = new VoiceService(deps);
  }
  return instance;
}
