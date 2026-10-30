jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import os from 'node:os';
import path from 'node:path';

import { CliHarnessService } from '../helpers/harness';

type Kind = 'codex' | 'dsh' | 'grok';
const KINDS: Kind[] = ['codex', 'dsh', 'grok'];
const BIN_ENV: Record<Kind, string> = {
  codex: 'NOMI_CODEX_BIN',
  dsh: 'NOMI_DSH_BIN',
  grok: 'NOMI_GROK_BIN',
};

describe('CliHarnessService: stop / abnormal exit after partial output (#25)', () => {
  const script = path.resolve(__dirname, '../../fixtures/partialCli.mjs');
  const harnesses: CliHarnessService[] = [];
  const saved: Record<string, string | undefined> = {};
  const envKeys = [
    ...Object.values(BIN_ENV),
    'NOMI_MOCK_PARTIAL_KIND',
    'NOMI_MOCK_PARTIAL_MODE',
    'NOMI_MOCK_PARTIAL_NO_TEXT',
  ];

  beforeEach(() => {
    for (const k of envKeys) saved[k] = process.env[k];
    delete process.env.NOMI_USE_MOCK_CLI;
    delete process.env.NOMI_MOCK_PARTIAL_NO_TEXT;
  });
  afterEach(() => {
    for (const h of harnesses) h.dispose();
    harnesses.length = 0;
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function setup(kind: Kind, mode: string) {
    process.env[BIN_ENV[kind]] = script;
    process.env.NOMI_MOCK_PARTIAL_KIND = kind;
    process.env.NOMI_MOCK_PARTIAL_MODE = mode;
    const h = new CliHarnessService({
      root: path.join(
        os.tmpdir(),
        `harness-partial-${kind}-${mode}-${Date.now()}-${Math.random()}`,
      ),
      logger: { info() {}, warn() {} },
      defaultCwd: process.cwd(),
    });
    harnesses.push(h);
    const tab = h.createTab({ backend: kind });
    return { h, tab };
  }

  const last = (h: CliHarnessService, id: string) => {
    const msgs = h.tabMessages(id);
    return msgs[msgs.length - 1]!;
  };

  async function waitForText(h: CliHarnessService, tabId: string) {
    let seen = false;
    h.events.on('event', (p: { tabId: string; event: { type: string; text?: string } }) => {
      if (p.tabId === tabId && (p.event.type === 'text' || p.event.type === 'text-delta'))
        seen = true;
    });
    return async () => {
      for (let i = 0; i < 100 && !seen; i++) await new Promise((r) => setTimeout(r, 50));
      expect(seen).toBe(true);
    };
  }

  for (const kind of KINDS) {
    describe(kind, () => {
      it('stop after partial text → stopped message, partial text kept, no success finish', async () => {
        const { h, tab } = setup(kind, 'hang');
        const finished: boolean[] = [];
        h.events.on('tab-finished', (p: { ok: boolean }) => finished.push(p.ok));
        const wait = await waitForText(h, tab.id);
        const run = h.sendTab(tab.id, 'go').catch((e: Error) => e);
        await wait();
        expect(h.cancelTab(tab.id)).toBe(true);
        await run;
        const a = last(h, tab.id);
        expect(a).toMatchObject({ role: 'assistant', stopped: true });
        expect(a.error).toBeUndefined();
        expect(a.content).toContain('部分输出');
        expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.status).toBe('idle');
        expect(finished).toEqual([]); // 停止不触发「完成」通知
      }, 20_000);

      it('exit 1 after partial text → error message keeping the partial text', async () => {
        const { h, tab } = setup(kind, 'exit1');
        const finished: boolean[] = [];
        h.events.on('tab-finished', (p: { ok: boolean }) => finished.push(p.ok));
        const r = await h.sendTab(tab.id, 'go').catch((e: Error) => e);
        expect(r).toBeInstanceOf(Error);
        expect(finished).toEqual([false]);
        const a = last(h, tab.id);
        expect(a).toMatchObject({ role: 'assistant', error: true });
        expect(a.stopped).toBeUndefined();
        expect(a.content).toContain('部分输出');
        expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.status).toBe('error');
      }, 20_000);

      it('exit 1 without any text → error (unchanged)', async () => {
        process.env.NOMI_MOCK_PARTIAL_NO_TEXT = '1';
        const { h, tab } = setup(kind, 'exit1');
        await h.sendTab(tab.id, 'go').catch(() => undefined);
        expect(last(h, tab.id)).toMatchObject({ role: 'assistant', error: true });
      }, 20_000);

      it('stop with no text → stopped (unchanged)', async () => {
        process.env.NOMI_MOCK_PARTIAL_NO_TEXT = '1';
        const { h, tab } = setup(kind, 'hang');
        const run = h.sendTab(tab.id, 'go').catch((e: Error) => e);
        for (
          let i = 0;
          i < 100 && h.listTabs().tabs.find((x) => x.id === tab.id)?.status !== 'running';
          i++
        )
          await new Promise((r) => setTimeout(r, 30));
        await new Promise((r) => setTimeout(r, 300));
        expect(h.cancelTab(tab.id)).toBe(true);
        await run;
        expect(last(h, tab.id)).toMatchObject({ role: 'assistant', stopped: true });
      }, 20_000);

      it('normal exit 0 → success', async () => {
        const { h, tab } = setup(kind, 'ok');
        const r = await h.sendTab(tab.id, 'go');
        expect(r.text).toContain('部分输出');
        const a = last(h, tab.id);
        expect(a.error).toBeUndefined();
        expect(a.stopped).toBeUndefined();
      }, 20_000);

      it('completion event seen, then exit 1 during teardown → still success', async () => {
        const { h, tab } = setup(kind, 'done-exit1');
        const r = await h.sendTab(tab.id, 'go');
        expect(r.text).toContain('部分输出');
        expect(last(h, tab.id).error).toBeUndefined();
      }, 20_000);
    });
  }
});
