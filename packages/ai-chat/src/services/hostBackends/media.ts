/**
 * D1：把契约接到共享包的注入点上（只属于 D1，见 ../api.ts）。
 *
 * `@nomi-ai/voice` 不 import 契约：这里把 `voice.*` 过程与事件包成它的 `VoiceApi`，经
 * `setVoiceBackend` 注入。流式识别（`voice.streamStart`）的第一条
 * chunk 是启动结果，之后的临时结果 / 错误转给 `onStream` 的订阅者（控制器按会话 id 过滤）。
 *
 * 看板娘窗口（renderer）有一份同样的适配：两个视图各自只有自己的 `services/api.ts` 与 hostBackends。
 */

import type { AppClient } from '@nomi-ai/ai-sdk-client';
import {
  setVoiceBackend,
  type ProgressEvent,
  type StreamEvent,
  type StreamStartResult,
  type TranscribeResult,
  type VoiceApi,
  type VoiceSettingsView,
  type VoiceStateView,
} from '@nomi-ai/voice';

/** 契约输出（looseObject / 宽松枚举）→ 语音包的视图类型：形状已由契约校验，这里只在类型上放行 */
const as = <T>(p: Promise<unknown>): Promise<T> => p as Promise<T>;

export function contractVoiceApi(api: AppClient): VoiceApi {
  const streamListeners = new Set<(e: StreamEvent) => void>();

  const pump = async (it: AsyncIterator<unknown>): Promise<void> => {
    try {
      for (;;) {
        const n = await it.next();
        if (n.done) return;
        const e = n.value as StreamEvent;
        for (const fn of [...streamListeners]) fn(e);
      }
    } catch {
      /* 会话被取消 / 连接断开：最终结果由 streamStop 返回 */
    }
  };

  return {
    state: () => as<VoiceStateView>(api.voice.state()),
    setSettings: (p: Partial<VoiceSettingsView>) => as<VoiceSettingsView>(api.voice.setSettings(p)),
    ackCloud: () => as<VoiceSettingsView>(api.voice.ackCloud()),
    download: (id: string) => api.voice.download({ id }),
    cancel: (id: string) => api.voice.cancel({ id }),
    remove: (id: string) => api.voice.remove({ id }),
    vadOpen: () => api.voice.vadOpen(),
    // 只传这一帧的字节（结构化克隆会复制整个底层 ArrayBuffer）
    vadProb: (handle: string, frame: Float32Array) =>
      api.voice.vadProb({
        handle,
        frame: new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength).slice(),
      }),
    vadClose: (handle: string) => api.voice.vadClose({ handle }),
    transcribe: (wav: Uint8Array, source: string, purpose: 'command' | 'wake' = 'command') =>
      as<TranscribeResult>(api.voice.transcribe({ wav, source, purpose })),
    activity: (a: string, source: string) => api.voice.activity({ activity: a, source }),
    sendToChat: (text: string) => api.voice.sendToChat({ text }),
    volcSetKey: (key: string) => api.voice.volcSetKey({ key }),
    volcClearKey: () => api.voice.volcClearKey(),
    volcTest: () => api.voice.volcTest(),
    streamStart: async (source: string): Promise<StreamStartResult> => {
      const it = api.voice.streamStart({ source })[Symbol.asyncIterator]();
      const first = await it.next();
      const start = first.done ? null : first.value;
      if (!start || start.type !== 'start') {
        void it.return?.();
        return { ok: false, code: 'failed', error: '' };
      }
      if (!start.ok) return { ok: false, code: start.code, error: start.error };
      void pump(it);
      return { ok: true, id: start.id };
    },
    streamPush: (id: string, pcm: Uint8Array) => api.voice.streamPush({ id, pcm }),
    streamStop: (id: string) => as<TranscribeResult>(api.voice.streamStop({ id })),
    streamCancel: (id: string) => api.voice.streamCancel({ id }),
    onStream: (fn: (e: StreamEvent) => void) => {
      streamListeners.add(fn);
      return () => {
        streamListeners.delete(fn);
      };
    },
    onProgress: (fn: (e: ProgressEvent) => void) =>
      api.on('voice.progress', (e) => fn(e as ProgressEvent)),
    onChanged: (fn: () => void) => api.on('voice.changed', () => fn()),
    onActivity: (fn: (e: { activity: string; source: string }) => void) =>
      api.on('voice.activity', (e) => fn(e)),
    onBargeIn: (fn: (e: { source: string }) => void) => api.on('voice.bargeIn', (e) => fn(e)),
    onInject: (fn: (e: { text: string; autoSend: boolean }) => void) => {
      // 先订阅再拉取：看板娘打开本窗口时页面还没订阅，内核留着的那一次在这里取回
      const off = api.on('voice.inject', (e) => fn(e));
      api.voice
        .takePendingInject()
        .then((e) => {
          if (e) fn(e);
        })
        .catch(() => undefined);
      return off;
    },
  };
}

export function installMediaBackends(api: AppClient): void {
  setVoiceBackend(contractVoiceApi(api));
}
