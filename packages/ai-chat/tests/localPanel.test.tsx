// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalPanel } from '../src/components/LocalPanel';
import { collectConversations, fmtBytes, fmtWhen, pct } from '../src/services/localClient';

afterEach(() => {
  cleanup();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

const model = (id: string, extra: object = {}) => ({
  id,
  name: id,
  family: 'Qwen3',
  params: '0.6B',
  quant: 'Q8_0',
  description: 'd',
  bytes: 600e6,
  license: 'Apache-2.0',
  licenseUrl: 'https://l',
  sourceUrl: 'https://s',
  minRamGb: 2,
  ctx: 4096,
  installed: false,
  fit: 'ok',
  ...extra,
});

function mockIpc(over: Record<string, unknown> = {}) {
  const state = {
    ramGb: 8,
    recommended: 'qwen3-1.7b-q8',
    models: [model('qwen3-0.6b-q8', { installed: true }), model('qwen3-1.7b-q8')],
    runtime: {
      tag: 'b1',
      license: 'MIT',
      licenseUrl: '',
      sourceUrl: '',
      supported: true,
      bytes: 17e6,
      installed: false,
    },
    server: { status: 'stopped', log: [] },
    settings: { autoStart: false, ollamaUrl: 'http://127.0.0.1:11434' },
    offline: false,
    ...over,
  };
  const invoke = vi.fn(async (ch: string, ..._a: unknown[]) => {
    if (ch === 'ai:local:state') return state;
    if (ch === 'ai:local:download' || ch === 'ai:local:download-runtime') return { ok: true };
    if (ch === 'ai:hub:cal-state')
      return {
        sources: [{ id: 'local', name: '我的日历', kind: 'local', color: '#f00', enabled: true }],
      };
    if (ch === 'ai:hub:cal-range') return [];
    if (ch === 'ai:hub:clip-state')
      return { settings: { enabled: false, max: 200, images: true }, items: [] };
    return true;
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
  return invoke;
}

describe('LocalPanel', () => {
  it('shows RAM recommendation and downloads runtime + model after license consent', async () => {
    const invoke = mockIpc();
    const r = render(<LocalPanel isVisible onClose={() => undefined} />);
    fireEvent.click(r.getByRole('tab', { name: /本机小模型/ }));
    await waitFor(() => expect(r.getByTestId('local-ram').textContent).toContain('8 GB'));
    const card = r.getByTestId('local-model-qwen3-1.7b-q8');
    expect(card.textContent).toContain('推荐');
    fireEvent.click(card.querySelector('[data-testid=local-download]')!);
    await waitFor(() =>
      expect(r.getByTestId('local-license-dialog').textContent).toContain('Apache-2.0'),
    );
    expect(r.getByTestId('local-license-dialog').textContent).toContain('llama.cpp');
    expect(invoke).not.toHaveBeenCalledWith('ai:local:download', expect.anything());
    fireEvent.click(r.getByTestId('local-license-accept'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:local:download', 'qwen3-1.7b-q8'));
    expect(invoke).toHaveBeenCalledWith('ai:local:download-runtime');
  });

  it('starts an installed model; running server offers use/stop', async () => {
    const invoke = mockIpc();
    const r = render(<LocalPanel isVisible onClose={() => undefined} />);
    fireEvent.click(r.getByRole('tab', { name: /本机小模型/ }));
    await waitFor(() => r.getByTestId('local-model-qwen3-0.6b-q8'));
    fireEvent.click(
      r.getByTestId('local-model-qwen3-0.6b-q8').querySelector('[data-testid=local-start]')!,
    );
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:local:start', 'qwen3-0.6b-q8'));
    cleanup();
    mockIpc({
      server: {
        status: 'running',
        model: 'qwen3-0.6b-q8',
        port: 5,
        baseURL: 'http://127.0.0.1:5/v1',
        log: [],
      },
    });
    const r2 = render(<LocalPanel isVisible onClose={() => undefined} />);
    fireEvent.click(r2.getByRole('tab', { name: /本机小模型/ }));
    await waitFor(() => expect(r2.getByTestId('local-server-status').textContent).toBe('运行中'));
    expect(r2.getByTestId('local-use')).toBeTruthy();
    expect(r2.getByTestId('local-stop')).toBeTruthy();
  });

  it('calendar and clipboard empty states', async () => {
    mockIpc();
    const r = render(<LocalPanel isVisible onClose={() => undefined} />);
    await waitFor(() => expect(r.getByText('接下来两周没有日程')).toBeTruthy());
    fireEvent.click(r.getByRole('tab', { name: '剪贴板' }));
    await waitFor(() => expect(r.getByText('剪贴板历史未开启')).toBeTruthy());
  });
});

describe('localClient helpers', () => {
  it('formats', () => {
    expect(fmtBytes(1536)).toBe('2 KB');
    expect(fmtBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(pct({ received: 50, total: 200 })).toBe(25);
    const now = new Date(2026, 9, 12, 8);
    expect(
      fmtWhen(
        {
          start: new Date(2026, 9, 12, 9).getTime(),
          end: new Date(2026, 9, 12, 10, 30).getTime(),
          allDay: false,
        },
        now,
      ),
    ).toBe('今天 09:00–10:30');
    expect(fmtWhen({ start: new Date(2026, 9, 13).getTime(), end: 0, allDay: true }, now)).toBe(
      '10月13日 全天',
    );
  });
  it('collects only ai-chat keys', () => {
    const m = new Map([
      ['ai-chat:conversations', '[1]'],
      ['other', 'x'],
    ]);
    const s = {
      length: m.size,
      key: (i: number) => [...m.keys()][i] ?? null,
      getItem: (k: string) => m.get(k) ?? null,
    };
    expect(collectConversations(s)).toEqual({ 'ai-chat:conversations': [1] });
  });

  it('tabs 属性限制可见标签：只给日历时不显示标签条；不含日历时没有日历标签', async () => {
    mockIpc();
    const cal = render(<LocalPanel isVisible onClose={() => undefined} tabs={['calendar']} />);
    expect(cal.queryAllByRole('tab')).toHaveLength(0);
    expect(cal.getByRole('heading', { name: '日历' })).toBeTruthy();
    cal.unmount();
    const rest = render(
      <LocalPanel
        isVisible
        onClose={() => undefined}
        tabs={['clipboard', 'export', 'models', 'ollama']}
      />,
    );
    expect(rest.getAllByRole('tab').map((x) => x.textContent)).toEqual([
      '剪贴板',
      '数据导出',
      '本机小模型（辅助）',
      'Ollama（可选）',
    ]);
    expect(rest.getByTestId('local-panel')).toBeTruthy();
    expect(rest.getByRole('heading', { name: '本机管理' })).toBeTruthy();
  });

  describe('Alt+数字只在可见标签里切换', () => {
    const sel = (r: ReturnType<typeof render>) =>
      r
        .getAllByRole('tab')
        .filter((x) => x.getAttribute('aria-selected') === 'true')
        .map((x) => x.textContent);
    const alt = (n: number) => fireEvent.keyDown(window, { key: String(n), altKey: true });

    it('本机管理（无日历）：Alt+1 是剪贴板，Alt+3 是小模型，Alt+5 无效', async () => {
      mockIpc();
      const r = render(
        <LocalPanel
          isVisible
          onClose={() => undefined}
          tabs={['clipboard', 'export', 'models', 'ollama']}
        />,
      );
      alt(1);
      await waitFor(() => expect(sel(r)).toEqual(['剪贴板']));
      alt(3);
      await waitFor(() => expect(sel(r)).toEqual(['本机小模型（辅助）']));
      alt(2);
      await waitFor(() => expect(sel(r)).toEqual(['数据导出']));
      alt(5);
      expect(sel(r)).toEqual(['数据导出']);
    });

    it('只有日历一个可见标签：Alt+2 / Alt+3 / Alt+1 都没有副作用', async () => {
      mockIpc();
      const r = render(<LocalPanel isVisible onClose={() => undefined} tabs={['calendar']} />);
      for (const n of [1, 2, 3]) alt(n);
      expect(r.getByRole('heading', { name: '日历' })).toBeTruthy();
      expect(r.queryByRole('heading', { name: '剪贴板历史' })).toBeNull();
      expect(r.queryAllByRole('tab')).toHaveLength(0);
    });

    it('不限制标签时仍按完整 5 个：Alt+2 是剪贴板', async () => {
      mockIpc();
      const r = render(<LocalPanel isVisible onClose={() => undefined} />);
      alt(2);
      await waitFor(() => expect(sel(r)).toEqual(['剪贴板']));
    });
  });
});
