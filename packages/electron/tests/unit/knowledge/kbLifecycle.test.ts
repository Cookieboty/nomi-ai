jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { KnowledgeService } from '../../../src/knowledge/KnowledgeService';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

function make() {
  const unsub = jest.fn();
  const onChange = jest.fn(() => unsub);
  const svc = new KnowledgeService({
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'kb-life-')),
    logger: { info() {}, warn() {}, error() {} } as never,
    desktop: { broker: { onChange } } as never,
    listProviders: () => [],
    credentials: () => null,
    chatProvider: () => null,
    complete: async () => '',
  } as never);
  const reindex = jest
    .spyOn(svc as never, 'reindex' as never)
    .mockResolvedValue(undefined as never);
  return { svc, onChange, unsub, reindex };
}

describe('KnowledgeService 生命周期', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('start() 幂等：重复调用只订阅一次、只有一组定时器', () => {
    const { svc, onChange, reindex } = make();
    svc.start();
    svc.start();
    expect(onChange).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(20_000);
    expect(reindex).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(30 * 60_000);
    expect(reindex).toHaveBeenCalledTimes(2); // 一个 30 分钟 interval，而不是两个
  });

  it('dispose()：清定时器（含首次延迟索引）、退订 broker、中止索引与下载、终止 OCR', async () => {
    const { svc, unsub, reindex } = make();
    svc.start();
    const jobAbort = jest.fn();
    const dlAbort = jest.fn();
    const terminate = jest.fn().mockResolvedValue(undefined);
    const priv = svc as unknown as {
      job: unknown;
      downloads: Map<string, unknown>;
      ocrWorker: unknown;
    };
    priv.job = { ctrl: { abort: jobAbort }, p: {} };
    priv.downloads.set('d', { ctrl: { abort: dlAbort }, received: 0, total: 1 });
    priv.ocrWorker = {
      worker: { terminate },
      langs: 'eng',
      idle: setTimeout(() => undefined, 1e6),
    };

    await svc.dispose();

    expect(unsub).toHaveBeenCalledTimes(1);
    expect(jobAbort).toHaveBeenCalled();
    expect(dlAbort).toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(priv.ocrWorker).toBeNull();
    jest.advanceTimersByTime(2 * 30 * 60_000);
    expect(reindex).not.toHaveBeenCalled();
    // 幂等，并允许再次 start
    await svc.dispose();
    svc.start();
    jest.advanceTimersByTime(20_000);
    expect(reindex).toHaveBeenCalledTimes(1);
    await svc.dispose();
  });
});
