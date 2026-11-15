// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NewTabPage } from '../src/components/SideWorkspace/NewTabPage';

vi.mock('../src/services/harnessClient', () => ({
  harnessClient: { workspaceList: vi.fn(async () => ({ ok: true, entries: [] })) },
}));

afterEach(() => cleanup());

describe('NewTabPage', () => {
  it('opens browser, files, changes, and side chat from the tiles and search field', () => {
    const onOpenChanges = vi.fn();
    const onOpenFiles = vi.fn();
    const onOpenSideChat = vi.fn();
    const onOpenBrowser = vi.fn();
    const onOpenFile = vi.fn();
    render(
      <NewTabPage
        tabKey="new-tab:1"
        cwd="/repo"
        roots={['/repo']}
        onOpenChanges={onOpenChanges}
        onOpenFiles={onOpenFiles}
        onOpenSideChat={onOpenSideChat}
        onOpenBrowser={onOpenBrowser}
        onOpenFile={onOpenFile}
      />,
    );
    expect(screen.getByTestId('new-tab-page')).toBeTruthy();
    fireEvent.click(screen.getByTestId('new-tab-open-browser'));
    fireEvent.click(screen.getByTestId('new-tab-open-files'));
    fireEvent.click(screen.getByTestId('new-tab-open-changes'));
    fireEvent.click(screen.getByTestId('new-tab-open-side-chat'));
    expect(onOpenBrowser).toHaveBeenCalledWith('');
    expect(onOpenFiles).toHaveBeenCalledTimes(1);
    expect(onOpenChanges).toHaveBeenCalledTimes(1);
    expect(onOpenSideChat).toHaveBeenCalledTimes(1);

    const search = screen.getByTestId('new-tab-search');
    fireEvent.change(search, { target: { value: 'https://example.com/docs' } });
    fireEvent.submit(search.closest('form')!);
    expect(onOpenBrowser).toHaveBeenLastCalledWith('https://example.com/docs');
  });

  it('disables files and changes when there is no workspace', () => {
    render(
      <NewTabPage
        tabKey="new-tab:2"
        onOpenChanges={() => {}}
        onOpenFiles={() => {}}
        onOpenSideChat={() => {}}
        onOpenBrowser={() => {}}
        onOpenFile={() => {}}
      />,
    );
    expect((screen.getByTestId('new-tab-open-files') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('new-tab-open-changes') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('new-tab-open-side-chat') as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByTestId('new-tab-open-browser') as HTMLButtonElement).disabled).toBe(false);
  });
});
