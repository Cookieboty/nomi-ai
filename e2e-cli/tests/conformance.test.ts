/**
 * 真实 CLI 一致性测试：上游流的各种毛病经网关之后，CLI 都能正常完成（或明确报错）。
 * 场景来自设计稿附录 B（docs/design/cli-plugin-architecture.md）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  runClaude,
  runCodex,
  runDsh,
  runGemini,
  runGrok,
  hasCli,
  type CliRun,
} from '../helpers/cli';
import { startGateway, type TestGateway } from '../helpers/gateway';
import {
  messagesStream,
  responsesStream,
  startUpstream,
  type FakeUpstream,
  type ResponsesDefects,
} from '../helpers/upstream';

const ANSWER = 'CONFORMANCE-OK';
const MODEL = 'up/gpt-x';

const DEFECTS: Array<[string, ResponsesDefects]> = [
  ['正常流', {}],
  ['保活伪装成正文增量', { keepAlive: true }],
  ['response 缺 model / output', { bareResponse: true }],
  ['reasoning 缺 summary', { reasoningNoSummary: true }],
  ['自定义事件 response.metadata', { metadataEvent: true }],
  ['只给完整条目', { wholeItemsOnly: true }],
  ['增量事件缺 item_id / output_index', { bareDeltas: true }],
  ['事件不带 sequence_number', { noSequence: true }],
  [
    '全部毛病叠加',
    {
      keepAlive: true,
      bareResponse: true,
      reasoningNoSummary: true,
      metadataEvent: true,
      bareDeltas: true,
      noSequence: true,
    },
  ],
];

const succeeded = (r: CliRun) => r.code === 0 && r.stdout.includes(ANSWER);

/** 上游中途断开：CLI 不能把它当成成功的完整回复；超时强杀不算「正常报错」（#125） */
const reportedFailure = (r: CliRun) =>
  !r.timedOut && (r.code !== 0 || /结束标记|ended|error|failed|中断/i.test(r.stdout + r.stderr));

