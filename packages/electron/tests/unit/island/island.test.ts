jest.unmock('fs');
jest.unmock('path');
jest.mock('electron', () => ({
  BrowserWindow: jest.fn(),
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
  screen: {
    getPrimaryDisplay: () => ({
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      workArea: { x: 0, y: 38, width: 1512, height: 944 },
      internal: true,
    }),
  },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  clampIslandHeight,
  hasNotch,
  islandGeometry,
  islandHeight,
  islandWindowRect,
  NOTCH_WIDTH,
} from '../../../src/island/geometry';
import { ISLAND_ICON_NODES } from '../../../src/island/islandIcons';
import { islandHtml } from '../../../src/island/islandPage';
import { IslandService, sanitizeIsland } from '../../../src/island/IslandService';

const notchMac = {
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 38, width: 1512, height: 944 },
  internal: true,
};
const plainMac = { ...notchMac, workArea: { x: 0, y: 25, width: 1512, height: 957 } };
const external = { ...notchMac, internal: false };
const win = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1032 },
};

describe('island geometry', () => {
  it('detects the notch only on internal macOS displays with a tall menu bar', () => {
    expect(hasNotch('darwin', notchMac)).toBe(true);
    expect(hasNotch('darwin', plainMac)).toBe(false);
    expect(hasNotch('darwin', external)).toBe(false);
    expect(hasNotch('win32', notchMac)).toBe(false);
  });

  it('notch: flush with the top edge, collapsed = notch size; otherwise a pill below the bar', () => {
    const g = islandGeometry('darwin', notchMac);
    expect(g).toMatchObject({ mode: 'notch', y: 0, menuBarHeight: 38 });
    expect(g.collapsed).toEqual({ width: NOTCH_WIDTH, height: 38 });
    expect(g.x + g.width / 2).toBeCloseTo(756, 0);
    const p = islandGeometry('darwin', plainMac);
    expect(p).toMatchObject({ mode: 'pill', y: 30 });
    expect(islandGeometry('darwin', notchMac, 'pill').mode).toBe('pill');
    expect(islandGeometry('win32', win)).toMatchObject({ mode: 'pill', y: 5 });
  });

  it('endpoint icons embed the Nomi mark, OpenAI and DeepSeek logos', () => {
    const html = islandHtml(islandGeometry('darwin', notchMac));
    const js = Buffer.from(
      /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '',
      'utf8',
    ).toString();
    expect(js).toContain('M9.205 8.658');
    expect(js).toContain('M23.748 4.482');
    expect(js).toContain('#FCEFE1');
  });

  it('page renders text via textContent only and has a strict CSP', () => {
    const html = islandHtml(islandGeometry('darwin', notchMac));
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('textContent');
    expect(html).not.toMatch(/innerHTML/);
  });

  it('page shows a per-endpoint icon (not a text badge) and status icon', () => {
    const html = islandHtml(islandGeometry('darwin', notchMac));
    expect(html).toContain('<svg id="ep"');
    expect(html).toContain('paintEndpoint');
    expect(html).toContain("setAttribute('aria-label'");
    expect(html).toContain("dsh: 'dsh'");
    expect(html).toContain('STATUS_ICON');
    expect(html).toContain("#island[data-status='failed']");
  });

  it('kind / status / spark icons are lucide stroke icons, not emoji', () => {
    const html = islandHtml(islandGeometry('darwin', notchMac));
    expect(html).toContain('paintIcon');
    expect(html).toContain("'stroke-width': 1.75");
    expect(html).toContain("stroke: 'currentColor'");
    for (const key of [
      'message',
      'agent',
      'reminder',
      'info',
      'done',
      'failed',
      'attention',
      'running',
      'spark',
    ]) {
      expect(ISLAND_ICON_NODES[key]?.length ?? 0).toBeGreaterThan(0);
    }
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u2726]/u);
  });
});

