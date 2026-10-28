/**
 * 朗读 AI 回复（对话窗口一侧）：只用于普通的 Nomi 对话（不含编程助手 / CLI 代理标签、`/agent` 委派）。
 * 流式回复按句切分（ReplySpeechStream：去掉代码块、思考过程、表格、链接地址等，约前 300 字），
 * 每凑够一句就经主进程 tts.reply（契约）转给看板娘窗口播放（口型同步、预取下一句都在那边）。
 * 是否真的朗读由主进程按配置决定（实时朗读引擎可用 + 「朗读 AI 回复」开关）；失败静默。
 */
import { ReplySpeechStream } from '@nomi-ai/types';

import { api, hasTransport } from './api';

type ReplyMsg =
  { op: 'say'; id: string; text: string } | { op: 'end'; id: string } | { op: 'stop'; id?: string };

const send = (msg: ReplyMsg): void => {
  if (!hasTransport()) return;
  try {
    void api.tts.reply(msg).catch(() => undefined);
  } catch {
    /* 朗读失败不影响对话 */
  }
};

export interface ReplySpeaker {
  /** 收到一段流式文本 */
  push(delta: string): void;
  /** 回复生成完毕：念完剩下的半句 */
  finish(): void;
  /** 立即打断这条回复 */
  stop(): void;
}

let current: { id: string; stopped: boolean } | null = null;

/** 打断正在朗读的 AI 回复（用户发新消息 / 停止生成 / 切换会话 / 按住说话） */
export function stopReplySpeech(): void {
  const c = current;
  current = null;
  if (c) c.stopped = true;
  send({ op: 'stop', ...(c ? { id: c.id } : {}) });
}

/** 开始朗读一条新回复（会先打断上一条） */
export function startReplySpeech(id: string, sink: (m: ReplyMsg) => void = send): ReplySpeaker {
  if (current) stopReplySpeech();
  const me = { id, stopped: false };
  current = me;
  const stream = new ReplySpeechStream();
  const emit = (texts: string[]) => {
    for (const text of texts) if (!me.stopped) sink({ op: 'say', id, text });
  };
  return {
    push(delta) {
      if (!me.stopped && !stream.done) emit(stream.push(delta));
    },
    finish() {
      if (me.stopped) return;
      emit(stream.finish());
      sink({ op: 'end', id });
      if (current === me) current = null;
    },
    stop() {
      if (me.stopped) return;
      me.stopped = true;
      if (current === me) current = null;
      sink({ op: 'stop', id });
    },
  };
}
