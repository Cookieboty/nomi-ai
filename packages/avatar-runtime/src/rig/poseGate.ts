/**
 * 「这一帧画不画」：和上次画出来的姿势比，变化都小于约 1/4 个设备像素（或 1/255 的透明度）时
 * 不重画——静止 / 慢呼吸时省掉大部分 paint。比较的是上次**画出**的姿势，慢动作会累积到阈值再画，
 * 不会漂移。阈值按 rig → 设备像素的缩放换算（窗口 / 缩放变了也会触发重画，见 extraKey）。
 */
import type { EyeMix, RigPose } from '../layeredRig';

import { IDX } from './params';

/** rig 像素位移类 */
const PX_KEYS = [
  'bodyY',
  'torsoX',
  'shoulderL',
  'shoulderR',
  'headX',
  'headY',
  'featX',
  'featY',
] as const satisfies readonly (keyof RigPose)[];
/** 弧度 */
const ROT_KEYS = [
  'torsoRot',
  'armRotL',
  'armRotR',
  'badgeRot',
  'strapRot',
  'headRot',
  'hairRotL',
  'hairRotR',
  'ribbonRot',
] as const satisfies readonly (keyof RigPose)[];
/** 缩放 */
const SCALE_KEYS = [
  'bodyScaleY',
  'figureScale',
  'eyeScale',
  'mouthWidth',
] as const satisfies readonly (keyof RigPose)[];
/** 0..1 的混合量 / 透明度（iris 是 -1..1，乘虹膜半径，也按这个精度） */
const UNIT_KEYS = [
  'irisX',
  'irisY',
  'eyeOpen',
  'lidClose',
  'happy',
  'lidAlpha',
  'mouthOpen',
  'blush',
  'angerMark',
  'sweat',
  'browRaise',
  'cheekSquash',
] as const satisfies readonly (keyof RigPose)[];
const EYE_KEYS = [
  'cl',
  'happy',
  'slope',
  'scale',
  'lidAlpha',
] as const satisfies readonly (keyof EyeMix)[];

const UNIT_EPS = 1 / 255;
const SCALE_EPS = 0.0005;
const PARAM_EPS = 0.0005;
/** 旋转阈值按约 300 rig px 的力臂换算 */
const LEVER_PX = 300;
/** 允许的最大偏差（设备像素） */
const DEVICE_PX_EPS = 0.25;

const FX_IDX = Object.entries(IDX)
  .filter(([name]) => name.startsWith('fx'))
  .map(([, i]) => i);

const LEN = PX_KEYS.length + ROT_KEYS.length + SCALE_KEYS.length + UNIT_KEYS.length + 4 + 10 + 3;

function fill(out: Float64Array, pose: RigPose): void {
  let i = 0;
  for (const k of PX_KEYS) out[i++] = pose[k];
  for (const k of ROT_KEYS) out[i++] = pose[k];
  for (const k of SCALE_KEYS) out[i++] = pose[k];
  for (const k of UNIT_KEYS) out[i++] = pose[k];
  out[i++] = pose.tint.r;
  out[i++] = pose.tint.g;
  out[i++] = pose.tint.b;
  out[i++] = pose.tint.a;
  for (const e of [pose.eyeL, pose.eyeR]) for (const k of EYE_KEYS) out[i++] = e ? e[k] : NaN;
  out[i++] = pose.browAlpha ?? NaN;
  out[i++] = pose.browKind ?? NaN;
  out[i] = pose.time ?? 0;
}

/** 有特效在画（心、星、汗滴…随 pose.time 动）：时间一变就得重画 */
function fxActive(pose: RigPose): boolean {
  const v = pose.ext?.v;
  if (!v || pose.reduced) return false;
  for (const i of FX_IDX) if (v[i] > 0.02) return true;
  return false;
}

const differs = (a: number, b: number, eps: number) =>
  Number.isNaN(a) || Number.isNaN(b)
    ? !(Number.isNaN(a) && Number.isNaN(b))
    : Math.abs(a - b) > eps;

export class PoseGate {
  private readonly last = new Float64Array(LEN);
  private readonly cur = new Float64Array(LEN);
  private lastExt: Float32Array | null = null;
  private lastKey: string | null = null;
  private lastEye = '';
  private lastMouth = '';
  private lastReduced = false;

  /** 下一帧一定重画（画布被清空 / 换角色时） */
  invalidate(): void {
    this.lastKey = null;
  }

  /**
   * 跟上次画出的姿势比，要不要重画；要画时把它记为「上次画出的」。
   * deviceScale = rig 像素 → 设备像素（rigTransform 的 sc × dpr）；
   * extraKey = 画布尺寸、像素比、视口等任何一变就必须重画的东西。
   */
  shouldPaint(pose: RigPose, deviceScale: number, extraKey: string): boolean {
    const extraChanged = this.lastKey === null || extraKey !== this.lastKey;
    fill(this.cur, pose);
    const changed = extraChanged || this.poseChanged(pose, deviceScale);
    if (!changed) return false;
    this.last.set(this.cur);
    const v = pose.ext?.v;
    if (v) {
      if (!this.lastExt || this.lastExt.length !== v.length)
        this.lastExt = new Float32Array(v.length);
      this.lastExt.set(v);
    } else this.lastExt = null;
    this.lastKey = extraKey;
    this.lastEye = pose.eyeVariant;
    this.lastMouth = pose.mouthVariant;
    this.lastReduced = !!pose.reduced;
    return true;
  }

  private poseChanged(pose: RigPose, deviceScale: number): boolean {
    const a = this.cur;
    const b = this.last;
    const pxEps = DEVICE_PX_EPS / Math.max(1e-3, deviceScale);
    const rotEps = pxEps / LEVER_PX;
    let i = 0;
    for (let n = 0; n < PX_KEYS.length; n++, i++) if (differs(a[i], b[i], pxEps)) return true;
    for (let n = 0; n < ROT_KEYS.length; n++, i++) if (differs(a[i], b[i], rotEps)) return true;
    for (let n = 0; n < SCALE_KEYS.length; n++, i++)
      if (differs(a[i], b[i], SCALE_EPS)) return true;
    for (let n = 0; n < UNIT_KEYS.length; n++, i++) if (differs(a[i], b[i], UNIT_EPS)) return true;
    // tint：rgb 画的时候取整，按 1/4 级比；a 按透明度精度
    for (let n = 0; n < 3; n++, i++) if (differs(a[i], b[i], 0.25)) return true;
    if (differs(a[i], b[i], UNIT_EPS / 4)) return true;
    i++;
    for (let n = 0; n < 10; n++, i++) {
      const eps = n % 5 === 3 ? SCALE_EPS : UNIT_EPS;
      if (differs(a[i], b[i], eps)) return true;
    }
    if (differs(a[i], b[i], UNIT_EPS)) return true; // browAlpha
    i++;
    if (differs(a[i], b[i], 0)) return true; // browKind
    i++;
    if (fxActive(pose) && a[i] !== b[i]) return true; // 特效随时间动
    if (pose.eyeVariant !== this.lastEye || pose.mouthVariant !== this.lastMouth) return true;
    if (!!pose.reduced !== this.lastReduced) return true;
    const v = pose.ext?.v;
    const lv = this.lastExt;
    if (!v !== !lv) return true;
    if (v && lv) {
      if (v.length !== lv.length) return true;
      for (let n = 0; n < v.length; n++) if (Math.abs(v[n] - lv[n]) > PARAM_EPS) return true;
    }
    return false;
  }
}
