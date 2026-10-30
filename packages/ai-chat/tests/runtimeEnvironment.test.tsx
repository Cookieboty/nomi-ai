// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RuntimeEnvironment } from '../src/components/ProvidersPage/RuntimeEnvironment';
import type { CliEnvironment } from '../src/services/cliUpdateClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const KINDS = { claude: 22, codex: 16, dsh: 24, grok: 18, gemini: 20 } as const;
const env = (
  nodeVersion: string | null,
  npmPath: string | null = '/usr/bin/npm',
): CliEnvironment => {
  const major = nodeVersion ? Number(nodeVersion.split('.')[0]) : NaN;
  return {
    nodeVersion,
    nodePath: nodeVersion ? '/usr/bin/node' : null,
    npmPath,
    requirements: Object.entries(KINDS).map(([kind, minNode]) => ({
      kind: kind as keyof typeof KINDS,
      minNode,
      ok: Number.isFinite(major) && major >= minNode,
    })),
  };
};

function setup(next: () => CliEnvironment) {
  const calls: string[] = [];
  const fake = installFakeApi(async (ch: string) => {
    calls.push(ch);
    return ch === 'cliUpdate.environment' ? next() : {};
  });
  return { calls, emit: (p: unknown) => fake.publish('cliUpdate.event', p) };
}

afterEach(() => {
  cleanup();
  resetFakeApi();
});

describe('RuntimeEnvironment', () => {
  it('a new enough Node: version, path and npm, no warning', async () => {
    setup(() => env('24.1.0'));
    const r = render(<RuntimeEnvironment />);
    await waitFor(() =>
      expect(r.getByTestId('cli-runtime-node-version').textContent).toBe('v24.1.0'),
    );
    expect(r.getByTestId('cli-runtime-node-state').getAttribute('data-state')).toBe('ok');
    expect(r.getByText('/usr/bin/node')).toBeTruthy();
    expect(r.queryByTestId('cli-runtime-notice')).toBeNull();
  });

  it('an old Node lists each assistant it is too old for', async () => {
    setup(() => env('20.3.0'));
    const r = render(<RuntimeEnvironment />);
    await waitFor(() => expect(r.getByTestId('cli-runtime-notice')).toBeTruthy());
    expect(r.getByTestId('cli-runtime-node-state').getAttribute('data-state')).toBe('old');
    // Node 20：只有 Claude Code（≥ 22）和 dsh（≥ 24）不满足，各占一行
    expect(r.getByTestId('cli-runtime-notice').querySelectorAll('div')).toHaveLength(2);
    expect(r.getByRole('link').getAttribute('href')).toBe('https://nodejs.org/');
  });

  it('no Node: says so and links to the download; detecting again re-queries', async () => {
    let current = env(null, null);
    const { calls } = setup(() => current);
    const r = render(<RuntimeEnvironment />);
    await waitFor(() =>
      expect(r.getByTestId('cli-runtime-node-state').getAttribute('data-state')).toBe('missing'),
    );
    expect(r.getByTestId('cli-runtime-notice')).toBeTruthy();
    current = env('24.1.0');
    fireEvent.click(r.getByTestId('cli-runtime-check'));
    await waitFor(() =>
      expect(r.getByTestId('cli-runtime-node-state').getAttribute('data-state')).toBe('ok'),
    );
    expect(calls.filter((c) => c === 'cliUpdate.environment')).toHaveLength(2);
  });

  it('re-checks after an install finishes', async () => {
    const { calls, emit } = setup(() => env('24.1.0'));
    render(<RuntimeEnvironment />);
    await waitFor(() => expect(calls).toContain('cliUpdate.environment'));
    emit({ kind: 'dsh', mode: 'install', phase: 'done', version: '0.2.0' });
    await waitFor(() => expect(calls.filter((c) => c === 'cliUpdate.environment')).toHaveLength(2));
  });
});
