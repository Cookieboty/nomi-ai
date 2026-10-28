/**
 * Nomi action library — keyframe actions over the 2D layered rig parameters (see params.ts).
 *
 * Authoring rules
 *  - Only action / pose parameters are driven here. Brand layers (hair clips, ribbon, N logo, tag,
 *    choker charm …) are never touched; arms are the master sleeve cut into rigid pieces, hands are the
 *    hand pieces, faces use the master eye / mouth plates plus vector strokes.
 *  - Arm poses are given as [shoulder a°, elbow e°, wrist w°]; they were solved against the real
 *    geometry so hands land in the free space around the head (never off the canvas).
 *  - First / last keys of a one-shot are the rest pose; the manager crossfades the weights.
 */
import type { ActionDef, Ease, Key, Track } from './actionTypes';
import { BROW, EYE, HAND, MOUTH } from './params';

type Pose = readonly [a: number, e: number, w: number];

const T = (p: string, ...k: Key[]): Track => ({ p, k });

/** hold a discrete code between two times */
const hold = (p: string, from: number, to: number, v: number): Track =>
  from <= 0 ? T(p, [0, v], [to, 0, 's']) : T(p, [0, 0], [from, v, 's'], [to, 0, 's']);

/**
 * One arm: anticipation dip → lift (overshoot) → hold → lower back to rest. Actions that end before
 * `dur - 0.3` lower the arm on their own (real swing, foreshortened by the animator); held actions
 * and ones that run to the end keep the pose and let the manager cross-fade the sleeve back.
 */
function arm(
  side: 'r' | 'l',
  hand: number,
  pose: Pose,
  t0: number,
  t1: number,
  dur: number,
  opts: ArmOpts = {},
): Track[] {
  const ease = opts.ease ?? 'b';
  const win = opts.win ?? [t0, t1];
  const ret = opts.ret ?? t1 <= dur - 0.3;
  // stronger anticipation (shoulder dip / elbow prep) so lifts don't pop from rest
  const ant = [
    Math.min(-6, -Math.abs(pose[0]) * 0.18),
    Math.min(-10, -Math.abs(pose[1]) * 0.1),
    Math.min(-4, -Math.abs(pose[2]) * 0.08),
  ];
  const key = (i: number): Key[] => {
    // swing ≥0.45s; land with a touch of overshoot then settle
    const tAnt = Math.max(0.08, t0 * 0.35);
    const tUp = Math.min(Math.max(t0, tAnt + 0.45), t1 - 0.08);
    const overshoot = pose[i] * (pose[i] >= 0 ? 1.06 : 1.06);
    const keys: Key[] = [
      [0, 0],
      [tAnt, ant[i], 'o'],
      [tUp, overshoot, ease],
      [Math.min(tUp + 0.18, t1), pose[i], 'io'],
    ];
    if (ret) {
      // settle hold, then ease home with a soft undershoot so it doesn't hard-stop
      const tDown = Math.min(dur, Math.max(t1, tUp + 0.25));
      keys.push([t1, pose[i]], [tDown, pose[i] * 0.12, 'io'], [dur, 0, 'io']);
    } else keys.push([dur, pose[i]]);
    return keys;
  };
  const tHandOn = Math.max(0.12, t0 * 0.55);
  const tHandOff = ret ? Math.max(t1, dur - 0.35) : dur;
  return [
    T(`${side}On`, [0, 1]),
    // swap the hand shape after the lift starts and drop it before the arm fully rests
    T(
      `${side}Hand`,
      [0, 0],
      [tHandOn, hand, 's'],
      [tHandOff, hand, 's'],
      [Math.min(dur, tHandOff + 0.01), 0, 's'],
    ),
    { p: `${side}A`, k: key(0), osc: opts.oscA, oscWin: win },
    { p: `${side}E`, k: key(1), osc: opts.oscE, oscWin: win },
    { p: `${side}W`, k: key(2), osc: opts.oscW, oscWin: win },
  ];
}
type Osc = [amp: number, hz: number, phase?: number];
type ArmOpts = {
  oscE?: Osc;
  oscW?: Osc;
  oscA?: Osc;
  win?: [number, number];
  ease?: Ease;
  /** lower the arm again before the action ends (default: when t1 <= dur - 0.3) */
  ret?: boolean;
};
const both = (
  hand: number,
  r: Pose,
  l: Pose,
  t0: number,
  t1: number,
  dur: number,
  o: ArmOpts = {},
) => [...arm('r', hand, r, t0, t1, dur, o), ...arm('l', hand, l, t0, t1, dur, o)];

/** pulse: 0 → v → 0 over [from, to] */
const pulse = (p: string, from: number, peak: number, to: number, v: number): Track =>
  T(p, [0, 0], [from, 0], [peak, v, 'o'], [to, 0, 'io']);

// --- solved arm poses (right / left) -----------------------------------------------------------
const P = {
  // Mild on-canvas raises: long right sleeve exits the 960px frame past ~22° shoulder.
  // Distal foreshortening + stump-locked mesh keep sleeve+hand continuous and visible.
  // [shoulder°, elbow°, wrist°] — wrist authored, not left at 0 (flat PNG flap)
  waveUp: { r: [12, 82, 18], l: [10, 85, -14] },
  waveOut: { r: [14, 76, 22], l: [14, 76, -18] },
  fistUp: { r: [14, 86, -10], l: [12, 88, -16] },
  peaceUp: { r: [12, 82, 8], l: [10, 85, -10] },
  thumb: { r: [8, 78, 22], l: [6, 78, 18] },
  point: { r: [6, 82, 12], l: [4, 82, 10] },
  chin: { r: [5, 92, 28], l: [3, 90, 24] },
  cheeks: { r: [5, 90, 20], l: [5, 90, 20] },
  surprise: { r: [10, 62, 8], l: [10, 62, -8] },
  salute: { r: [14, 86, -18], l: [12, 82, -8] },
  heart: { r: [7, 84, 42], l: [5, 84, 40] },
  chest: { r: [-45, -65, -30], l: [4, 78, 32] },
  type: { r: [8, 88, 48], l: [6, 88, 46] },
  stretch: { r: [14, 66, -14], l: [12, 64, -10] },
  // bilateral 合十: both forearms come in to the chest centre; one joined prayer piece
  pray: { r: [-57, -70, -42], l: [-57, -70, -42] },
  clap: { r: [7, 84, 36], l: [5, 82, 40] },
} as const satisfies Record<string, { r: Pose; l: Pose }>;

