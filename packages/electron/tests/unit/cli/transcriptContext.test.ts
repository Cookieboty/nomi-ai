jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');
jest.unmock('node:os');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  claudeProjectDirName,
  claudeTranscriptContext,
  lastTranscriptContext,
} from '../../../src/cli/transcriptContext';

const assistant = (usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-opus-5-5', usage, content: [] },
    ...extra,
  });
const boundary = (post?: number) =>
  JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    compactMetadata: { trigger: 'auto', preTokens: 372759, ...(post ? { postTokens: post } : {}) },
  });

const sum = (b: object | undefined) =>
  (Object.values(b ?? {}) as number[]).reduce((n, x) => n + x, 0);

describe('lastTranscriptContext', () => {
  const user = (text: string) => JSON.stringify({ type: 'user', message: { content: text } });
  const toolResult = (out: string) =>
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: out }] },
    });

  it('total = last main-thread request; breakdown only after the last compaction, sums to total', () => {
    const text = [
      user('旧问题'.repeat(1000)),
      assistant({ input_tokens: 1, cache_read_input_tokens: 372000, output_tokens: 300 }),
      boundary(15996),
      user('This session is being continued from a previous conversation…'),
      // 压缩后第一次请求：61834 里除了摘要，剩下的就是系统提示 / 工具定义 / 记忆
      assistant({ input_tokens: 2, cache_read_input_tokens: 61800, output_tokens: 32 }),
      toolResult('x'.repeat(40_000)),
      assistant({
        input_tokens: 2,
        cache_read_input_tokens: 75000,
        cache_creation_input_tokens: 600,
        output_tokens: 82,
      }),
      // 子代理、API 错误都跳过
      assistant({ input_tokens: 9, cache_read_input_tokens: 999999 }, { isSidechain: true }),
      assistant({ input_tokens: 9 }, { isApiErrorMessage: true }),
    ].join('\n');
    const r = lastTranscriptContext(text)!;
    expect(r).toMatchObject({ contextTokens: 75684, model: 'claude-opus-5-5' });
    expect(r.compacted).toBeUndefined();
    expect(sum(r.breakdown)).toBeGreaterThanOrEqual(75684 - 3);
    expect(sum(r.breakdown)).toBeLessThanOrEqual(75684 + 3);
    // 压缩前的「旧问题」不计入；系统基线 ≈ 61834 − 32 − 摘要
    expect(r.breakdown!.system).toBeGreaterThan(61_700);
    expect(r.breakdown!.system).toBeLessThan(61_802);
    expect(r.breakdown!.tools).toBeGreaterThan(r.breakdown!.user);
  });

  it('a compaction boundary with no request after it reports the post-compaction size', () => {
    const text = [
      assistant({ input_tokens: 1, cache_read_input_tokens: 372000 }),
      boundary(15996),
      user('This session is being continued…'),
    ].join('\n');
    expect(lastTranscriptContext(text)).toMatchObject({ contextTokens: 15996, compacted: true });
  });

  it('ignores a truncated first line and returns null when nothing usable', () => {
    expect(lastTranscriptContext('{"type":"assi')).toBeNull();
    expect(lastTranscriptContext('')).toBeNull();
    expect(lastTranscriptContext(user('hi'))).toBeNull();
  });
});

describe('claudeTranscriptContext', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-claude-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const sid = '6c479c8d-75ee-4c89-b7c8-01cb3dd8dd82';
  const write = (dir: string, lines: string[]) => {
    fs.mkdirSync(path.join(home, 'projects', dir), { recursive: true });
    fs.writeFileSync(path.join(home, 'projects', dir, `${sid}.jsonl`), lines.join('\n') + '\n');
  };

  it('finds the transcript by cwd-derived dir name and reads only the tail', async () => {
    expect(claudeProjectDirName('/Users/a/ai/xy-token.api')).toBe('-Users-a-ai-xy-token-api');
    // 大量旧行在前面（超过尾部读取量），最后一次请求在末尾
    const filler = assistant({ input_tokens: 1 }, { pad: 'x'.repeat(2000) });
    write(claudeProjectDirName('/w/proj'), [
      ...Array.from({ length: 400 }, () => filler),
      assistant({ input_tokens: 10, cache_read_input_tokens: 248532 }),
    ]);
    expect(await claudeTranscriptContext(home, '/w/proj', sid)).toMatchObject({
      contextTokens: 248542,
      model: 'claude-opus-5-5',
    });
  });

  it('falls back to searching projects/ when the dir name rule does not match; rejects bad ids', async () => {
    write('some-other-dir', [assistant({ input_tokens: 5 })]);
    expect(await claudeTranscriptContext(home, '/w/proj', sid)).toMatchObject({ contextTokens: 5 });
    expect(await claudeTranscriptContext(home, '/w/proj', '../../etc/passwd')).toBeNull();
    expect(await claudeTranscriptContext(home, '/w/proj', 'ffffffff-0000')).toBeNull();
  });
});
