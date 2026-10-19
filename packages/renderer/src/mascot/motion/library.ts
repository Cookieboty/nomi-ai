import { ACTION_LABELS } from '../rig/actions';

/**
 * 动作库（public/assets/motions/motions.json，由 scripts/build-motions.mjs 生成）。
 *
 * 数据位于 VRM 1.0「规范化骨骼」空间（T-pose 为 rest、面向 +Z），与具体模型无关；
 * 运行时按模型构建 THREE.AnimationClip（VRM 0.x 需翻转四元数 x/z）。
 */
export interface MotionClipData {
  name: string;
  loop: boolean;
  tags: string[];
  duration: number;
  source: string;
  license: string;
  times: number[];
  /** 骨骼名（VRMHumanBoneName）→ 扁平四元数 [x,y,z,w, ...]，与 times 等长 */
  tracks: Record<string, number[]>;
  /** hips 位移（相对 rest，按 hips 高度归一化）[x,y,z, ...] */
  hips: number[];
}

export interface MotionLibrary {
  version: number;
  space: string;
  fps: number;
  clips: MotionClipData[];
}

export const MOTIONS_PATH = './assets/motions/motions.json';

/** 动作名 → 中文显示名（菜单 / 托盘）。2D 动作库的名称来自 rig/actions.ts。 */
export const MOTION_LABELS: Record<string, string> = {
  wave: '挥手',
  nod: '点头',
  shake: '摇头',
  think: '思考',
  clap: '拍手',
  bow: '鞠躬',
  cheer: '欢呼',
  celebrate: '庆祝',
  hop: '小跳',
  jump: '后跳',
  stomp: '跺脚',
  shrug: '耸肩',
  look_around: '张望',
  shy: '害羞',
  point: '指向',
  greet: '打招呼',
  dance: '跳舞',
  stretch: '伸懒腰',
  interact: '伸手',
  flinch: '受惊',
  poke: '被戳',
  walk: '散步',
  squat: '下蹲',
  crouch: '下蹲',
  step: '迈步',
  march: '原地踏步',
  // 2D 骨架的动作库（rig/actions.ts）：同名时以这里的名称为准
  ...ACTION_LABELS,
};

export function parseMotionLibrary(raw: unknown): MotionLibrary {
  const lib = raw as Partial<MotionLibrary> | null;
  if (!lib || !Array.isArray(lib.clips)) throw new Error('motions.json: missing clips');
  const clips = lib.clips.filter(
    (c): c is MotionClipData =>
      !!c &&
      typeof c.name === 'string' &&
      Array.isArray(c.times) &&
      c.times.length > 0 &&
      typeof c.tracks === 'object' &&
      Object.values(c.tracks).every((v) => Array.isArray(v) && v.length === c.times.length * 4),
  );
  return {
    version: lib.version ?? 1,
    space: lib.space ?? 'vrm1-normalized',
    fps: lib.fps ?? 30,
    clips,
  };
}

let cached: Promise<MotionLibrary> | null = null;

export function loadMotionLibrary(url = MOTIONS_PATH): Promise<MotionLibrary> {
  if (!cached) {
    cached = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(parseMotionLibrary)
      .catch((err) => {
        cached = null;
        throw err;
      });
  }
  return cached;
}