describe.each([
  ['grok', runGrok],
  ['codex', runCodex],
  ['dsh', runDsh],
] as const)('%s（Responses 入口，同协议透传）', (name, run) => {
  let up: FakeUpstream;
  let gw: TestGateway;

  beforeAll(async () => {
    up = await startUpstream(() => ({ sse: responsesStream(ANSWER) }));
    gw = await startGateway(up, { wires: ['responses'] });
  });
  afterAll(async () => {
    await gw?.stop();
    await up?.close();
  });

  for (const [label, defects] of DEFECTS) {
    it.skipIf(!hasCli(name))(`${label} → 正常完成`, async () => {
      up.setScenario(() => ({ sse: responsesStream(ANSWER, defects) }));
      const r = await run(gw.url, MODEL, 'say ok');
      expect(succeeded(r), `${r.stdout}\n${r.stderr}`).toBe(true);
    });
  }

  it.skipIf(!hasCli(name))(
    '上游没发 response.completed 就断开 → 报错，而不是空回复或卡住',
    async () => {
      up.setScenario(() => ({ sse: responsesStream(ANSWER, { cutBeforeCompleted: true }) }));
      const r = await run(gw.url, MODEL, 'say ok');
      expect(reportedFailure(r), `${r.stdout}\n${r.stderr}`).toBe(true);
    },
  );

  it.skipIf(!hasCli(name))('一轮里的所有请求（含标题等辅助请求）都用标签的模型', async () => {
    up.setScenario(() => ({ sse: responsesStream(ANSWER) }));
    up.seen.length = 0;
    const r = await run(gw.url, MODEL, 'say ok');
    expect(succeeded(r)).toBe(true);
    const posts = up.seen.filter((s) => s.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    expect(new Set(posts.map((s) => s.model))).toEqual(new Set(['gpt-x']));
  });
});

describe('claude（Messages 入口）', () => {
  let up: FakeUpstream;
  let gw: TestGateway;
  let gwCross: TestGateway;

  beforeAll(async () => {
    up = await startUpstream((r) =>
      r.url.includes('/messages')
        ? { sse: messagesStream(ANSWER) }
        : { sse: responsesStream(ANSWER) },
    );
    gw = await startGateway(up, { wires: ['messages'] });
    // 上游只有 Responses：跨协议转换
    gwCross = await startGateway(up, { wires: ['responses'], modelMeta: { reasoning: true } });
  });
  afterAll(async () => {
    await gw?.stop();
    await gwCross?.stop();
    await up?.close();
  });

  it.skipIf(!hasCli('claude'))('同协议透传：正常完成', async () => {
    up.setScenario(() => ({ sse: messagesStream(ANSWER) }));
    expect(succeeded(await runClaude(gw.url, MODEL, 'say ok'))).toBe(true);
  });

  it.skipIf(!hasCli('claude'))('同协议透传：上游没发 message_stop 就断开 → 报错', async () => {
    up.setScenario(() => ({ sse: messagesStream(ANSWER, { cut: true }) }));
    expect(reportedFailure(await runClaude(gw.url, MODEL, 'say ok'))).toBe(true);
  });

  for (const [label, defects] of DEFECTS.filter(([l]) =>
    ['正常流', '保活伪装成正文增量', '全部毛病叠加', '只给完整条目'].includes(l),
  )) {
    it.skipIf(!hasCli('claude'))(`跨协议（上游 Responses）：${label} → 正常完成`, async () => {
      up.setScenario(() => ({ sse: responsesStream(ANSWER, defects) }));
      const r = await runClaude(gwCross.url, MODEL, 'say ok');
      expect(succeeded(r), `${r.stdout}\n${r.stderr}`).toBe(true);
    });
  }

  it.skipIf(!hasCli('claude'))('跨协议：上游中途断开 → 报错', async () => {
    up.setScenario(() => ({
      sse: responsesStream(ANSWER, { keepAlive: true, cutBeforeCompleted: true }),
    }));
    expect(reportedFailure(await runClaude(gwCross.url, MODEL, 'say ok'))).toBe(true);
  });

  it.skipIf(!hasCli('claude'))(
    '跨协议：Claude Code 的思考设置作为推理参数发给上游（MA1）',
    async () => {
      up.setScenario(() => ({ sse: responsesStream(ANSWER) }));
      up.seen.length = 0;
      const r = await runClaude(gwCross.url, MODEL, 'say ok', { MAX_THINKING_TOKENS: '16000' });
      expect(succeeded(r)).toBe(true);
      const main = up.seen.filter((s) => s.method === 'POST').find((s) => s.body.reasoning);
      expect(
        main?.body.reasoning,
        JSON.stringify(up.seen.map((s) => s.body.reasoning)),
      ).toMatchObject({
        effort: expect.any(String),
      });
    },
  );
});

describe('gemini（Gemini 入口，上游 Responses：跨协议转换）', () => {
  let up: FakeUpstream;
  let gw: TestGateway;

  beforeAll(async () => {
    up = await startUpstream(() => ({ sse: responsesStream(ANSWER) }));
    gw = await startGateway(up, { wires: ['responses'] });
  });
  afterAll(async () => {
    await gw?.stop();
    await up?.close();
  });

  for (const [label, defects] of DEFECTS.filter(([l]) =>
    ['正常流', '保活伪装成正文增量', '只给完整条目', '全部毛病叠加'].includes(l),
  )) {
    it.skipIf(!hasCli('gemini'))(`${label} → 正常完成`, async () => {
      up.setScenario(() => ({ sse: responsesStream(ANSWER, defects) }));
      const r = await runGemini(gw.url, MODEL, 'say ok');
      expect(succeeded(r), `${r.stdout}\n${r.stderr}`).toBe(true);
    });
  }

  it.skipIf(!hasCli('gemini'))('上游中途断开 → 报错', async () => {
    up.setScenario(() => ({ sse: responsesStream(ANSWER, { cutBeforeCompleted: true }) }));
    const r = await runGemini(gw.url, MODEL, 'say ok');
    expect(reportedFailure(r), `${r.stdout}\n${r.stderr}`).toBe(true);
  });

  it.skipIf(!hasCli('gemini'))('一轮里的所有请求都用标签的模型', async () => {
    up.setScenario(() => ({ sse: responsesStream(ANSWER) }));
    up.seen.length = 0;
    expect(succeeded(await runGemini(gw.url, MODEL, 'say ok'))).toBe(true);
    const posts = up.seen.filter((s) => s.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    expect(new Set(posts.map((s) => s.model))).toEqual(new Set(['gpt-x']));
  });
});
