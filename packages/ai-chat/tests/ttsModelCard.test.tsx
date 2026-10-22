// @vitest-environment happy-dom
import { applyLocale } from '@nomi-ai/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TtsModelCard } from '../src/components/SettingsView/TtsModelCard';
import { formatMB } from '../src/services/ttsModelClient';

type State = Record<string, unknown>;
let calls: Array<[string, ...unknown[]]> = [];
let state: State;
let listener: ((s: State) => void) | null = null;
let enableResult: unknown = null;
let downloadResult: unknown = null;

const base = (o: State = {}): State => ({
  state: 'missing',
  modelId: 'vits-zh-hf-theresa',
  total: 120596617,
  installedBytes: 138661153,
  partialBytes: 0,
  voiceEnabled: false,
  ...o,
});

beforeEach(() => {
  calls = [];
  listener = null;
  state = base();
  enableResult = null;
  downloadResult = null;
  (window as unknown as { aiIPC: unknown }).aiIPC = {
    invoke: async (ch: string, ...a: unknown[]) => {
      calls.push([ch, ...a]);
      if (ch === 'ai:tts-model:status') return state;
      if (ch === 'ai:tts-model:set-voice-enabled') return enableResult;
      if (ch === 'ai:tts-model:download') return downloadResult;
      if (ch === 'ai:tts-model:cancel') return base();
      if (ch === 'ai:tts-model:delete') return base();
      return null;
    },
    on: (ch: string, fn: (s: State) => void) => {
      if (ch === 'ai:tts-model:changed') listener = fn;
      return () => undefined;
    },
  };
});
afterEach(() => {
  cleanup();
  applyLocale('zh-CN');
  delete (window as unknown as { aiIPC?: unknown }).aiIPC;
});

const push = (s: State) => act(() => listener?.(s));

describe('TtsModelCard', () => {
  it('is hidden without IPC', () => {
    delete (window as unknown as { aiIPC?: unknown }).aiIPC;
    const { container } = render(<TtsModelCard />);
    expect(container.innerHTML).toBe('');
  });

  it('missing model: voice off, explains the ~115 MB download', async () => {
    render(<TtsModelCard />);
    const toggle = await screen.findByTestId('tts-voice-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('tts-model-missing').textContent).toMatch(/115\.0 MB/);
  });

  it('turning voice on calls set-voice-enabled and shows progress + cancel from pushes', async () => {
    enableResult = new Promise(() => undefined); // 下载中，不返回
    render(<TtsModelCard />);
    fireEvent.click(await screen.findByTestId('tts-voice-toggle'));
    expect(calls).toContainEqual(['ai:tts-model:set-voice-enabled', true]);
    push(base({ state: 'downloading', phase: 'download', received: 60298309, voiceEnabled: true }));
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    fireEvent.click(screen.getByTestId('tts-model-cancel'));
    await waitFor(() => expect(calls.some((c) => c[0] === 'ai:tts-model:cancel')).toBe(true));
  });

  it('failure: clear error, voice stays off, retry re-enables', async () => {
    enableResult = { ok: false, voiceEnabled: false, error: 'HTTP 503', status: base() };
    render(<TtsModelCard />);
    fireEvent.click(await screen.findByTestId('tts-voice-toggle'));
    const err = await screen.findByTestId('tts-model-error');
    expect(err.textContent).toMatch(/HTTP 503/);
    expect(screen.getByTestId('tts-voice-toggle').getAttribute('aria-checked')).toBe('false');
    calls = [];
    fireEvent.click(screen.getByTestId('tts-model-retry'));
    await waitFor(() => expect(calls).toContainEqual(['ai:tts-model:set-voice-enabled', true]));
  });

  it('cancel result is not shown as an error', async () => {
    enableResult = { ok: false, voiceEnabled: false, error: 'cancelled', status: base() };
    render(<TtsModelCard />);
    fireEvent.click(await screen.findByTestId('tts-voice-toggle'));
    await waitFor(() => expect(calls.length).toBeGreaterThan(1));
    expect(screen.queryByTestId('tts-model-error')).toBeNull();
  });

  it('partial download left from a previous run is shown as resumable', async () => {
    state = base({ partialBytes: 52428800 });
    render(<TtsModelCard />);
    expect((await screen.findByTestId('tts-model-partial')).textContent).toMatch(/50\.0 MB/);
  });

  it('ready in userData: offline note + delete model (with confirm)', async () => {
    state = base({ state: 'ready', source: 'userData', voiceEnabled: true });
    const confirm = vi.fn(() => true);
    (window as unknown as { confirm: unknown }).confirm = confirm;
    render(<TtsModelCard />);
    expect((await screen.findByTestId('tts-model-ready')).textContent).toMatch(/132\.2 MB/);
    fireEvent.click(screen.getByTestId('tts-model-delete'));
    await waitFor(() => expect(calls.some((c) => c[0] === 'ai:tts-model:delete')).toBe(true));
    expect(confirm).toHaveBeenCalled();
  });

  it('voice on but model missing (e.g. switched to sherpa): shows a download button that only downloads', async () => {
    state = base({ voiceEnabled: true });
    downloadResult = new Promise(() => undefined);
    render(<TtsModelCard />);
    expect((await screen.findByTestId('tts-model-missing')).textContent).toMatch(/语音已开启/);
    fireEvent.click(screen.getByTestId('tts-model-download'));
    expect(calls).toContainEqual(['ai:tts-model:download']);
    expect(calls.some((c) => c[0] === 'ai:tts-model:set-voice-enabled')).toBe(false);
  });

  it('shows disk need (archive + unpacked) and free space before downloading', async () => {
    state = base({
      diskRequired: 300 * 1048576,
      archiveBytes: 120596617,
      diskFree: 5000 * 1048576,
    });
    render(<TtsModelCard />);
    const el = await screen.findByTestId('tts-model-disk');
    expect(el.textContent).toMatch(/300\.0 MB/);
    expect(el.textContent).toMatch(/115\.0 MB/);
    expect(el.textContent).toMatch(/当前可用/);
    expect(el.getAttribute('role')).toBeNull();
  });

  it('not enough disk: clear alert', async () => {
    state = base({ voiceEnabled: true, diskRequired: 300 * 1048576, diskFree: 50 * 1048576 });
    render(<TtsModelCard />);
    const el = await screen.findByTestId('tts-model-disk');
    expect(el.getAttribute('role')).toBe('alert');
    expect(el.textContent).toMatch(/当前只有 50\.0 MB 可用/);
  });

  it('download failure while voice stays on does NOT claim voice was turned off; retry only downloads', async () => {
    state = base({ state: 'error', message: 'HTTP 503', voiceEnabled: true });
    render(<TtsModelCard />);
    const err = await screen.findByTestId('tts-model-error');
    expect(err.textContent).toMatch(/下载失败：HTTP 503/);
    expect(err.textContent).not.toMatch(/语音已关闭/);
    fireEvent.click(screen.getByTestId('tts-model-retry'));
    await waitFor(() => expect(calls).toContainEqual(['ai:tts-model:download']));
  });

  it('English locale', async () => {
    applyLocale('en');
    render(<TtsModelCard />);
    expect((await screen.findByTestId('tts-model-missing')).textContent).toMatch(
      /Turning on voice downloads the offline voice model/,
    );
  });

  it('formatMB', () => {
    expect(formatMB(120596617)).toBe('115.0 MB');
  });
});
