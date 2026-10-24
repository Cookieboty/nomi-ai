/**
 * 内置插件里暂时还留在主进程的能力（转录解析依赖主进程的 i18n 与流式解析），宿主加载时挂到契约上，
 * 让插件对外是完整的（§5.7）。迁进插件包之后删掉这里对应的一项即可。
 */
import path from 'node:path';

import type { CliMainImpl, HistoryParse } from '@nomi-ai/cli-sdk';

import { parseTranscript, titleFromMessages, type HistoryBackend } from './historyTranscript';

const HISTORY_BACKENDS: readonly string[] = ['claude', 'codex', 'dsh', 'gemini', 'grok'];

/** 会话 id 的兜底：文件名（Claude / Codex）或会话目录名（Grok / dsh 的 dirId） */
function sessionIdOf(f: { path: string; dirId?: string }): string {
  return f.dirId ?? path.basename(f.path).replace(/\.jsonl(?:\.zstd?)?$/, '');
}

export function extendBuiltinPlugin(id: string, impl: CliMainImpl): CliMainImpl {
  if (!impl.history || !HISTORY_BACKENDS.includes(id) || impl.history.parse) return impl;
  const backend = id as HistoryBackend;
  return {
    ...impl,
    history: {
      ...impl.history,
      parse: (text, f): HistoryParse => {
        const messages = parseTranscript(backend, text, f.mtime);
        if (!messages.length && text.trim())
          return { error: 'no messages recognised', formatHint: backend };
        const title = titleFromMessages(messages);
        return {
          meta: { sessionId: sessionIdOf(f), ...(title ? { title } : {}) },
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        };
      },
    },
  };
}
