// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useConversationListView } from '../src/hooks/useConversationListView';
import {
  dropRetiredPrefs,
  getConversationListView,
  setChatMode,
  setConversationListView,
  setEndpointFilter,
} from '../src/services/chatPrefs';

const Stub: React.FC = () => {
  const { view, setView, endpointFilter, setEndpointFilter: setEp } = useConversationListView();
  return (
    <div>
      <button
        type="button"
        data-testid="list-view-all"
        aria-pressed={view === 'all'}
        onClick={() => setView('all')}
      >
        全部
      </button>
      <button
        type="button"
        data-testid="list-view-by-endpoint"
        aria-pressed={view === 'by-endpoint'}
        onClick={() => setView('by-endpoint')}
      >
        按端
      </button>
      <button
        type="button"
        data-testid="endpoint-filter-codex"
        aria-pressed={endpointFilter === 'codex'}
        onClick={() => setEp('codex')}
      >
        Codex
      </button>
      <span data-testid="view">{view}</span>
      <span data-testid="filter">{endpointFilter}</span>
    </div>
  );
};

describe('conversation list view prefs', () => {
  beforeEach(() => {
    localStorage.clear();
    setChatMode('dev');
    setConversationListView('all');
    setEndpointFilter('nomi');
  });
  afterEach(() => cleanup());

  it('toggles all / by-endpoint and endpoint filter', () => {
    render(<Stub />);
    expect(screen.getByTestId('view').textContent).toBe('all');
    fireEvent.click(screen.getByTestId('list-view-by-endpoint'));
    expect(getConversationListView()).toBe('by-endpoint');
    expect(screen.getByTestId('view').textContent).toBe('by-endpoint');
    fireEvent.click(screen.getByTestId('endpoint-filter-codex'));
    expect(screen.getByTestId('filter').textContent).toBe('codex');
  });

  it('drops prefs left behind by retired features (常驻入口)', () => {
    localStorage.setItem('cd.chat.pins', '["newchat"]');
    dropRetiredPrefs();
    expect(localStorage.getItem('cd.chat.pins')).toBeNull();
  });
});
