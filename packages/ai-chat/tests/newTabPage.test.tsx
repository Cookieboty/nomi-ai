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
  it('opens browser, files, changes, side chat, and terminal from the tiles and search field', () => {
    const onOpenChanges = vi.fn();
    const onOpenFiles = vi.fn();
    const onOpenSideChat = vi.fn();
    const onOpenBrowser = vi.fn();
    const onOpenTerminal = vi.fn();
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
        onOpenTerminal={onOpenTerminal}
        onOpenFile={onOpenFile}
      />,
    );
    expect(screen.getByTestId('new-tab-page')).toBeTruthy();
    fireEvent.click(screen.getByTestId('new-tab-open-browser'));
    fireEvent.click(screen.getByTestId('new-tab-open-files'));
    fireEvent.click(screen.getByTestId('new-tab-open-changes'));
    fireEvent.click(screen.getByTestId('new-tab-open-side-chat'));
    fireEvent.click(screen.getByTestId('new-tab-open-terminal'));
    expect(onOpenBrowser).toHaveBeenCalledWith('');
    expect(onOpenFiles).toHaveBeenCalledTimes(1);
    expect(onOpenChanges).toHaveBeenCalledTimes(1);
    expect(onOpenSideChat).toHaveBeenCalledTimes(1);
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);

    const search = screen.getByTestId('new-tab-search');
    fireEvent.change(search, { target: { value: 'https://example.com/docs' } });
    fireEvent.submit(search.closest('form')!);
    expect(onOpenBrowser).toHaveBeenLastCalledWith('https://example.com/docs');
  });

  it('shows feedback when Enter is pressed with no matching file', () => {
    render(
      <NewTabPage
        tabKey="new-tab:3"
        cwd="/repo"
        roots={['/repo']}
        onOpenChanges={() => {}}
        onOpenFiles={() => {}}
        onOpenSideChat={() => {}}
        onOpenBrowser={() => {}}
        onOpenTerminal={() => {}}
        onOpenFile={() => {}}
      />,
    );
    const search = screen.getByTestId('new-tab-search');
    fireEvent.change(search, { target: { value: 'definitely-missing-file' } });
    fireEvent.submit(search.closest('form')!);
    expect(screen.getByTestId('new-tab-no-match')).toBeTruthy();
  });

  it('disables files and changes when there is no workspace', () => {
    render(
      <NewTabPage
        tabKey="new-tab:2"
        onOpenChanges={() => {}}
        onOpenFiles={() => {}}
        onOpenSideChat={() => {}}
        onOpenBrowser={() => {}}
        onOpenTerminal={() => {}}
        onOpenFile={() => {}}
      />,
    );
    expect((screen.getByTestId('new-tab-open-files') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('new-tab-open-changes') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('new-tab-open-side-chat') as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByTestId('new-tab-open-browser') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('new-tab-open-terminal') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('new-tab-context')).toBeNull();
  });

  it('renders grouped sections, project context bar, and changes badge', () => {
    render(
      <NewTabPage
        tabKey="new-tab:4"
        cwd="/repo/worktree-a"
        projectPrimary="/repo/xy-token-api"
        changesCount={4}
        onOpenChanges={() => {}}
        onOpenFiles={() => {}}
        onOpenSideChat={() => {}}
        onOpenBrowser={() => {}}
        onOpenTerminal={() => {}}
        onOpenFile={() => {}}
      />,
    );

    const sections = screen.getAllByTestId('new-tab-section');
    expect(sections.map((el) => el.getAttribute('data-section-id'))).toEqual([
      'workspace',
      'tools',
    ]);
    const contextBar = screen.getByTestId('new-tab-context');
    expect(contextBar.textContent).toContain('xy-token-api');
    expect(contextBar.textContent).toContain('/repo/xy-token-api');
    expect(screen.getByTestId('new-tab-changes-badge').textContent).toBe('4');
  });
});