describe('island layout: window height follows content', () => {
  it('pill: symmetric 11px padding, no reserved top space', () => {
    const g = islandGeometry('darwin', plainMac);
    expect(g.inset).toBe(0);
    expect(g.pad).toEqual({ top: 11, bottom: 11 });
    // icon row 36 → 58; title + one body line 38 → 60
    expect(islandHeight(g, 36)).toBe(58);
    expect(islandHeight(g, 38)).toBe(60);
    expect(g.height).toBe(60);
    // gap to the menu bar / work area top
    expect(g.y - plainMac.workArea.y).toBe(5);
  });

  it('notch: only the real menu-bar (notch) height is reserved, then a small gap', () => {
    const g = islandGeometry('darwin', notchMac);
    expect(g.inset).toBe(38);
    expect(g.pad).toEqual({ top: 4, bottom: 12 });
    expect(islandHeight(g, 18)).toBe(38 + 4 + 12 + 18);
    expect(g.height).toBe(38 + 4 + 12 + 38);
    // a smaller menu bar reserves less — never a fixed large value
    const small = islandGeometry('darwin', {
      ...notchMac,
      workArea: { ...notchMac.workArea, y: 32 },
    });
    expect(small.inset).toBe(32);
    expect(small.height).toBeLessThan(g.height);
    // no notch: nothing reserved on the other displays
    expect(islandGeometry('darwin', external).inset).toBe(0);
    expect(islandGeometry('darwin', notchMac, 'pill').inset).toBe(0);
  });

  it('clamps content height and tolerates garbage measurements', () => {
    const g = islandGeometry('darwin', plainMac);
    expect(islandHeight(g, 1)).toBe(22 + 36);
    expect(islandHeight(g, 9999)).toBe(22 + 64);
    expect(islandHeight(g, Number.NaN)).toBe(60);
    expect(clampIslandHeight(g, 60)).toBe(60);
    expect(clampIslandHeight(g, 0)).toBe(58);
  });

  it('window rect = island + shadow margin (pill) or exactly the island (notch)', () => {
    const p = islandGeometry('darwin', plainMac);
    const r = islandWindowRect(p, 60);
    expect(r).toEqual({ x: p.x - 14, y: p.y, width: p.width + 28, height: 78 });
    const n = islandGeometry('darwin', notchMac);
    expect(islandWindowRect(n, 94)).toEqual({ x: n.x, y: 0, width: n.width, height: 94 });
  });

  it('page: top padding comes from the geometry, theme + status accents exist', () => {
    const pill = islandHtml(islandGeometry('darwin', plainMac));
    expect(pill).toContain('--padT: 11px');
    expect(pill).toContain('--padB: 11px');
    expect(pill).toContain('--inset: 0px');
    expect(pill).toContain('prefers-color-scheme: light');
    for (const st of ['running', 'done', 'failed', 'attention'])
      expect(pill).toContain(`#island[data-status='${st}']`);
    expect(pill).toContain('prefers-reduced-motion');
    expect(pill).toContain('class="pill"');
    const notch = islandHtml(islandGeometry('darwin', notchMac));
    expect(notch).toContain('--inset: 38px');
    expect(notch).toContain('class="notch"');
    expect(notch).toContain('#island.notch #icon');
    expect(notch).not.toContain('prefers-color-scheme: light'); // 刘海始终是黑色
    // prepare() measures the row so the main process can size the window
    expect(notch).toContain('prepare(n)');
  });
});

describe('IslandService policy', () => {
  const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'island-')), 'island.json');

  it('defaults: on for macOS, off for Windows/Linux', () => {
    expect(sanitizeIsland({}, 'darwin').enabled).toBe(true);
    expect(sanitizeIsland({}, 'win32').enabled).toBe(false);
    expect(sanitizeIsland({ style: 'weird' }, 'darwin').style).toBe('auto');
  });

  it('respects the toggle, per-kind switches and quiet hours (DND)', () => {
    let quiet = false;
    const s = new IslandService({ file: file(), platform: 'darwin', isQuiet: () => quiet });
    const n = { kind: 'agent' as const, title: 'Claude Code', body: 'done' };
    expect(s.accepts(n)).toBe(true);
    quiet = true;
    expect(s.accepts(n)).toBe(false);
    expect(s.accepts(n, true)).toBe(true); // 设置页「预览」
    quiet = false;
    s.set({ kinds: { message: true, agent: false, reminder: true } });
    expect(s.accepts(n)).toBe(false);
    expect(s.accepts({ ...n, kind: 'reminder' })).toBe(true);
    s.set({ enabled: false });
    expect(s.accepts({ ...n, kind: 'reminder' })).toBe(false);
    const w = new IslandService({ file: file(), platform: 'win32' });
    expect(w.accepts(n)).toBe(false);
  });
});
