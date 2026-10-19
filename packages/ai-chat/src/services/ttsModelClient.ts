/**
 * 离线语音（sherpa-onnx TTS）模型按需下载：与主进程 tts/registerTtsModel（`ai:tts-model:*`）通信。
 * 模型不再随安装包分发；开启语音时下载到 userData，见 docs/design/tts-on-demand.md。
 * 没有 IPC（浏览器预览 / 测试）时 `available()` 为 false，界面不显示模型卡片。
 */
export interface TtsModelState {
  state: 'ready' | 'missing' | 'downloading' | 'error';
  source?: 'env' | 'resources' | 'dev' | 'userData';
  modelId: string;
  message?: string;
  phase?: 'download' | 'extract';
  received?: number;
  total?: number;
  partialBytes?: number;
  installedBytes?: number;
  voiceEnabled: boolean;
}

export interface TtsEnableResult {
  ok: boolean;
  voiceEnabled: boolean;
  /** 'cancelled' 或失败原因 */
  error?: string;
  status: TtsModelState;
}

interface Bridge {
  invoke(ch: string, ...a: unknown[]): Promise<unknown>;
  on?(ch: string, fn: (payload: unknown) => void): (() => void) | void;
}
const bridge = (): Bridge | undefined => (window as unknown as { aiIPC?: Bridge }).aiIPC;

const isState = (v: unknown): v is TtsModelState =>
  Boolean(v) && typeof (v as { state?: unknown }).state === 'string';

export const ttsModelClient = {
  available: () => Boolean(bridge()),
  async status(): Promise<TtsModelState | null> {
    const r = await bridge()
      ?.invoke('ai:tts-model:status')
      .catch(() => null);
    return isState(r) ? r : null;
  },
  /** 开 / 关语音；开启时缺模型会下载，失败或取消返回 ok:false 且语音保持关闭 */
  async setVoiceEnabled(enabled: boolean): Promise<TtsEnableResult | null> {
    const r = await bridge()
      ?.invoke('ai:tts-model:set-voice-enabled', enabled)
      .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return (r as TtsEnableResult | null) ?? null;
  },
  async download(): Promise<TtsEnableResult | null> {
    const r = await bridge()
      ?.invoke('ai:tts-model:download')
      .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return (r as TtsEnableResult | null) ?? null;
  },
  async cancel(): Promise<TtsModelState | null> {
    const r = await bridge()
      ?.invoke('ai:tts-model:cancel')
      .catch(() => null);
    return isState(r) ? r : null;
  },
  async remove(): Promise<TtsModelState | null> {
    const r = await bridge()
      ?.invoke('ai:tts-model:delete')
      .catch(() => null);
    return isState(r) ? r : null;
  },
  /** 订阅状态推送（进度 / 完成 / 失败 / 语音开关）；返回取消订阅 */
  subscribe(fn: (s: TtsModelState) => void): () => void {
    const off = bridge()?.on?.('ai:tts-model:changed', (p) => {
      if (isState(p)) fn(p);
    });
    return typeof off === 'function' ? off : () => undefined;
  },
};

/** 字节 → 「115.0 MB」 */
export function formatMB(bytes: number | undefined): string {
  return `${((bytes ?? 0) / 1024 / 1024).toFixed(1)} MB`;
}
