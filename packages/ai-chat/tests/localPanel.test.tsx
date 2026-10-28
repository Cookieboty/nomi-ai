// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalPanel } from '../src/components/LocalPanel';
import { collectConversations, fmtBytes, pct } from '../src/services/localClient';

import type { ApiMockState } from './helpers/knowledgeApi';

// local.* 走契约（services/api）：调用记进 mockIpc 返回的 invoke（过程名 + 具名入参）
const mock = vi.hoisted(() => ({ transport: true }) as ApiMockState);
vi.mock('../src/services/api', async () =>
  (await import('./helpers/knowledgeApi')).createApiMock(mock),
);

afterEach(() => {
  cleanup();
  mock.invoke = undefined;
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
    if (ch === 'local.state') return state;
    if (ch === 'local.download' || ch === 'local.downloadRuntime') return { ok: true };
    // 「本机模型」标签里同时列出 Ollama 的模型
    if (ch === 'local.ollamaList') return [];
    return true;
  });
  mock.invoke = (name, input) => (input === undefined ? invoke(name) : invoke(name, input));
  return invoke;
}

describe('LocalPanel', () => {
  it('shows RAM recommendation and downloads runtime + model after license consent', async () => {
    const invoke = mockIpc();
    const r = render(<LocalPanel isVisible onClose={() => undefined} />);
    fireEvent.click(r.getByRole('tab', { name: /本机模型/ }));
    await waitFor(() => expect(r.getByTestId('local-ram').textContent).toContain('8 GB'));
    const card = r.getByTestId('local-model-qwen3-1.7b-q8');
    expect(card.textContent).toContain('推荐');
    fireEvent.click(card.querySelector('[data-testid=local-download]')!);
    await waitFor(() =>
      expect(r.getByTestId('local-license-dialog').textContent).toContain('Apache-2.0'),
    );
    expect(r.getByTestId('local-license-dialog').textContent).toContain('llama.cpp');
    expect(invoke).not.toHaveBeenCalledWith('local.download', expect.anything());
    fireEvent.click(r.getByTestId('local-license-accept'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('local.download', { id: 'qwen3-1.7b-q8' }),
    );
    expect(invoke).toHaveBeenCalledWith('local.downloadRuntime');
  });

  it('starts an installed model; running server offers use/stop', async () => {
    const invoke = mockIpc();
    const r = render(<LocalPanel isVisible onClose={() => undefined} />);
    fireEvent.click(r.getByRole('tab', { name: /本机模型/ }));
    await waitFor(() => r.getByTestId('local-model-qwen3-0.6b-q8'));
    fireEvent.click(
      r.getByTestId('local-model-qwen3-0.6b-q8').querySelector('[data-testid=local-start]')!,
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('local.start', { id: 'qwen3-0.6b-q8' }),
    );
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
    fireEvent.click(r2.getByRole('tab', { name: /本机模型/ }));
    await waitFor(() => expect(r2.getByTestId('local-server-status').textContent).toBe('运行中'));
    expect(r2.getByTestId('local-use')).toBeTruthy();
    expect(r2.getByTestId('local-stop')).toBeTruthy();
  });
});

describe('localClient helpers', () => {
  it('formats', () => {
    expect(fmtBytes(1536)).toBe('2 KB');
    expect(fmtBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(pct({ received: 50, total: 200 })).toBe(25);
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

  it('tabs 属性限制可见标签：只给一个时不显示标签条', async () => {
    mockIpc();
    const one = render(<LocalPanel isVisible onClose={() => undefined} tabs={['export']} />);
    expect(one.queryAllByRole('tab')).toHaveLength(0);
    one.unmount();
    const both = render(<LocalPanel isVisible onClose={() => undefined} />);
    expect(both.getAllByRole('tab').map((x) => x.textContent)).toEqual(['数据导出', '本机模型']);
    expect(both.getByRole('heading', { name: '本机管理' })).toBeTruthy();
  });

  it('Alt+数字只在可见标签里切换：Alt+2 是本机模型，Alt+3 无效', async () => {
    mockIpc();
    const r = render(<LocalPanel isVisible onClose={() => undefined} />);
    const sel = () =>
      r
        .getAllByRole('tab')
        .filter((x) => x.getAttribute('aria-selected') === 'true')
        .map((x) => x.textContent);
    const alt = (n: number) => fireEvent.keyDown(window, { key: String(n), altKey: true });
    alt(2);
    await waitFor(() => expect(sel()).toEqual(['本机模型']));
    alt(1);
    await waitFor(() => expect(sel()).toEqual(['数据导出']));
    alt(3);
    expect(sel()).toEqual(['数据导出']);
  });
});
