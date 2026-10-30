#!/usr/bin/env node
/**
 * D-B10-3 golden parity：Node 的 desktopPhysics 与 MascotWindowController 在固定场景下的完整轨迹
 * （窗口操作 / 推送事件 / debugSnapshot），写到 apps/desktop-go/internal/core/mascot/testdata/physics.json。
 * Go 侧 mascot/physics_parity_test.go 回放同样的场景并逐项比对。
 *
 * 用法：pnpm exec tsx scripts/parity/record-mascot-physics.mjs
 * （控制器按平台分别在子进程里录：process.platform 是模块级常量；'electron' 由 stubs/ 解析到桩）
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);

// mulberry32：Go 侧逐位相同
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const area = (x, y, w, h, sf) => ({
  x,
  y,
  width: w,
  height: h,
  ...(sf ? { scaleFactor: sf } : {}),
});
const WORLDS = [
  [area(0, 0, 1920, 1040)],
  [area(0, 0, 1920, 1040), area(1920, 0, 1280, 1000, 1.25)],
  [area(0, 25, 1366, 743, 1.5), area(-1280, 200, 1280, 1024)],
];
const BOXES = [
  { left: 60, right: 270, top: 130, bottom: 355 },
  { left: 75.5, right: 254.25, top: 141.7, bottom: 349.6 },
];

// 每个 Scenario 是一串动作；Go 侧照同样的语义解释
const SCENARIOS = [
  {
    name: 'start-fall-land',
    world: 0,
    win: [100, 200, 0.5],
    steps: [
      ['start'],
      ['config', { gravity: true }],
      ['geometry', { ...BOXES[0], vw: 330, vh: 355 }],
      ['run', 2500],
      ['cursor', 400, 500],
      ['run', 300],
      ['hit', true],
      ['hit', false],
      ['run', 200],
    ],
  },
  {
    name: 'drag-throw',
    world: 1,
    win: [1700, 600, 0.5],
    steps: [
      ['start'],
      ['config', { gravity: true }],
      ['geometry', BOXES[1]],
      ['run', 1500],
      ['beginDrag', 1800, 800],
      ['run', 16],
      ['moveDrag', 1830, 780],
      ['run', 16],
      ['moveDrag', 1900, 700],
      ['run', 16],
      ['moveDrag', 2000, 650],
      ['run', 16],
      ['cursor', 2000, 650],
      ['moveDrag', 2050, 640],
      ['endDrag'],
      ['run', 3000],
    ],
  },
  {
    name: 'wander',
    world: 0,
    win: [800, 685, 0.5],
    steps: [
      ['start'],
      ['config', { wander: true, gravity: false }],
      ['geometry', BOXES[0]],
      ['run', 16000],
      ['run', 4000],
      ['wanderNow'],
      ['run', 3000],
      ['config', { wander: false }],
      ['run', 500],
      ['config', { wander: true }],
      ['run', 70000],
    ],
  },
  {
    name: 'scale-shape-clickthrough',
    world: 2,
    win: [200, 300, 0.5],
    steps: [
      ['start'],
      ['geometry', BOXES[0]],
      ['run', 200],
      ['scaleStep', 1],
      ['geometry', { ...BOXES[0], vw: 330, vh: 355 }],
      ['scaleSet', 1.2],
      ['scaleWheel', -240, 0],
      ['scaleReset'],
      ['key', 'keyDown', 'Equal', '=', true, false, false],
      ['key', 'keyDown', 'KeyA', 'a', true, false, false],
      [
        'shape',
        [
          { x: 10.4, y: 20.6, width: 30.2, height: 40.9 },
          { x: 'a' },
          { x: -5, y: 400, width: 9999, height: 3 },
        ],
      ],
      ['shape', []],
      ['config', { clickThrough: false }],
      ['shape', [{ x: 1, y: 1, width: 2, height: 2 }]],
      ['hit', false],
      ['config', { clickThrough: true }],
      ['hit', false],
      ['run', 150],
      ['hit', true],
      ['displays', [area(0, 25, 800, 400)]],
      ['run', 300],
      ['displays', WORLDS[2]],
      ['run', 300],
    ],
  },
  {
    name: 'hidden-wake',
    world: 0,
    win: [100, 685, 0.5],
    steps: [
      ['start'],
      ['geometry', BOXES[0]],
      ['run', 500],
      ['visible', false],
      ['run', 3500],
      ['cursor', 50, 50],
      ['visible', true],
      ['wake'],
      ['run', 600],
      ['destroy'],
      ['run', 200],
    ],
  },
];

function recordPhysics(P) {
  const rnd = mulberry32(42);
  const out = {
    step: [],
    advance: [],
    tracker: [],
    wander: [],
    anchor: [],
    fallAtStart: [],
    areaUnder: [],
    clamp: [],
  };
  const modes = ['idle', 'held', 'falling', 'walking'];
  for (let i = 0; i < 400; i++) {
    const wi = i % WORLDS.length;
    const env = { workAreas: WORLDS[wi], box: BOXES[i % 2], gravity: i % 3 !== 0 };
    const s = {
      x: Math.round(rnd() * 3600 - 1400),
      y: Math.round(rnd() * 1200 - 150),
      vx: (rnd() - 0.5) * 6000,
      vy: (rnd() - 0.5) * 6000,
      mode: modes[i % 4],
    };
    if (s.mode === 'walking') s.walkTargetX = Math.round(rnd() * 2000);
    out.step.push({ in: [s, 1 / 120, env], out: P.step(s, 1 / 120, env) });
    const acc = rnd() * 0.25;
    out.advance.push({ in: [s, acc, env], out: P.advance(s, acc, env) });
    out.clamp.push({ in: [s, env], out: P.clampToWorld(s, env) });
    out.fallAtStart.push({ in: [s, env], out: P.shouldFallAtStart(s, env) });
    const seed = 1000 + i;
    out.wander.push({ in: [s, env, seed], out: P.pickWanderTarget(s, env, mulberry32(seed)) });
    out.anchor.push({
      in: [s, BOXES[i % 2], BOXES[(i + 1) % 2], WORLDS[wi]],
      out: P.anchorOnBoxChange(s, BOXES[i % 2], BOXES[(i + 1) % 2], WORLDS[wi]),
    });
    const cx = rnd() * 5000 - 1500;
    out.areaUnder.push({ in: [WORLDS[wi], cx], out: P.areaUnder(WORLDS[wi], cx) });
  }
  for (let k = 0; k < 20; k++) {
    const t = new P.VelocityTracker();
    const ops = [];
    let now = rnd() * 1000;
    if (k % 3) {
      const x = rnd() * 1000,
        y = rnd() * 1000;
      t.reset(x, y, now);
      ops.push(['reset', x, y, now]);
    }
    for (let j = 0; j < 12; j++) {
      now += [0, 4, 8, 16.7, 33, -2][Math.floor(rnd() * 6)];
      const x = rnd() * 2000,
        y = rnd() * 2000;
      t.sample(x, y, now);
      ops.push(['sample', x, y, now, t.vx, t.vy]);
    }
    for (const dt of [0, 50, 81]) {
      const r = t.release(now + dt);
      ops.push(['release', now + dt, r.vx, r.vy]);
    }
    out.tracker.push(ops);
  }
  return out;
}

async function recordController(platform) {
  Object.defineProperty(process, 'platform', { value: platform });
  const { MascotWindowController } = await imp(
    'apps/desktop-electron/src/mascot/MascotWindowController.ts',
  );
  const { mascotWindowSize } = await imp(
    'apps/desktop-electron/internal/core/src/mascot/mascotSize.ts',
  );
  const traces = [];
  for (const sc of SCENARIOS) {
    let now = 1000;
    let timers = [];
    let tid = 0;
    globalThis.performance.now = () => now;
    globalThis.setTimeout = (fn, ms) => {
      const t = { id: ++tid, due: now + ms, fn };
      timers.push(t);
      return t;
    };
    globalThis.clearTimeout = (t) => {
      timers = timers.filter((x) => x !== t);
    };
    const listeners = {};
    const on = (ch, fn) => (listeners[ch] ??= []).push(fn);
    const emit = (ch, ...a) => (listeners[ch] ?? []).forEach((fn) => fn(...a));
    let cursor = { x: 0, y: 0 };
    let displays = WORLDS[sc.world];
    globalThis.__fakeScreen = {
      on: (ch, fn) => on(ch, fn),
      cursor: () => ({ ...cursor }),
      displays: () =>
        displays.map(({ scaleFactor, ...wa }) => ({ workArea: wa, scaleFactor: scaleFactor ?? 1 })),
    };
    const [wx, wy, ws] = sc.win;
    const b = { x: wx, y: wy, ...mascotWindowSize(ws) };
    const st = { resizable: false, visible: true, minimized: false, destroyed: false };
    let log = [];
    const win = {
      webContents: { setVisualZoomLevelLimits() {}, on: (ch, fn) => on(ch, fn), off() {} },
      on: (ch, fn) => on(ch, fn),
      off() {},
      isDestroyed: () => st.destroyed,
      getPosition: () => [b.x, b.y],
      getSize: () => [b.width, b.height],
      getBounds: () => ({ ...b }),
      setBounds: (n) => {
        log.push(['setBounds', n.x, n.y, n.width, n.height]);
        Object.assign(b, n);
      },
      setPosition: (x, y) => {
        log.push(['setPosition', x, y]);
        b.x = x;
        b.y = y;
      },
      isResizable: () => st.resizable,
      setResizable: (v) => {
        log.push(['setResizable', v]);
        st.resizable = v;
      },
      isVisible: () => st.visible,
      isMinimized: () => st.minimized,
      setIgnoreMouseEvents: (v) => log.push(['setIgnoreMouseEvents', v]),
      setShape: (r) => log.push(['setShape', r]),
    };
    const events = { publish: (ch, p) => log.push(['publish', ch, JSON.parse(JSON.stringify(p))]) };
    const ctl = new MascotWindowController(
      win,
      { info() {}, warn() {} },
      mulberry32(7),
      { get: () => ws, save: (v) => log.push(['save', v]) },
      events,
    );
    const run = (ms) => {
      const end = now + ms;
      for (;;) {
        timers.sort((a, c) => a.due - c.due || a.id - c.id);
        const t = timers[0];
        if (!t || t.due > end) break;
        timers.shift();
        now = t.due;
        t.fn();
      }
      now = end;
    };
    const out = [];
    for (const s of sc.steps) {
      log = [];
      let ret;
      switch (s[0]) {
        case 'start':
          ctl.start();
          break;
        case 'run':
          run(s[1]);
          break;
        case 'config':
          ctl.setConfig(s[1]);
          break;
        case 'geometry':
          ctl.reportGeometry(s[1]);
          break;
        case 'cursor':
          cursor = { x: s[1], y: s[2] };
          break;
        case 'hit':
          ctl.reportHit(s[1]);
          break;
        case 'shape':
          ctl.reportShape(s[1]);
          break;
        case 'beginDrag':
          ctl.beginDrag(s[1], s[2]);
          break;
        case 'moveDrag':
          ctl.moveDrag(s[1], s[2]);
          break;
        case 'endDrag':
          ctl.endDrag();
          break;
        case 'wanderNow':
          ctl.wanderNow();
          break;
        case 'scaleStep':
          ret = ctl.scaleStep(s[1]);
          break;
        case 'scaleSet':
          ret = ctl.scaleSet(s[1]);
          break;
        case 'scaleWheel':
          ret = ctl.scaleWheel(s[1], s[2]);
          break;
        case 'scaleReset':
          ret = ctl.scaleReset();
          break;
        case 'key': {
          let handled = false;
          emit(
            'before-input-event',
            { preventDefault: () => (handled = true) },
            { type: s[1], code: s[2], key: s[3], control: s[4], meta: s[5], alt: s[6] },
          );
          ret = handled;
          break;
        }
        case 'displays':
          displays = s[1];
          emit('display-metrics-changed');
          break;
        case 'visible':
          st.visible = s[1];
          break;
        case 'wake':
          emit('show');
          break;
        case 'destroy':
          st.destroyed = true;
          emit('closed');
          break;
      }
      out.push({
        step: s,
        now,
        ret: ret === undefined ? null : JSON.parse(JSON.stringify(ret)),
        log,
        snap: JSON.parse(JSON.stringify(ctl.snapshot())),
        pos: [b.x, b.y, b.width, b.height],
      });
    }
    traces.push({ name: sc.name, world: sc.world, win: sc.win, out });
  }
  return traces;
}

if (process.argv[2] === '--child') {
  process.stdout.write(JSON.stringify(await recordController(process.argv[3])));
} else {
  const P = await imp('apps/desktop-electron/src/mascot/desktopPhysics.ts');
  const fixture = { worlds: WORLDS, boxes: BOXES, physics: recordPhysics(P), controller: {} };
  for (const p of ['darwin', 'linux', 'win32']) {
    const raw = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--import',
        pathToFileURL(join(here, 'stubs/register.mjs')).href,
        fileURLToPath(import.meta.url),
        '--child',
        p,
      ],
      { cwd: root, maxBuffer: 1 << 28 },
    );
    fixture.controller[p] = JSON.parse(raw);
  }
  const out = join(root, 'apps/desktop-go/internal/core/mascot/testdata/physics.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(fixture) + '\n');
  console.log('wrote', out);
}
