// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReleaseNotesHost, ReleaseNotesModal } from '../src/components/ReleaseNotesModal';
import { localizeReleaseNotes, splitBilingual } from '../src/releaseNotes';
import {
  acknowledgeReleaseNotesVersion,
  getAckedReleaseNotesVersion,
  getShowReleaseNotesAfterUpdate,
  openReleaseNotes,
  setShowReleaseNotesAfterUpdate,
} from '../src/services/releaseNotesPrefs';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const NOTES = [
  '# Nomi·诺米 2.0.8',
  '',
  '## 修复 / Fixes',
  '',
  '### Windows（Go 版） / Windows (Go build)',
  '',
  '- 上下文用量圆环使用警告 / 危险色 / The context ring uses the warning / danger colors',
  '- 安装版会注册 `nomi://` 链接 / Installed builds register the `nomi://` link handler',
].join('\n');

function mockUpdates(version: string, notes: string | null = NOTES) {
  installFakeApi({
    'updates.releaseNotes': ({ version: v }: { version?: string }) => ({
      version: v ?? version,
      notes,
      releaseDate: '2026-11-02T08:00:00Z',
    }),
    'updates.get': () => ({
      status: 'idle',
      currentVersion: version,
      autoCheck: true,
    }),
    'updates.check': () => ({}),
    'updates.download': () => ({}),
    'updates.install': () => ({}),
    'updates.setAutoCheck': () => ({}),
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetFakeApi();
});

describe('ReleaseNotesModal', () => {
  it('renders date, the release notes from the kernel, checkbox; uncheck persists off', () => {
    render(
      <ReleaseNotesModal
        open
        version="2.0.8"
        result={{ version: '2.0.8', notes: NOTES, releaseDate: '2026-11-02T08:00:00Z' }}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByTestId('release-notes-modal')).toBeTruthy();
    expect(screen.getByTestId('release-notes-date').textContent).toMatch(/2026/);
    const body = screen.getByTestId('release-notes-body').textContent ?? '';
    expect(body).toContain('nomi://');
    expect(body).not.toContain('Nomi·诺米 2.0.8');

    const cb = screen.getByTestId('release-notes-show-after') as HTMLInputElement;
    expect(cb.checked).toBe(true);
    fireEvent.click(cb);
    expect(getShowReleaseNotesAfterUpdate()).toBe(false);
  });

  it('close acknowledges version', () => {
    const onClose = vi.fn();
    render(
      <ReleaseNotesModal
        open
        version="2.0.5"
        result={{ version: '2.0.5', notes: null }}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId('release-notes-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('release-notes-date')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /关闭|Close/i }));
    expect(getAckedReleaseNotesVersion()).toBe('2.0.5');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ReleaseNotesHost', () => {
  it('first launch seeds ack without opening', async () => {
    mockUpdates('2.0.5');
    render(<ReleaseNotesHost />);
    await waitFor(() => expect(getAckedReleaseNotesVersion()).toBe('2.0.5'));
    expect(screen.queryByTestId('release-notes-modal')).toBeNull();
  });

  it('opens after version bump when preference on', async () => {
    mockUpdates('2.0.5');
    acknowledgeReleaseNotesVersion('2.0.4');
    setShowReleaseNotesAfterUpdate(true);
    render(<ReleaseNotesHost />);
    expect(await screen.findByTestId('release-notes-modal')).toBeTruthy();
    expect((await screen.findByTestId('release-notes-body')).textContent).toContain('nomi://');
  });

  it('shows a fallback when the kernel has no notes for this version', async () => {
    mockUpdates('2.0.7', null);
    acknowledgeReleaseNotesVersion('2.0.6');
    render(<ReleaseNotesHost />);
    expect(await screen.findByTestId('release-notes-unavailable')).toBeTruthy();
    expect(screen.getByTestId('release-notes-history-link')).toBeTruthy();
  });

  it('does not open after bump when preference off; still acks', async () => {
    mockUpdates('2.0.5');
    acknowledgeReleaseNotesVersion('2.0.4');
    setShowReleaseNotesAfterUpdate(false);
    render(<ReleaseNotesHost />);
    await waitFor(() => expect(getAckedReleaseNotesVersion()).toBe('2.0.5'));
    expect(screen.queryByTestId('release-notes-modal')).toBeNull();
  });

  it('openReleaseNotes from settings opens modal', async () => {
    mockUpdates('2.0.5');
    acknowledgeReleaseNotesVersion('2.0.5');
    render(<ReleaseNotesHost />);
    await waitFor(() => expect(screen.queryByTestId('release-notes-modal')).toBeNull());
    openReleaseNotes();
    expect(await screen.findByTestId('release-notes-modal')).toBeTruthy();
  });
});

describe('localizeReleaseNotes', () => {
  it('splits 「中文 / English」 at the first separator whose right side has no Chinese', () => {
    expect(
      splitBilingual('上下文用量圆环使用警告 / 危险色 / Uses warning / danger colors'),
    ).toEqual({
      zh: '上下文用量圆环使用警告 / 危险色',
      en: 'Uses warning / danger colors',
    });
    expect(splitBilingual('warning / danger')).toBeNull();
    expect(splitBilingual('只有中文')).toBeNull();
  });

  it('keeps the half for the UI language and drops the top-level title', () => {
    const zh = localizeReleaseNotes(NOTES, 'zh-CN');
    expect(zh).toContain('## 修复');
    expect(zh).toContain('### Windows（Go 版）');
    expect(zh).toContain('- 上下文用量圆环使用警告 / 危险色');
    expect(zh).not.toMatch(/Fixes|Installed builds|Nomi·诺米/);
    const en = localizeReleaseNotes(NOTES, 'en-US');
    expect(en).toContain('## Fixes');
    expect(en).toContain('- Installed builds register the `nomi://` link handler');
    expect(en).not.toMatch(/修复|安装版/);
  });
});
