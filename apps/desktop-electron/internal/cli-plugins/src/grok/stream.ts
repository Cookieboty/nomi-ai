/**
 * Grok Build streaming-json 行 → HarnessEvent（从主进程 cli/streamParse.ts 搬来，§5.4）。
 */
import { t, type HarnessEvent } from '@nomi-ai/cli-sdk';

import {
  MAX_THINKING,
  clip,
  imageMarkdown,
  inputText,
  outputText,
  parseUsage,
  textWithImage,
  withOpt,
} from '../shared/stream';

/**
 * Grok Build `--output-format streaming-json`（官方 headless 文档，2026-10）：
 * NDJSON，每行一个 type 字段：text / thought / tool_call / tool_call_update /
 * image / image_generation / generated_image / usage / plan / end / error（其它类型静默跳过）。
 * 字段名按文档：text.data、tool_call.toolName / toolCallId / status、
 * end.sessionId、error.message。无法识别的行静默跳过，不编造格式。
 */
export function parseGrokLine(line: string): HarnessEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = String(j.type ?? '');
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (type) {
    case 'text': {
      const data = str(j.data) || str(j.text);
      const image = imageMarkdown(data, false);
      if (image) return [{ type: 'text-delta', text: `${image}\n\n` }];
      return data ? [{ type: 'text-delta', text: data }] : [];
    }
    case 'tool_call': {
      const name = str(j.toolName) || str(j.title) || str(j.kind) || 'tool';
      const id = str(j.toolCallId) || str(j.id);
      const status = str(j.status);
      const input = inputText(j.rawInput ?? j.input ?? j.arguments);
      if (status === 'completed' || status === 'failed' || status === 'error') {
        const rawOutput = j.rawOutput ?? j.output ?? j.content;
        const image = imageMarkdown(rawOutput, /image|photo|picture|generate/i.test(name));
        return [
          withOpt(
            {
              type: 'tool',
              name,
              status: status === 'completed' ? 'done' : 'error',
              detail: id || undefined,
            } as HarnessEvent,
            { input, output: outputText(rawOutput) },
          ),
          ...(image ? [{ type: 'text-delta' as const, text: `${image}\n\n` }] : []),
        ];
      }
      return [
        withOpt({ type: 'tool', name, status: 'start', detail: id || undefined } as HarnessEvent, {
          input,
        }),
      ];
    }
    case 'tool_call_update': {
      const id = str(j.toolCallId) || str(j.id);
      const status = str(j.status);
      if (!status) return [];
      if (status === 'in_progress' || status === 'pending') return [];
      const rawOutput = j.rawOutput ?? j.output ?? j.content;
      const image = imageMarkdown(rawOutput, /image|photo|picture|generate/i.test(str(j.toolName)));
      return [
        withOpt(
          {
            type: 'tool',
            name: str(j.toolName) || str(j.title) || 'tool',
            status: status === 'completed' ? 'done' : 'error',
            detail: id || undefined,
          } as HarnessEvent,
          {
            input: inputText(j.rawInput ?? j.input),
            output: outputText(rawOutput),
          },
        ),
        ...(image ? [{ type: 'text-delta' as const, text: `${image}\n\n` }] : []),
      ];
    }
    case 'image':
    case 'image_generation':
    case 'generated_image': {
      const image = imageMarkdown(
        j.image ?? j.images ?? j.data ?? j.content ?? j.rawOutput ?? j.output ?? j,
      );
      return image ? [{ type: 'text-delta', text: `${image}\n\n` }] : [];
    }
    case 'end': {
      const endText = str(j.text);
      const image =
        imageMarkdown(j.output ?? j.content ?? j.images) || imageMarkdown(endText, false);
      // end.usage 是整轮累计（计费口径）；当前上下文已由前面逐请求的 usage 行给出，合并时保留
      return [
        withOpt(
          {
            type: 'done',
            text: textWithImage(endText, image),
            sessionId: str(j.sessionId) || undefined,
          } as HarnessEvent,
          { usage: parseUsage(j.usage) },
        ),
      ];
    }
    case 'error':
      return [{ type: 'error', message: str(j.message) || t('electron.common.grok-error') }];
    case 'thought': {
      const data = str(j.data) || str(j.text);
      return data ? [{ type: 'thinking', text: clip(data, MAX_THINKING) }] : [];
    }
    case 'usage': {
      // 每次请求一行（1.0.67 实测，end.usage 才是整轮累计）：input_tokens 不含缓存 → 当前上下文要加上缓存读
      const raw = (j.usage ?? j.data ?? j) as Record<string, unknown>;
      const base = parseUsage(raw, { costUsd: j.costUsd ?? j.cost });
      const usage = base
        ? withOpt(
            { ...base },
            {
              contextTokens:
                (base.inputTokens ?? 0) + (base.cacheReadTokens ?? 0) + (base.outputTokens ?? 0) ||
                undefined,
            },
          )
        : undefined;
      if (!usage) return [];
      return usage.contextTokens
        ? [
            { type: 'context', tokens: usage.contextTokens },
            { type: 'done', text: '', usage },
          ]
        : [{ type: 'done', text: '', usage }];
    }
    case 'plan':
    case 'available_commands':
      return [];
    default:
      return [];
  }
}

/** 有状态的 Grok 解析器：tool_call_update 可能不带 toolName，按 toolCallId 补回。 */
export function createGrokParser(): (line: string) => HarnessEvent[] {
  const names = new Map<string, string>();
  return (line) =>
    parseGrokLine(line).map((ev) => {
      if (ev.type !== 'tool' || !ev.detail) return ev;
      if (ev.status === 'start') {
        names.set(ev.detail, ev.name);
        return ev;
      }
      const name = names.get(ev.detail);
      if (name) names.delete(ev.detail);
      return name && ev.name === 'tool' ? { ...ev, name } : ev;
    });
}
