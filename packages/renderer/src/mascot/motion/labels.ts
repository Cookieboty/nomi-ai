import { ACTION_LABELS } from '../rig/actions';

/** 动作名 → 中文显示名（菜单 / 托盘）。2D 骨架的动作名称来自 rig/actions.ts，同名时以那里为准。 */
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
  ...ACTION_LABELS,
};
