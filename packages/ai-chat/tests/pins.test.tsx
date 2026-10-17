// @vitest-environment happy-dom
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatHeader } from '../src/components/ChatHeader';
import { PinsSettings } from '../src/components/SettingsView/PinsSettings';
import {
  DEFAULT_PINS,
  MAX_PINS,
  PIN_POOL,
  loadPins,
  movePin,
  normalizePins,
  savePins,
  togglePin,
} from '../src/services/pins';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('pins store', () => {
  it('defaults, normalises, caps and persists', () => {
    expect(loadPins()).toEqual(DEFAULT_PINS);
    expect(DEFAULT_PINS.length).toBeLessThanOrEqual(4);
    expect(normalizePins(['kb', 'kb', 'nope', 'snip'])).toEqual(['kb', 'snip']);
    expect(normalizePins(PIN_POOL.map((p) => p.id))).toHaveLength(MAX_PINS);
    savePins(['hub', 'desktop']);
    expect(loadPins()).toEqual(['hub', 'desktop']);
    savePins([]);
    expect(loadPins()).toEqual([]);
  });
  it('toggle respects max; move reorders', () => {
    const six = PIN_POOL.slice(0, MAX_PINS).map((p) => p.id);
    expect(togglePin(six, 'settings')).toBe(six);
    expect(togglePin(six, six[0]!)).toHaveLength(MAX_PINS - 1);
    expect(movePin(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });
});

const header = (onNewChat = vi.fn()) =>
  render(
    <ChatHeader
      onMemory={vi.fn()}
      onKnowledge={vi.fn()}
      onSchedule={vi.fn()}
      onExt={vi.fn()}
      onLocal={vi.fn()}
      onSettings={vi.fn()}
      onNewChat={onNewChat}
    />,
  );

describe('ChatHeader pins', () => {
  it('renders defaults, runs commands, right-click unpins', () => {
    const onNewChat = vi.fn();
    const cmd = vi.fn();
    window.addEventListener('cd:cmd', (e) => cmd((e as CustomEvent).detail));
    const r = header(onNewChat);
    for (const id of DEFAULT_PINS) expect(r.getByTestId(`pin-${id}`)).toBeTruthy();
    fireEvent.click(r.getByTestId('pin-newchat'));
    expect(onNewChat).toHaveBeenCalled();
    fireEvent.click(r.getByTestId('pin-snip'));
    expect(cmd).toHaveBeenCalledWith('snip');
    fireEvent.contextMenu(r.getByTestId('pin-kb'));
    fireEvent.click(r.getByTestId('pin-unpin'));
    expect(r.queryByTestId('pin-kb')).toBeNull();
    expect(loadPins()).not.toContain('kb');
    // 右上角图标：右键固定到左上角
    fireEvent.contextMenu(r.getByTestId('open-settings'));
    fireEvent.click(r.getByTestId('pin-pin'));
    expect(r.getByTestId('pin-settings')).toBeTruthy();
  });
});

describe('PinsSettings', () => {
  it('check, reorder (button + Alt+Arrow), reset', () => {
    const r = render(<PinsSettings />);
    fireEvent.click(r.getByTestId('pin-check-desktop'));
    expect(loadPins()).toEqual([...DEFAULT_PINS, 'desktop']);
    fireEvent.click(r.getByTestId('pin-up-desktop'));
    expect(loadPins().at(-2)).toBe('desktop');
    fireEvent.keyDown(r.getByTestId('pin-order-desktop'), { key: 'ArrowUp', altKey: true });
    expect(loadPins().at(-3)).toBe('desktop');
    fireEvent.click(r.getByTestId('pin-check-screen'));
    fireEvent.click(r.getByTestId('pin-check-local'));
    expect(loadPins()).toHaveLength(MAX_PINS);
    expect((r.getByTestId('pin-check-ext') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(r.getByTestId('pins-reset'));
    expect(loadPins()).toEqual(DEFAULT_PINS);
    expect(within(r.getByTestId('pins-settings')).getAllByRole('listitem').length).toBeGreaterThan(
      0,
    );
  });
});
