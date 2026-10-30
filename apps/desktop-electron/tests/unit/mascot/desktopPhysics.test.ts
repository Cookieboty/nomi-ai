import {
  advance,
  areaUnder,
  clampToWorld,
  floorFor,
  pickWanderTarget,
  step,
  VelocityTracker,
  type BodyState,
  type PhysicsEnv,
} from '../../../src/mascot/desktopPhysics';

// 两块并排显示器：左 1920x1040（任务栏 40px），右 1280x1024 且更靠下（地面不同）
const LEFT = { x: 0, y: 0, width: 1920, height: 1040 };
const RIGHT = { x: 1920, y: 200, width: 1280, height: 984 };
const box = { left: 100, right: 300, top: 50, bottom: 400 };
const env = (over: Partial<PhysicsEnv> = {}): PhysicsEnv => ({
  workAreas: [LEFT, RIGHT],
  box,
  gravity: true,
  ...over,
});
const body = (o: Partial<BodyState>): BodyState => ({
  x: 500,
  y: 0,
  vx: 0,
  vy: 0,
  mode: 'idle',
  ...o,
});

describe('desktopPhysics: geometry', () => {
  it('picks the work area under the character centre, nearest when in a gap', () => {
    expect(areaUnder([LEFT, RIGHT], 100)).toBe(LEFT);
    expect(areaUnder([LEFT, RIGHT], 2500)).toBe(RIGHT);
    expect(areaUnder([LEFT, RIGHT], 4000)).toBe(RIGHT);
    expect(floorFor([LEFT, RIGHT], 100)).toBe(1040);
    expect(floorFor([LEFT, RIGHT], 2500)).toBe(1184);
  });

  it('clamps into the walls / floor / top', () => {
    const c = clampToWorld(body({ x: -500, y: 5000 }), env());
    expect(c.x).toBe(-100);
    expect(c.y).toBe(1040 - 400);
    const top = clampToWorld(body({ x: 500, y: -500 }), env());
    expect(top.y).toBe(-50);
  });
});

describe('desktopPhysics: falling', () => {
  it('falls under gravity and lands on the taskbar edge', () => {
    let s = body({ mode: 'falling', y: 0 });
    let landed = false;
    for (let i = 0; i < 600 && !landed; i += 1) {
      const r = step(s, 1 / 120, env());
      s = r.state;
      landed = r.events.some((e) => e.type === 'land');
    }
    expect(landed).toBe(true);
    expect(s.mode).toBe('idle');
    expect(s.y + box.bottom).toBe(1040);
  });

  it('bounces when the impact is hard, with energy loss', () => {
    const s = body({ mode: 'falling', y: 1040 - 400 - 1, vy: 2000 });
    const r = step(s, 1 / 120, env());
    const bounce = r.events.find((e) => e.type === 'bounce');
    expect(bounce).toBeDefined();
    expect(r.state.vy).toBeLessThan(0);
    expect(Math.abs(r.state.vy)).toBeLessThan(2000 * 0.5);
  });

  it('eventually settles (no infinite bouncing)', () => {
    const r = advance(body({ mode: 'falling', y: 0, vy: 0 }), 5, env(), 1 / 120, 1000);
    expect(r.state.mode).toBe('idle');
    expect(r.state.vy).toBe(0);
  });

  it('bounces off walls and reports the side', () => {
    const s = body({ mode: 'falling', x: -99, y: 100, vx: -1500 });
    const r = step(s, 1 / 60, env());
    expect(r.events.some((e) => e.type === 'wall' && e.side === 'left')).toBe(true);
    expect(r.state.vx).toBeGreaterThan(0);
    expect(r.state.x + box.left).toBe(0);
  });

  it('walking off the higher display onto the lower one makes her fall', () => {
    // 角色中心走到右屏上方：右屏地面更低 → 开始下落
    const s = body({ x: 1920 - 200 + 50, y: 1040 - 400, mode: 'idle' });
    const r = step(s, 1 / 120, env());
    expect(r.state.mode).toBe('falling');
  });

  it('without gravity she stays where she is dropped', () => {
    const r = advance(body({ y: 100, mode: 'idle' }), 1, env({ gravity: false }));
    expect(r.state.mode).toBe('idle');
    expect(r.state.y).toBeCloseTo(100, 5);
  });

  it('held state is not simulated', () => {
    const r = step(body({ mode: 'held', y: 10, vy: 999 }), 1, env());
    expect(r.state.y).toBe(10);
  });
});

describe('desktopPhysics: wander + fixed step', () => {
  it('walks to the target and arrives', () => {
    let s = body({ x: 500, y: 640, mode: 'walking', walkTargetX: 560 });
    let arrived = false;
    for (let i = 0; i < 400 && !arrived; i += 1) {
      const r = step(s, 1 / 60, env());
      s = r.state;
      arrived = r.events.some((e) => e.type === 'arrive');
    }
    expect(arrived).toBe(true);
    expect(s.x).toBe(560);
    expect(s.mode).toBe('idle');
  });

  it('wander target stays inside the current work area', () => {
    let seed = 0.1;
    const rnd = () => (seed = (seed * 9301 + 0.49297) % 1);
    for (let i = 0; i < 50; i += 1) {
      const t = pickWanderTarget(body({ x: 10 }), env(), rnd);
      expect(t).toBeGreaterThanOrEqual(-box.left);
      expect(t).toBeLessThanOrEqual(1920 - box.right);
    }
  });

  it('fixed timestep is independent of frame chunking', () => {
    const s0 = body({ mode: 'falling', y: 0, vx: 300 });
    const one = advance(s0, 0.5, env(), 1 / 120, 1000).state;
    let s = s0;
    let acc = 0;
    for (let i = 0; i < 30; i += 1) {
      const r = advance(s, acc + 1 / 60, env(), 1 / 120, 1000);
      s = r.state;
      acc = r.accumulator;
    }
    expect(s.y).toBeCloseTo(one.y, 3);
    expect(s.x).toBeCloseTo(one.x, 3);
  });
});

describe('VelocityTracker', () => {
  it('estimates throw velocity and forgets stale motion', () => {
    const v = new VelocityTracker();
    v.reset(0, 0, 0);
    for (let t = 16; t <= 160; t += 16) v.sample(t * 2, -t, t); // 2000 px/s, -1000 px/s
    const r = v.release(165);
    expect(r.vx).toBeGreaterThan(1500);
    expect(r.vy).toBeLessThan(-700);
    expect(v.release(1000)).toEqual({ vx: 0, vy: 0 });
  });

  it('clamps crazy speeds', () => {
    const v = new VelocityTracker();
    v.reset(0, 0, 0);
    v.sample(100000, 0, 1);
    const r = v.release(2, 4000);
    expect(Math.hypot(r.vx, r.vy)).toBeLessThanOrEqual(4000.001);
  });
});
