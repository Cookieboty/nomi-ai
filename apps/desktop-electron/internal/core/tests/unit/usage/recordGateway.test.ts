jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRecordingAppEvents } from '../../../src/core/appEvents';
import { UsageService } from '../../../src/usage/UsageService';

const services: UsageService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
});

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-gw-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-gw-home-'));
  const svc = new UsageService({
    events: createRecordingAppEvents(),
    root,
    home,
    dshHome: path.join(home, '.dsh'),
    now: () => 1_793_507_700_000,
    scanMs: 0,
    logger: { info: jest.fn(), warn: jest.fn() },
  });
  services.push(svc);
  return svc;
}

const ev = (o: Record<string, unknown>) => ({
  client: 'nomi',
  wire: 'responses',
  provider: 'amux',
  model: 'amux/openai/gpt-6-astra',
  upstreamModel: 'openai/gpt-6-astra',
  status: 200,
  startedAt: 1_793_507_645_592,
  ms: 8725,
  ...o,
});

describe('Nomi 按网关逐次记账', () => {
  it('一轮里的两次模型调用各记一条，和网关一致（之前 AI SDK 的汇总少算了第一步的输入）', () => {
    const svc = mk();
    const a = svc.recordGateway(ev({ usage: { inputTokens: 30_369, outputTokens: 208 } }));
    const b = svc.recordGateway(
      ev({
        startedAt: 1_793_507_677_049,
        usage: { inputTokens: 30_735, outputTokens: 33, cacheReadTokens: 30_366 },
      }),
    );
    expect(a).toMatchObject({
      source: 'nomi',
      provider: 'amux',
      model: 'openai/gpt-6-astra',
      input: 30_369,
      cacheRead: 0,
      output: 208,
    });
    expect(b).toMatchObject({ input: 369, cacheRead: 30_366, output: 33 });
    expect(a!.key).not.toBe(b!.key);
  });

  it('Messages 上游的输入本来就不含缓存：不再扣', () => {
    const r = mk().recordGateway(
      ev({
        wire: 'messages',
        usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 1000, cacheWriteTokens: 50 },
      }),
    );
    expect(r).toMatchObject({ input: 12, cacheRead: 1000, cacheWrite: 50, output: 5 });
  });

  it('失败的请求、别的客户端（编程助手经网关）不记', () => {
    const svc = mk();
    expect(svc.recordGateway(ev({ status: 502, usage: { inputTokens: 10 } }))).toBeNull();
    expect(svc.recordGateway(ev({ client: 'codex', usage: { inputTokens: 10 } }))).toBeNull();
    expect(svc.recordGateway(ev({ usage: {} }))).toBeNull();
  });

  it('没有上游模型名时去掉供应商前缀', () => {
    const r = mk().recordGateway(
      ev({ upstreamModel: undefined, usage: { inputTokens: 10, outputTokens: 1 } }),
    );
    expect(r!.model).toBe('openai/gpt-6-astra');
  });
});
