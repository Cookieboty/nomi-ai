/**
 * 终端标签页用到的纯函数与主题/快捷键辅助（从 TerminalTab.tsx 拆出以控制组件文件体积）。
 */
import { t } from '@nomi-ai/ui';
import type { ITheme } from '@xterm/xterm';

import { resourcePreviewClient } from '../../services/resourcePreviewClient';
import type { PaneNavDirection } from '../../utils/terminalSplit';

function isDarkTheme(): boolean {
  const el = document.documentElement;
  const theme = el.getAttribute('data-theme');
  if (theme === 'ink' || theme === 'graphite') return true;
  if (theme === 'light' || theme === 'sunset' || theme === 'cream' || theme === 'mist')
    return false;
  const scheme = getComputedStyle(el).colorScheme;
  return scheme.includes('dark');
}

export function readXtermTheme(): { theme: ITheme; fontFamily: string } {
  const css = getComputedStyle(document.documentElement);
  const getVar = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;

  const dark = isDarkTheme();
  const background = getVar('--cd-color-surface', dark ? '#18181b' : '#ffffff');
  const foreground = getVar('--cd-color-text', dark ? '#ececf1' : '#211d19');
  const cursor = getVar('--cd-color-accent-strong', dark ? '#e58f65' : '#9d3f29');
  const selectionBackground = getVar(
    '--cd-color-selected-bg',
    dark ? 'rgba(255,255,255,0.18)' : 'rgba(157,63,41,0.18)',
  );
  const fontFamily = getVar('--cd-font-mono', 'ui-monospace, Menlo, Consolas, monospace');

  const theme: ITheme = dark
    ? {
        background,
        foreground,
        cursor,
        cursorAccent: background,
        selectionBackground,
        black: '#27272a',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e4e4e7',
        brightBlack: '#71717a',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde047',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#fafafa',
      }
    : {
        background,
        foreground,
        cursor,
        cursorAccent: background,
        selectionBackground,
        black: '#211d19',
        red: '#b8382f',
        green: '#21734b',
        yellow: '#8f5a17',
        blue: '#2454a4',
        magenta: '#824096',
        cyan: '#176d7c',
        white: '#e5e0d7',
        brightBlack: '#685e55',
        brightRed: '#c9493f',
        brightGreen: '#288959',
        brightYellow: '#a86b1a',
        brightBlue: '#2e66c2',
        brightMagenta: '#9c52b3',
        brightCyan: '#1c8597',
        brightWhite: '#faf9f6',
      };

  return { theme, fontFamily };
}

export function openTerminalUri(uri: string): void {
  void resourcePreviewClient
    .external('', uri)
    .then((res) => {
      if (!res.ok) window.open(uri, '_blank', 'noopener,noreferrer');
    })
    .catch(() => {
      window.open(uri, '_blank', 'noopener,noreferrer');
    });
}

export function formatTerminalErrorReason(
  reason: string | undefined,
  message: string | undefined,
): string {
  if (reason === 'unsupported') return t('ui.session-workspace.terminal-unsupported');
  if (reason === 'limit') return t('ui.session-workspace.terminal-limit');
  return t('ui.session-workspace.terminal-failed', message || reason || 'error');
}

function isKeyD(e: KeyboardEvent): boolean {
  return e.code === 'KeyD' || e.key.toLowerCase() === 'd';
}

export function isSplitRightShortcut(e: KeyboardEvent, mac: boolean): boolean {
  if (!isKeyD(e)) return false;
  return mac
    ? e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey
    : e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
}

export function isSplitDownShortcut(e: KeyboardEvent, mac: boolean): boolean {
  if (!isKeyD(e)) return false;
  return mac
    ? e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey
    : e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey;
}

export function matchNavDirection(e: KeyboardEvent, mac: boolean): PaneNavDirection | null {
  const mods = mac
    ? e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey
    : e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey;
  if (!mods) return null;
  if (e.key === 'ArrowLeft') return 'left';
  if (e.key === 'ArrowRight') return 'right';
  if (e.key === 'ArrowUp') return 'up';
  if (e.key === 'ArrowDown') return 'down';
  return null;
}

export function matchCycleDirection(e: KeyboardEvent, mac: boolean): -1 | 1 | null {
  if (!mac || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (e.code === 'BracketLeft' || e.key === '[') return -1;
  if (e.code === 'BracketRight' || e.key === ']') return 1;
  return null;
}