export const ACTIONS: readonly ActionDef[] = [
  // ---- greet ---------------------------------------------------------------------------------
  {
    id: 'wave',
    label: 'ui.voice-mascot.wave',
    category: 'greet',
    dur: 2.3,
    trigger: '问候 / 早安 / 首次打开 / 用户说“你好”', // i18n-ignore
    tracks: [
      ...arm('r', HAND.wave, P.waveOut.r, 0.45, 1.85, 2.3, {
        oscW: [18, 2.8, 0],
        oscE: [4, 2.8, 1.4],
        win: [0.55, 1.85],
      }),
      pulse('headRot', 0.2, 0.7, 2.2, 7),
      pulse('headNod', 0.1, 0.35, 0.8, 5),
      hold('mouth', 0.3, 1.9, MOUTH.smile),
      pulse('blush', 0.3, 0.8, 2.0, 0.2),
    ],
  },
  {
    id: 'hello',
    label: 'ui.mascot-theme.greet',
    category: 'greet',
    dur: 1.9,
    priority: 1,
    trigger: '界面首次出现的轻招呼（点头 + 小幅挥手）', // i18n-ignore
    tracks: [
      ...arm('r', HAND.wave, P.waveUp.r, 0.35, 1.5, 1.9, {
        oscW: [14, 3.1, 0],
        oscE: [3, 3.1, 1.3],
        win: [0.45, 1.5],
      }),
      T('headNod', [0, 0], [0.3, 8, 'o'], [0.6, 0, 'io'], [0.95, 5, 'o'], [1.4, 0]),
      hold('mouth', 0.25, 1.6, MOUTH.smile),
    ],
  },
  {
    id: 'nod',
    label: 'ui.voice-mascot.nod',
    category: 'agree',
    dur: 1.2,
    trigger: '回答“好 / 明白了”、确认', // i18n-ignore
    tracks: [
      T('headNod', [0, 0], [0.22, 12, 'o'], [0.45, 0, 'io'], [0.7, 11, 'o'], [1.1, 0, 'io']),
      T('shoulder', [0, 0], [0.25, -2, 'o'], [1.1, 0]),
      hold('eyeL', 0.15, 0.55, EYE.half),
      hold('eyeR', 0.15, 0.55, EYE.half),
      hold('mouth', 0.2, 1.0, MOUTH.smile),
    ],
  },
  {
    id: 'shake_head',
    label: 'ui.voice-mascot.shake-head',
    category: 'agree',
    dur: 1.4,
    trigger: '否定、“不行 / 没有”', // i18n-ignore
    tracks: [
      T('headRot', [0, 0], [0.18, 10, 'o'], [0.42, -10], [0.66, 9], [0.9, -8], [1.2, 0]),
      T('headX', [0, 0], [0.18, 6, 'o'], [0.42, -6], [0.66, 5], [0.9, -4], [1.2, 0]),
      hold('eyeL', 0.1, 1.15, EYE.closed),
      hold('eyeR', 0.1, 1.15, EYE.closed),
      hold('mouth', 0.1, 1.2, MOUTH.wavy),
      hold('brow', 0.1, 1.2, BROW.worried),
    ],
  },
  {
    id: 'bow',
    label: 'ui.voice-mascot.bow',
    category: 'greet',
    dur: 2.0,
    trigger: '感谢 / 告别 / 道歉的礼貌版', // i18n-ignore
    tracks: [
      T('headNod', [0, 0], [0.5, 20, 'io'], [1.3, 20], [2.0, 0, 'io']),
      T('bodyY', [0, 0], [0.5, 8, 'io'], [1.3, 8], [2.0, 0, 'io']),
      T('torsoRot', [0, 0], [0.5, 2, 'io'], [1.3, 2], [2.0, 0, 'io']),
      hold('eyeL', 0.35, 1.5, EYE.closed),
      hold('eyeR', 0.35, 1.5, EYE.closed),
      hold('mouth', 0.3, 1.6, MOUTH.smile),
    ],
  },
  {
    id: 'salute',
    label: 'ui.cli-monitor.salute',
    category: 'greet',
    dur: 1.9,
    trigger: '收到指令 / “收到！”', // i18n-ignore
    tracks: [
      ...arm('r', HAND.rest, P.salute.r, 0.35, 1.4, 1.9, {
        oscW: [3, 1.6, 0],
        win: [0.55, 1.35],
      }),
      T('headRot', [0, 0], [0.4, -3, 'o'], [1.5, -3], [1.9, 0]),
      hold('eyeL', 0.3, 1.5, EYE.determined),
      hold('eyeR', 0.3, 1.5, EYE.determined),
      hold('mouth', 0.3, 1.5, MOUTH.grin),
    ],
  },
  // ---- think / explain -----------------------------------------------------------------------

  {
    id: 'pray',
    label: 'ui.usage-tools.prayer-hands',
    category: 'emotion',
    dur: 2.8,
    trigger: '感谢 / 拜托 / 祈祷', // i18n-ignore
    tracks: [
      // both arms rise symmetrically; the renderer draws ONE prayer piece at their joint
      ...both(HAND.prayer, P.pray.r, P.pray.l, 0.45, 2.2, 2.8, { ease: 'io' }),
      hold('armFront', 0.35, 99, 1),
      T('headNod', [0, 0], [0.5, 10, 'io'], [2.0, 10], [2.8, 0]),
      hold('eyeL', 0.4, 2.4, EYE.closed),
      hold('eyeR', 0.4, 2.4, EYE.closed),
      hold('mouth', 0.4, 2.4, MOUTH.smile),
      T('fxSparkle', [0, 0], [0.6, 0.6], [2.2, 0.6], [2.8, 0]),
    ],
  },
  {
    id: 'ok_hand',
    label: 'ui.usage-tools.ok-gesture',
    category: 'celebrate',
    dur: 2.2,
    trigger: '确认 / 没问题 / OK', // i18n-ignore
    tracks: [
      ...arm('r', HAND.ok, P.thumb.r, 0.35, 1.8, 2.2),
      T('headNod', [0, 0], [0.4, 6, 'o'], [1.6, 6], [2.2, 0]),
      hold('eyeL', 0.3, 1.9, EYE.happy),
      hold('eyeR', 0.3, 1.9, EYE.happy),
      hold('mouth', 0.3, 1.9, MOUTH.smile),
      T('fxSparkle', [0, 0], [0.4, 0.7], [1.8, 0.7], [2.2, 0]),
    ],
  },
  {
    id: 'think',
    label: 'ui.cli-monitor.chin-rest-thinking',
    category: 'think',
    dur: 3.4,
    hold: true,
    maxHold: 14,
    loopFrom: 1.6,
    priority: 1,
    trigger: 'AI 思考中 / 长时间等待', // i18n-ignore
    tracks: [
      ...arm('r', HAND.rest, P.chin.r, 0.5, 3.4, 3.4, {
        ease: 'io',
        oscW: [4, 1.1, 0],
        oscE: [2, 0.9, 0.5],
        win: [0.8, 99],
      }),
      hold('armFront', 0.3, 99, 1),
      T('headRot', [0, 0], [0.7, -9, 'io'], [3.4, -9]),
      T('gazeX', [0, 0], [0.7, -0.5, 'io'], [3.4, -0.5]),
      T('gazeY', [0, 0], [0.7, 0.6, 'io'], [3.4, 0.6]),
      hold('eyeL', 0.6, 99, EYE.half),
      hold('eyeR', 0.6, 99, EYE.half),
      hold('mouth', 0.6, 99, MOUTH.pout),
      hold('brow', 0.6, 99, BROW.soft),
      T('fxQuestion', [0, 0], [1.1, 0], [1.6, 0.8, 'o']),
    ],
  },
  {
    id: 'explain',
    label: 'ui.cli-monitor.explain',
    category: 'think',
    dur: 2.6,
    trigger: '长回答 / 讲解步骤（竖起食指）', // i18n-ignore
    tracks: [
      ...arm('r', HAND.point, P.point.r, 0.45, 2.2, 2.6, { oscA: [2, 1.4, 0], win: [0.8, 2.2] }),
      T('headRot', [0, 0], [0.5, 5, 'io'], [2.2, 5], [2.6, 0]),
      pulse('headNod', 0.5, 0.8, 2.4, -3),
      hold('mouth', 0.4, 2.3, MOUTH.smile),
      hold('brow', 0.5, 2.3, BROW.up),
    ],
  },
  {
    id: 'eureka',
    label: 'ui.cli-monitor.eureka',
    category: 'think',
    dur: 2.2,
    trigger: '想到办法 / 找到答案', // i18n-ignore
    tracks: [
      ...arm('r', HAND.point, [10, 168, 0], 0.3, 1.8, 2.2),
      T('headNod', [0, 0], [0.2, -8, 'o'], [0.6, 0, 'io'], [2.2, 0]),
      hold('eyeL', 0.15, 1.7, EYE.wide),
      hold('eyeR', 0.15, 1.7, EYE.wide),
      hold('mouth', 0.2, 1.7, MOUTH.open),
      hold('brow', 0.15, 1.7, BROW.up),
      T('fxExclaim', [0, 0], [0.2, 1, 'b'], [1.7, 1], [2.1, 0]),
      T('fxSparkle', [0, 0], [0.25, 1, 'o'], [1.7, 0.8], [2.2, 0]),
    ],
  },
  {
    id: 'puzzled',
    label: 'ui.cli-monitor.puzzled-head-tilt',
    category: 'think',
    dur: 2.4,
    trigger: '听不懂 / 需要澄清', // i18n-ignore
    tracks: [
      T('headRot', [0, 0], [0.4, 14, 'b'], [2.0, 14], [2.4, 0]),
      T('torsoRot', [0, 0], [0.5, 1.5], [2.0, 1.5], [2.4, 0]),
      T('gazeX', [0, 0], [0.4, 0.4, 'io'], [2.0, 0.4], [2.4, 0]),
      T('gazeY', [0, 0], [0.4, 0.5], [2.0, 0.5], [2.4, 0]),
      hold('eyeL', 0.3, 2.1, EYE.wide),
      hold('mouth', 0.3, 2.1, MOUTH.wavy),
      hold('brow', 0.3, 2.1, BROW.worried),
      T('fxQuestion', [0, 0], [0.5, 1, 'o'], [2.0, 1], [2.4, 0]),
    ],
  },
  {
    id: 'look_around',
    label: 'ui.voice-mascot.look-around',
    category: 'idle',
    dur: 3.0,
    cooldown: 20,
    idle: true,
    priority: 0,
    trigger: '空闲随机 / 等待用户（手遮额头远眺）', // i18n-ignore
    tracks: [
      ...arm('r', HAND.rest, [44, 178, -10], 0.5, 2.5, 3.0, { ease: 'io' }),
      T('headRot', [0, 0], [0.6, -8, 'io'], [1.4, -8], [1.9, 8, 'io'], [2.5, 8], [3.0, 0]),
      T('headX', [0, 0], [0.6, -8, 'io'], [1.4, -8], [1.9, 8, 'io'], [2.5, 8], [3.0, 0]),
      T('gazeX', [0, 0], [0.6, -0.8, 'io'], [1.4, -0.8], [1.9, 0.8, 'io'], [2.5, 0.8], [3.0, 0]),
      hold('eyeL', 0.4, 2.7, EYE.wide),
      hold('eyeR', 0.4, 2.7, EYE.wide),
    ],
  },
  {
    id: 'look_lr',
    label: 'ui.cli-monitor.look-left-and-right',
    category: 'idle',
    dur: 2.6,
    cooldown: 15,
    idle: true,
    priority: 0,
    trigger: '空闲随机', // i18n-ignore
    tracks: [
      T(
        'headRot',
        [0, 0],
        [0.5, -10, 'io'],
        [1.1, -10],
        [1.4, 11, 'io'],
        [2.0, 11],
        [2.6, 0, 'io'],
      ),
      T('torsoX', [0, 0], [0.5, -6, 'io'], [1.1, -6], [1.4, 6, 'io'], [2.0, 6], [2.6, 0, 'io']),
      T('gazeX', [0, 0], [0.45, -0.9, 'io'], [1.1, -0.9], [1.35, 0.9, 'io'], [2.0, 0.9], [2.6, 0]),
      hold('mouth', 0.2, 2.3, MOUTH.o),
    ],
  },
  {
    id: 'peek',
    label: 'ui.cli-monitor.peek',
    category: 'emotion',
    dur: 2.6,
    cooldown: 25,
    idle: true,
    priority: 0,
    trigger: '空闲随机（害羞地偷看用户）', // i18n-ignore
    tracks: [
      ...both(HAND.rest, P.cheeks.r, P.cheeks.l, 0.45, 2.2, 2.6, { ease: 'io' }),
      hold('armFront', 0.3, 99, 1),
      T('headRot', [0, 0], [0.5, 6], [2.2, 6], [2.6, 0]),
      T('gazeX', [0, 0], [0.6, 0.7, 'io'], [1.6, 0.7], [2.0, 0.3], [2.6, 0]),
      hold('eyeL', 0.3, 2.3, EYE.wide),
      hold('eyeR', 0.3, 2.3, EYE.wide),
      T('blush', [0, 0], [0.5, 1, 'o'], [2.2, 1], [2.6, 0]),
      hold('mouth', 0.4, 2.2, MOUTH.cat),
    ],
  },
  // ---- emotion --------------------------------------------------------------------------------
  {
    id: 'heart',
    label: 'ui.cli-monitor.heart-gesture',
    category: 'emotion',
    dur: 2.6,
    trigger: '表达喜欢 / 被夸奖 / 摸头', // i18n-ignore
    tracks: [
      ...arm('r', HAND.rest, P.heart.r, 0.45, 2.1, 2.6, {
        oscW: [5, 1.8, 0],
        win: [0.6, 2.0],
      }),
      T('headRot', [0, 0], [0.5, 8, 'b'], [2.1, 8], [2.6, 0]),
      hold('eyeL', 0.3, 2.3, EYE.happy),
      hold('eyeR', 0.3, 2.3, EYE.happy),
      hold('mouth', 0.3, 2.3, MOUTH.smile),
      T('blush', [0, 0], [0.5, 1, 'o'], [2.2, 0.8], [2.6, 0]),
      T('fxHeart', [0, 0], [0.5, 1, 'o'], [2.1, 1], [2.6, 0]),
    ],
  },
  {
    id: 'blow_kiss',
    label: 'ui.cli-monitor.blow-a-kiss',
    category: 'emotion',
    dur: 2.4,
    trigger: '告别 / 感谢', // i18n-ignore
    tracks: [
      T('rOn', [0, 1]),
      T('rHand', [0, HAND.rest]),
      T('rA', [0, 0], [0.3, -8], [0.9, -8], [1.3, 30, 'b'], [2.4, 30]),
      T('rE', [0, 0], [0.3, 210], [0.9, 210], [1.3, 165, 'b'], [2.4, 165]),
      hold('armFront', 0.2, 99, 1),
      T('headRot', [0, 0], [0.6, 9, 'o'], [2.0, 9], [2.4, 0]),
      hold('eyeL', 0.3, 2.0, EYE.happy),
      hold('eyeR', 0.5, 2.0, EYE.closed),
      // one step track: two separate tracks on the same discrete param tie on weight and the later
      // track's 0 (before its own start) would override the pout phase
      T(
        'mouth',
        [0, MOUTH.auto],
        [0.3, MOUTH.pout, 's'],
        [1.2, MOUTH.smile, 's'],
        [2.0, MOUTH.auto, 's'],
      ),
      T('fxHeart', [0, 0], [1.2, 0], [1.5, 1, 'o'], [2.1, 1], [2.4, 0]),
    ],
  },
  {
    id: 'shy',
    label: 'ui.mascot-theme.shy',
    category: 'emotion',
    dur: 2.8,
    trigger: '被夸奖 / 被摸头太久', // i18n-ignore
    tracks: [
      ...both(HAND.rest, P.cheeks.r, P.cheeks.l, 0.5, 2.3, 2.8, { ease: 'io' }),
      hold('armFront', 0.3, 99, 1),
      T('headRot', [0, 0], [0.6, -8, 'io'], [2.3, -8], [2.8, 0]),
      T('headNod', [0, 0], [0.6, 6, 'io'], [2.3, 6], [2.8, 0]),
      T('gazeX', [0, 0], [0.6, 0.5], [2.3, 0.5], [2.8, 0]),
      T('gazeY', [0, 0], [0.6, 0.5], [2.3, 0.5], [2.8, 0]),
      hold('eyeL', 0.4, 2.4, EYE.half),
      hold('eyeR', 0.4, 2.4, EYE.half),
      hold('mouth', 0.4, 2.4, MOUTH.wavy),
      hold('brow', 0.4, 2.4, BROW.worried),
      T('blush', [0, 0], [0.5, 1, 'o'], [2.4, 1], [2.8, 0]),
      T('fxBlush', [0, 0], [0.5, 1, 'o'], [2.4, 1], [2.8, 0]),
    ],
  },
  {
    id: 'cover_face',
    label: 'ui.cli-monitor.cover-face',
    category: 'emotion',
    dur: 2.6,
    trigger: '尴尬 / 出错后的不好意思', // i18n-ignore
    tracks: [
      ...both(HAND.rest, P.cheeks.r, P.cheeks.l, 0.4, 2.2, 2.6, { ease: 'io' }),
      hold('armFront', 0.25, 99, 1),
      T('headNod', [0, 0], [0.5, 10, 'io'], [2.2, 10], [2.6, 0]),
      hold('eyeL', 0.3, 2.3, EYE.closed),
      hold('eyeR', 0.3, 2.3, EYE.closed),
      hold('mouth', 0.3, 2.3, MOUTH.wavy),
      T('fxBlush', [0, 0], [0.5, 1, 'o'], [2.3, 1], [2.6, 0]),
      T('fxSweat', [0, 0], [0.6, 0.8], [2.3, 0.8], [2.6, 0]),
    ],
  },
  {
    id: 'sorry',
    label: 'ui.cli-monitor.apologise',
    category: 'emotion',
    dur: 2.8,
    priority: 3,
    trigger: '任务失败 / 出错（双手交叠在身前，轻轻低头）', // i18n-ignore
    tracks: [
      ...both(HAND.rest, P.type.r, P.type.l, 0.45, 2.3, 2.8, { ease: 'io' }),
      hold('armFront', 0.3, 99, 1),
      T('headNod', [0, 0], [0.55, 14, 'io'], [2.3, 14], [2.8, 0]),
      T('bodyY', [0, 0], [0.55, 4, 'io'], [2.3, 4], [2.8, 0]),
      hold('eyeL', 0.4, 2.4, EYE.sad),
      hold('eyeR', 0.4, 2.4, EYE.sad),
      hold('brow', 0.4, 2.4, BROW.worried),
      hold('mouth', 0.4, 2.4, MOUTH.frown),
      T('fxSweat', [0, 0], [0.7, 1], [2.3, 1], [2.8, 0]),
    ],
  },
  {
    id: 'surprise',
    label: 'ui.cli-monitor.surprised',
    category: 'react',
    dur: 1.8,
    priority: 2,
    trigger: '拖入文件 / 突然的事件', // i18n-ignore
    tracks: [
      ...both(HAND.wave, P.surprise.r, P.surprise.l, 0.2, 1.4, 1.8),
      T('bodyY', [0, 0], [0.12, -8, 'o'], [0.5, 0, 'io'], [1.8, 0]),
      T('headNod', [0, 0], [0.12, -10, 'o'], [0.6, 0], [1.8, 0]),
      T('scale', [0, 0], [0.12, -0.02, 'o'], [0.5, 0], [1.8, 0]),
      hold('eyeL', 0.05, 1.5, EYE.wide),
      hold('eyeR', 0.05, 1.5, EYE.wide),
      hold('mouth', 0.05, 1.5, MOUTH.o),
      hold('brow', 0.05, 1.5, BROW.up),
      T('fxExclaim', [0, 0], [0.12, 1, 'b'], [1.3, 1], [1.8, 0]),
    ],
  },
  {
    id: 'sigh',
    label: 'ui.cli-monitor.sigh',
    category: 'emotion',
    dur: 3.0,
    trigger: '长时间失败 / 无聊', // i18n-ignore
    tracks: [
      ...arm('r', HAND.chest, P.chest.r, 0.6, 2.5, 3.0, { ease: 'io' }),
      hold('armFront', 0.4, 99, 1),
      T('headNod', [0, 0], [0.8, 8, 'io'], [2.0, 12, 'io'], [3.0, 0]),
      T('shoulder', [0, 0], [0.6, -6, 'o'], [1.6, 4, 'io'], [3.0, 0]),
      hold('eyeL', 0.6, 2.6, EYE.half),
      hold('eyeR', 0.6, 2.6, EYE.half),
      hold('mouth', 0.6, 2.6, MOUTH.o),
      hold('brow', 0.5, 2.6, BROW.worried),
      T('fxGloom', [0, 0], [0.9, 0.9], [2.5, 0.9], [3.0, 0]),
    ],
  },
  {
    id: 'smug',
    label: 'ui.cli-monitor.smug',
    category: 'emotion',
    dur: 2.4,
    trigger: '做对难题 / 任务一次成功', // i18n-ignore
    tracks: [
      ...arm('r', HAND.thumbsup, P.thumb.r, 0.4, 2.0, 2.4),
      T('headNod', [0, 0], [0.4, -8, 'io'], [2.0, -8], [2.4, 0]),
      T('headRot', [0, 0], [0.4, -6], [2.0, -6], [2.4, 0]),
      hold('eyeL', 0.3, 2.1, EYE.half),
      hold('eyeR', 0.3, 2.1, EYE.half),
      hold('mouth', 0.3, 2.1, MOUTH.cat),
      hold('brow', 0.3, 2.1, BROW.up),
      T('fxSparkle', [0, 0], [0.5, 0.8], [2.0, 0.8], [2.4, 0]),
    ],
  },
  {
    id: 'aggrieved',
    label: 'ui.cli-monitor.aggrieved',
    category: 'emotion',
    dur: 3.0,
    trigger: '被批评 / 反复失败', // i18n-ignore
    tracks: [
      ...both(HAND.fist, P.cheeks.r, P.cheeks.l, 0.5, 2.5, 3.0, { ease: 'io' }),
      hold('armFront', 0.3, 99, 1),
      T('headNod', [0, 0], [0.6, 9, 'io'], [2.5, 9], [3.0, 0]),
      T('headRot', [0, 0], [0.6, 5], [2.5, 5], [3.0, 0]),
      hold('eyeL', 0.4, 2.6, EYE.sad),
      hold('eyeR', 0.4, 2.6, EYE.sad),
      hold('mouth', 0.4, 2.6, MOUTH.frown),
      hold('brow', 0.4, 2.6, BROW.worried),
      T('fxTear', [0, 0], [0.8, 1], [2.6, 1], [3.0, 0]),
      T('blush', [0, 0], [0.6, 0.6], [2.6, 0.6], [3.0, 0]),
    ],
  },
  {
    id: 'tears',
    label: 'ui.cli-monitor.tears',
    category: 'emotion',
    dur: 3.0,
    trigger: '感动 / 很难过', // i18n-ignore
    tracks: [
      T('headNod', [0, 0], [0.6, 7, 'io'], [2.5, 7], [3.0, 0]),
      hold('eyeL', 0.3, 2.7, EYE.sad),
      hold('eyeR', 0.3, 2.7, EYE.sad),
      hold('mouth', 0.3, 2.7, MOUTH.wavy),
      hold('brow', 0.3, 2.7, BROW.worried),
      T('fxTear', [0, 0], [0.5, 1], [2.6, 1], [3.0, 0]),
    ],
  },
  {
    id: 'angry',
    label: 'ui.cli-monitor.annoyed-mild',
    category: 'emotion',
    dur: 2.2,
    trigger: '被打断 / 连续失败', // i18n-ignore
    tracks: [
      T('torsoX', [0, 0], [0.1, 3], [0.2, -3], [0.3, 2], [0.4, -2], [0.5, 0], [2.2, 0]),
      T('headNod', [0, 0], [0.4, 5, 'o'], [1.9, 5], [2.2, 0]),
      hold('eyeL', 0.15, 2.0, EYE.determined),
      hold('eyeR', 0.15, 2.0, EYE.determined),
      hold('mouth', 0.15, 2.0, MOUTH.pout),
      hold('brow', 0.15, 2.0, BROW.angry),
      T('fxAnger', [0, 0], [0.25, 1, 'b'], [1.9, 1], [2.2, 0]),
      T('blush', [0, 0], [0.4, 0.6], [1.9, 0.6], [2.2, 0]),
    ],
  },
  {
    id: 'cold_sweat',
    label: 'ui.cli-monitor.cold-sweat',
    category: 'emotion',
    dur: 2.4,
    trigger: '紧张 / 尴尬 / 超时', // i18n-ignore
    tracks: [
      T('headRot', [0, 0], [0.4, -5], [2.0, -5], [2.4, 0]),
      hold('eyeL', 0.2, 2.1, EYE.wide),
      hold('eyeR', 0.2, 2.1, EYE.wide),
      hold('mouth', 0.2, 2.1, MOUTH.wavy),
      hold('brow', 0.2, 2.1, BROW.worried),
      T('fxSweat', [0, 0], [0.3, 1], [2.1, 1], [2.4, 0]),
      T('fxGloom', [0, 0], [0.5, 0.6], [2.0, 0.6], [2.4, 0]),
    ],
  },
  {
    id: 'daze',
    label: 'ui.cli-monitor.daze',
    category: 'idle',
    dur: 3.4,
    cooldown: 40,
    idle: true,
    priority: 0,
    trigger: '空闲随机', // i18n-ignore
    tracks: [
      T('headNod', [0, 0], [0.8, 4, 'io'], [3.0, 4], [3.4, 0]),
      T('gazeX', [0, 0], [0.8, 0.2], [3.0, 0.2], [3.4, 0]),
      T('gazeY', [0, 0], [0.8, 0.3], [3.0, 0.3], [3.4, 0]),
      hold('eyeL', 0.5, 3.0, EYE.half),
      hold('eyeR', 0.5, 3.0, EYE.half),
      hold('mouth', 0.6, 3.0, MOUTH.o),
    ],
  },
  // ---- celebrate ------------------------------------------------------------------------------
  {
    id: 'cheer',
    label: 'ui.cli-monitor.cheer-fist-pump',
    category: 'celebrate',
    dur: 2.2,
    trigger: '鼓励用户 / 开始新任务', // i18n-ignore
    tracks: [
      ...arm('r', HAND.fist, P.fistUp.r, 0.3, 1.8, 2.2, { oscA: [3, 3, 0], win: [0.5, 1.8] }),
      T('bodyY', [0, 0], [0.25, 3, 'io'], [0.4, -6, 'o'], [0.7, 0, 'io'], [2.2, 0]),
      T('headRot', [0, 0], [0.45, 5, 'io'], [1.75, 5], [2.2, 0, 'io']),
      hold('eyeL', 0.2, 1.9, EYE.determined),
      hold('eyeR', 0.2, 1.9, EYE.determined),
      hold('mouth', 0.2, 1.9, MOUTH.grin),
      hold('brow', 0.2, 1.9, BROW.up),
      T('fxSparkle', [0, 0], [0.5, 0.7], [1.8, 0.7], [2.2, 0]),
    ],
  },
  {
    id: 'thumbs_up',
    label: 'ui.cli-monitor.thumbs-up',
    category: 'celebrate',
    dur: 2.2,
    priority: 3,
    trigger: '任务完成 / 用户做得好', // i18n-ignore
    tracks: [
      ...arm('r', HAND.thumbsup, P.thumb.r, 0.35, 1.8, 2.2),
      T('bodyY', [0, 0], [0.35, -4, 'o'], [0.7, 0, 'io'], [2.2, 0]),
      T('headRot', [0, 0], [0.4, 5], [1.8, 5], [2.2, 0]),
      hold('eyeL', 0.3, 1.9, EYE.happy),
      hold('eyeR', 0.3, 1.9, EYE.happy),
      hold('mouth', 0.3, 1.9, MOUTH.grin),
      T('fxSparkle', [0, 0], [0.5, 0.9], [1.8, 0.9], [2.2, 0]),
    ],
  },
  {
    id: 'peace',
    label: 'ui.cli-monitor.peace-sign',
    category: 'celebrate',
    dur: 2.2,
    trigger: '拍照 / 自拍 / 开心', // i18n-ignore
    tracks: [
      ...arm('r', HAND.peace, P.peaceUp.r, 0.35, 1.8, 2.2),
      T('headRot', [0, 0], [0.4, -8, 'b'], [1.8, -8], [2.2, 0]),
      hold('eyeL', 0.3, 1.9, EYE.happy),
      hold('eyeR', 0.5, 1.9, EYE.closed),
      hold('mouth', 0.3, 1.9, MOUTH.tongue),
      T('fxSparkle', [0, 0], [0.5, 1], [1.8, 1], [2.2, 0]),
    ],
  },
  {
    id: 'celebrate',
    label: 'ui.cli-monitor.celebrate-hands-up',
    category: 'celebrate',
    dur: 2.6,
    priority: 3,
    trigger: '任务全部完成 / 里程碑', // i18n-ignore
    tracks: [
      ...both(HAND.wave, P.waveUp.r, P.waveUp.l, 0.3, 2.2, 2.6, {
        oscW: [10, 3.2, 0],
        win: [0.6, 2.2],
      }),
      T(
        'bodyY',
        [0, 0],
        [0.22, 3, 'io'],
        [0.42, -9, 'o'],
        [0.68, 1.5, 'io'],
        [0.95, -8, 'o'],
        [1.25, 0.8, 'io'],
        [1.55, -6, 'o'],
        [1.85, 0, 'io'],
        [2.6, 0],
      ),
      hold('eyeL', 0.2, 2.3, EYE.happy),
      hold('eyeR', 0.2, 2.3, EYE.happy),
      hold('mouth', 0.2, 2.3, MOUTH.grin),
      T('fxStar', [0, 0], [0.3, 1], [2.2, 1], [2.6, 0]),
      T('fxSparkle', [0, 0], [0.3, 1], [2.2, 1], [2.6, 0]),
    ],
  },
  {
    id: 'clap',
    label: 'ui.cli-monitor.clap',
    category: 'celebrate',
    dur: 2.4,
    trigger: '夸奖 / 用户完成目标', // i18n-ignore
    tracks: [
      ...arm('r', HAND.rest, P.clap.r, 0.35, 2.0, 2.4, {
        ease: 'io',
        oscE: [7, 3.6, 0],
        oscW: [8, 3.6, 0.2],
        win: [0.5, 2.0],
      }),
      ...arm('l', HAND.rest, P.clap.l, 0.35, 2.0, 2.4, {
        ease: 'io',
        oscE: [7, 3.6, Math.PI],
        oscW: [8, 3.6, Math.PI + 0.2],
        win: [0.5, 2.0],
      }),
      hold('armFront', 0.25, 99, 1),
      T(
        'bodyY',
        [0, 0],
        [0.5, -2, 'io'],
        [0.75, 1, 'io'],
        [1.0, -2, 'io'],
        [1.25, 1, 'io'],
        [1.5, -2, 'io'],
        [1.75, 0, 'io'],
        [2.4, 0],
      ),
      hold('eyeL', 0.2, 2.1, EYE.happy),
      hold('eyeR', 0.2, 2.1, EYE.happy),
      hold('mouth', 0.2, 2.1, MOUTH.smile),
      T('fxSparkle', [0, 0], [0.5, 0.7], [2.0, 0.7], [2.4, 0]),
    ],
  },
  {
    id: 'hop',
    label: 'ui.cli-monitor.happy-bounce',
    category: 'celebrate',
    dur: 1.6,
    trigger: '被点击 / 高兴', // i18n-ignore
    tracks: [
      T(
        'bodyY',
        [0, 0],
        [0.12, 3, 'io'],
        [0.32, -12, 'o'],
        [0.52, 1.5, 'io'],
        [0.72, -8, 'o'],
        [0.95, 0.8, 'io'],
        [1.15, -3, 'o'],
        [1.35, 0, 'io'],
        [1.6, 0],
      ),
      T('shoulder', [0, 0], [0.28, -6, 'o'], [0.6, 0], [1.6, 0]),
      T('headRot', [0, 0], [0.3, 5], [0.7, -5], [1.1, 3], [1.5, 0]),
      hold('eyeL', 0.1, 1.4, EYE.happy),
      hold('eyeR', 0.1, 1.4, EYE.happy),
      hold('mouth', 0.1, 1.4, MOUTH.grin),
      T('fxHeart', [0, 0], [0.3, 0.7], [1.3, 0.7], [1.6, 0]),
    ],
  },
  {
    id: 'wink',
    label: 'ui.cli-monitor.wink',
    category: 'emotion',
    dur: 1.6,
    trigger: '俏皮 / 彩蛋', // i18n-ignore
    tracks: [
      T('headRot', [0, 0], [0.3, 8, 'b'], [1.3, 8], [1.6, 0]),
      hold('eyeR', 0.15, 1.2, EYE.happy),
      hold('mouth', 0.15, 1.3, MOUTH.cat),
      T('fxSparkle', [0, 0], [0.25, 1, 'o'], [1.2, 0.8], [1.6, 0]),
    ],
  },
  {
    id: 'tongue',
    label: 'ui.cli-monitor.stick-out-tongue',
    category: 'emotion',
    dur: 1.8,
    trigger: '调皮 / 小失误后的卖萌', // i18n-ignore
    tracks: [
      T('headRot', [0, 0], [0.3, -9, 'b'], [1.5, -9], [1.8, 0]),
      hold('eyeL', 0.15, 1.5, EYE.happy),
      hold('eyeR', 0.15, 1.5, EYE.closed),
      hold('mouth', 0.15, 1.5, MOUTH.tongue),
      T('blush', [0, 0], [0.3, 0.8], [1.5, 0.8], [1.8, 0]),
    ],
  },
  {
    id: 'cute',
    label: 'ui.cli-monitor.act-cute',
    category: 'emotion',
    dur: 2.4,
    trigger: '被摸头 / 撒娇', // i18n-ignore
    tracks: [
      ...both(HAND.fist, P.cheeks.r, P.cheeks.l, 0.4, 2.0, 2.4, { ease: 'io' }),
      hold('armFront', 0.25, 99, 1),
      T('headRot', [0, 0], [0.4, 10, 'b'], [1.2, -8, 'io'], [2.0, 10, 'io'], [2.4, 0]),
      hold('eyeL', 0.2, 2.1, EYE.happy),
      hold('eyeR', 0.2, 2.1, EYE.happy),
      hold('mouth', 0.2, 2.1, MOUTH.cat),
      T('fxBlush', [0, 0], [0.4, 1], [2.1, 1], [2.4, 0]),
      T('fxHeart', [0, 0], [0.5, 0.6], [2.0, 0.6], [2.4, 0]),
    ],
  },
  // ---- work / rest ----------------------------------------------------------------------------
  {
    id: 'work',
    label: 'ui.cli-monitor.typing-at-work',
    category: 'work',
    dur: 2.4,
    hold: true,
    maxHold: 15,
    loopFrom: 1.0,
    priority: 1,
    trigger: '工具运行中 / 正在写代码', // i18n-ignore
    tracks: [
      ...both(HAND.rest, P.type.r, P.type.l, 0.5, 2.4, 2.4, {
        ease: 'io',
        oscW: [8, 4.2, 0],
        oscE: [3, 5.1, 1],
        win: [0.6, 99],
      }),
      hold('armFront', 0.3, 99, 1),
      T('headNod', [0, 0], [0.6, 6, 'io'], [2.4, 6]),
      T('gazeY', [0, 0], [0.6, 0.5], [2.4, 0.5]),
      hold('eyeL', 0.4, 99, EYE.determined),
      hold('eyeR', 0.4, 99, EYE.determined),
      hold('mouth', 0.4, 99, MOUTH.pout),
    ],
  },
  {
    id: 'yawn',
    label: 'ui.cli-monitor.yawn',
    category: 'rest',
    dur: 3.0,
    cooldown: 60,
    idle: true,
    priority: 0,
    trigger: '夜间 / 长时间空闲', // i18n-ignore
    tracks: [
      T('headNod', [0, 0], [0.8, -10, 'io'], [1.6, -10], [2.4, 6, 'io'], [3.0, 0]),
      T('shoulder', [0, 0], [0.8, -9, 'io'], [1.8, -9], [2.6, 0]),
      hold('eyeL', 0.5, 2.5, EYE.closed),
      hold('eyeR', 0.5, 2.5, EYE.closed),
      hold('mouth', 0.7, 2.2, MOUTH.yawn),
      T('fxSweat', [0, 0], [3.0, 0]),
    ],
  },
  {
    id: 'stretch',
    label: 'ui.voice-mascot.stretch',
    category: 'rest',
    dur: 3.2,
    cooldown: 60,
    idle: true,
    priority: 0,
    trigger: '长时间空闲 / 久坐提醒', // i18n-ignore
    tracks: [
      ...both(HAND.rest, P.stretch.r, P.stretch.l, 0.9, 2.3, 3.2, { ease: 'io' }),
      T('bodyY', [0, 0], [0.9, 4], [1.6, -6, 'io'], [2.3, -6], [3.2, 0]),
      T('headNod', [0, 0], [0.9, -9, 'io'], [2.3, -9], [3.2, 0]),
      hold('eyeL', 0.7, 2.6, EYE.closed),
      hold('eyeR', 0.7, 2.6, EYE.closed),
      hold('mouth', 0.8, 2.5, MOUTH.yawn),
    ],
  },
  {
    id: 'goodnight',
    label: 'ui.cli-monitor.good-night',
    category: 'rest',
    dur: 3.4,
    hold: true,
    maxHold: 25,
    loopFrom: 1.8,
    priority: 1,
    trigger: '深夜 / 长时间无操作 / 说晚安', // i18n-ignore
    tracks: [
      ...arm('r', HAND.wave, [20, 160, 0], 0.5, 1.8, 3.4, {
        oscW: [10, 2.2, 0],
        win: [0.8, 1.8],
        ret: false,
      }),
      T('headNod', [0, 0], [1.4, 12, 'io'], [3.4, 12]),
      T('headRot', [0, 0], [1.4, 6], [3.4, 6]),
      T('bodyY', [0, 0], [1.4, 3], [3.4, 3]),
      hold('eyeL', 1.0, 99, EYE.sleepy),
      hold('eyeR', 1.0, 99, EYE.sleepy),
      hold('mouth', 0.4, 99, MOUTH.smile),
      T('fxZzz', [0, 0], [1.6, 0], [2.2, 1, 'o']),
    ],
  },
  {
    id: 'listen',
    label: 'ui.cli-monitor.listen',
    category: 'think',
    dur: 2.6,
    hold: true,
    maxHold: 20,
    loopFrom: 1.0,
    priority: 1,
    trigger: '用户正在输入 / 语音录入', // i18n-ignore
    tracks: [
      T('headRot', [0, 0], [0.6, 6, 'io'], [2.6, 6]),
      T('headNod', [0, 0], [0.6, -2, 'io'], [2.6, -2]),
      hold('eyeL', 0.3, 99, EYE.wide),
      hold('eyeR', 0.3, 99, EYE.wide),
      hold('mouth', 0.3, 99, MOUTH.smile),
      hold('brow', 0.3, 99, BROW.up),
    ],
  },
  {
    id: 'peek_note',
    label: 'ui.cli-monitor.humming',
    category: 'idle',
    dur: 3.0,
    cooldown: 40,
    idle: true,
    priority: 0,
    trigger: '空闲随机 / 播放音乐', // i18n-ignore
    tracks: [
      T('headRot', [0, 0], [0.5, 6], [1.0, -6], [1.5, 6], [2.0, -6], [2.5, 4], [3.0, 0]),
      T('torsoRot', [0, 0], [0.5, 1.2], [1.0, -1.2], [1.5, 1.2], [2.0, -1.2], [3.0, 0]),
      hold('eyeL', 0.3, 2.7, EYE.happy),
      hold('eyeR', 0.3, 2.7, EYE.happy),
      hold('mouth', 0.3, 2.7, MOUTH.smile),
      T('fxNote', [0, 0], [0.4, 1], [2.6, 1], [3.0, 0]),
    ],
  },
];

/** id → Chinese label (menu) */
export const ACTION_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  ACTIONS.map((a) => [a.id, a.label]),
);
