// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AT_PATH_MENTION_DEBOUNCE_MS, useAtPathOptions } from '../src/slash/useAtPathOptions';

const workspaceList = vi.fn();
const workspaceMentionPaths = vi.fn();

vi.mock('../src/services/harnessClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/harnessClient')>();
  return {
    ...actual,
    harnessClient: {
      ...actual.harnessClient,
      available: () => true,
      workspaceList: (...args: unknown[]) => workspaceList(...(args as [string])),
      workspaceMentionPaths: (...args: unknown[]) =>
        workspaceMentionPaths(...(args as [string, string, number?])),
    },
  };
});

const delay = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

beforeEach(() => {
  workspaceList.mockReset();
  workspaceMentionPaths.mockReset();
  workspaceList.mockResolvedValue({
    ok: true,
    entries: [
      {
        kind: 'dir',
        name: 'src',
        path: 'src',
        children: [
          { kind: 'file', name: 'App.tsx', path: 'src/App.tsx' },
          { kind: 'file', name: 'indexer.ts', path: 'src/indexer.ts' },
        ],
      },
    ],
  });
  workspaceMentionPaths.mockImplementation(async (_cwd: string, query: string) => {
    if (!query) {
      return { ok: true, entries: [{ path: 'node_modules', kind: 'dir', name: 'node_modules' }] };
    }
    if (query.toLowerCase().includes('index')) {
      return {
        ok: true,
        entries: [{ path: 'node_modules/pkg/index.js', kind: 'file', name: 'index.js' }],
      };
    }
    return { ok: true, entries: [] };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAtPathOptions', () => {
  it('merges skip-dir tops so an empty query can list node_modules', async () => {
    const h = renderHook(() => useAtPathOptions(true, '/tmp/proj', [], ''));
    await waitFor(() =>
      expect(h.result.current.options.some((o) => o.path === 'node_modules')).toBe(true),
    );
    expect(h.result.current.options.some((o) => o.path === 'src/App.tsx')).toBe(true);
    expect(workspaceList).toHaveBeenCalledWith('/tmp/proj');
    expect(workspaceMentionPaths).toHaveBeenCalledWith('/tmp/proj', '', 50);
    expect(workspaceMentionPaths.mock.calls.some((c) => String(c[1]).trim() !== '')).toBe(false);
  });

  it('other folders insert absolute paths and show folder/rel', async () => {
    const h = renderHook(() => useAtPathOptions(true, '/w/app', ['/w/app', '/w/api'], ''));
    await waitFor(() =>
      expect(h.result.current.options.some((o) => o.path === '/w/api/node_modules')).toBe(true),
    );
    expect(workspaceList).toHaveBeenCalledWith('/w/app');
    expect(workspaceList).toHaveBeenCalledWith('/w/api');
    const apiTop = h.result.current.options.find((o) => o.path === '/w/api/node_modules');
    expect(apiTop).toEqual({
      path: '/w/api/node_modules',
      kind: 'dir',
      label: 'node_modules',
      display: 'api/node_modules',
    });
    const cwdTop = h.result.current.options.find((o) => o.path === 'node_modules');
    expect(cwdTop).toEqual({ path: 'node_modules', kind: 'dir', label: 'node_modules' });
  });

  it('debounces mention search when the query is non-empty and merges the hits', async () => {
    const h = renderHook(
      ({ query }: { query: string }) => useAtPathOptions(true, '/tmp/proj', [], query),
      { initialProps: { query: '' } },
    );
    await waitFor(() =>
      expect(h.result.current.options.some((o) => o.path === 'node_modules')).toBe(true),
    );
    expect(workspaceMentionPaths).toHaveBeenCalledWith('/tmp/proj', '', 50);

    h.rerender({ query: 'index' });
    expect(workspaceMentionPaths.mock.calls.some((c) => c[1] === 'index')).toBe(false);
    await delay(80);
    expect(workspaceMentionPaths.mock.calls.some((c) => c[1] === 'index')).toBe(false);

    await delay(AT_PATH_MENTION_DEBOUNCE_MS - 80 + 40);
    await waitFor(() =>
      expect(h.result.current.options.some((o) => o.path === 'node_modules/pkg/index.js')).toBe(
        true,
      ),
    );
    expect(workspaceMentionPaths).toHaveBeenCalledWith('/tmp/proj', 'index', 50);
  });

  it('errors from mention search yield no extra results', async () => {
    workspaceMentionPaths.mockImplementation(async (_cwd: string, query: string) => {
      if (!query)
        return { ok: true, entries: [{ path: 'node_modules', kind: 'dir', name: 'node_modules' }] };
      throw new Error('boom');
    });
    const h = renderHook(() => useAtPathOptions(true, '/tmp/proj', [], 'index'));
    await waitFor(() =>
      expect(h.result.current.options.some((o) => o.path === 'src/indexer.ts')).toBe(true),
    );
    await delay(AT_PATH_MENTION_DEBOUNCE_MS + 40);
    expect(h.result.current.options.some((o) => o.path === 'src/indexer.ts')).toBe(true);
    expect(h.result.current.options.some((o) => o.path.includes('pkg'))).toBe(false);
  });

  it('ok:false mention responses also add no extra results', async () => {
    workspaceMentionPaths.mockImplementation(async (_cwd: string, query: string) => {
      if (!query) return { ok: false, error: 'invalid cwd', code: 'invalid' };
      return { ok: false, error: 'nope' };
    });
    const h = renderHook(() => useAtPathOptions(true, '/tmp/proj', [], 'index'));
    await waitFor(() =>
      expect(h.result.current.options.some((o) => o.path === 'src/indexer.ts')).toBe(true),
    );
    expect(h.result.current.options.some((o) => o.path === 'node_modules')).toBe(false);
    await delay(AT_PATH_MENTION_DEBOUNCE_MS + 40);
    expect(h.result.current.options.some((o) => o.path === 'src/indexer.ts')).toBe(true);
    expect(h.result.current.options.some((o) => o.path.includes('pkg'))).toBe(false);
  });
});
