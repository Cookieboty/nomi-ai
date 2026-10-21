/**
 * 灵动岛几何：刘海屏检测 + 收起 / 展开尺寸与位置（纯函数，便于测试）。
 *
 * Electron 不暴露 NSScreen.safeAreaInsets，这里用可观测的信号判断刘海：
 * macOS 内建屏 + 菜单栏高度 ≥ 30pt（刘海机型菜单栏约 37–38pt，非刘海约 24–25pt）。
 * 判断错了也无害：只是从「贴刘海展开」退化为「顶部居中胶囊」。
 */
export interface DisplayLike {
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  internal?: boolean;
}

export type IslandMode = 'notch' | 'pill';

export interface IslandGeometry {
  mode: IslandMode;
  /** 展开后的「岛」本身（不含阴影留白）：位置与尺寸；height 为按默认内容（标题 + 一行正文）估算的高度 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 收起时的尺寸（刘海宽 × 菜单栏高 / 小胶囊） */
  collapsed: { width: number; height: number };
  menuBarHeight: number;
  /**
   * 顶部避让：仅刘海屏 = 真实菜单栏（刘海）高度，内容整体放在它下面；
   * 无刘海屏为 0 —— 不预留任何空白。
   */
  inset: number;
  /** 内容行上 / 下内边距：胶囊上下对称；刘海屏顶部是刘海带，文字区上沿只留很小的间距 */
  pad: { top: number; bottom: number };
  /** 内容行最小高度：胶囊 = 图标块；刘海屏图标挪进刘海带，文字区只需一行标题 */
  rowMin: number;
  /** 窗口比岛多出来的透明边距，只用来容纳胶囊的投影；刘海模式没有投影，全为 0 */
  margin: { x: number; bottom: number };
}

/** 岛内上下内边距（对称、紧凑） */
export const ISLAND_PAD_Y = 11;
/** 胶囊内容行最小高度 = 图标块高度 */
export const ISLAND_ROW_MIN = 36;
/** 刘海屏：文字区上 / 下内边距与最小高度（图标与状态点放在刘海带两侧） */
export const NOTCH_PAD = { top: 4, bottom: 12 };
export const NOTCH_ROW_MIN = 18;
/** 内容高度上限（防止异常长文本撑出窗口） */
export const ISLAND_ROW_MAX = 64;
/** 默认内容高度（标题 + 一行正文 ≈ 38） */
export const ISLAND_ROW_DEFAULT = 38;
/** 胶囊与菜单栏 / 工作区顶部的间距 */
export const ISLAND_GAP = 5;
/** 胶囊投影留白：左右 / 下 */
export const SHADOW_MARGIN = { x: 14, bottom: 18 };

/** macOS 刘海宽度约 180–210pt（14"/16" MacBook Pro、Air），取中间值 */
export const NOTCH_WIDTH = 196;

/**
 * 调试 / 截图：CD_ISLAND_SIMULATE_NOTCH=1 在任意平台模拟 37pt 菜单栏 + 刘海；
 * =0 当作没有刘海（在带刘海的 Mac 上测胶囊形态）
 */
const simulate = () => process.env.CD_ISLAND_SIMULATE_NOTCH === '1';
const noNotch = () => process.env.CD_ISLAND_SIMULATE_NOTCH === '0';

export function hasNotch(platform: NodeJS.Platform, d: DisplayLike): boolean {
  if (simulate()) return true;
  if (noNotch()) return false;
  if (platform !== 'darwin') return false;
  const menuBar = d.workArea.y - d.bounds.y;
  return d.internal !== false && menuBar >= 30;
}

/** 岛的总高度 = 顶部避让 + 上内边距 + 内容高度 + 下内边距（窗口高度据此计算，不留空黑） */
type HeightArgs = Pick<IslandGeometry, 'inset' | 'pad' | 'rowMin'>;
export function islandHeight(g: HeightArgs, contentHeight: number): number {
  const c = Number.isFinite(contentHeight) ? contentHeight : ISLAND_ROW_DEFAULT;
  const content = Math.min(ISLAND_ROW_MAX, Math.max(g.rowMin, Math.ceil(c)));
  return g.inset + g.pad.top + g.pad.bottom + content;
}

/** 把渲染进程量出的岛高度夹在合理范围内（下限 = 只有一行图标，上限 = 防异常长文本） */
export function clampIslandHeight(g: HeightArgs, measured: number): number {
  return islandHeight(g, measured - g.inset - g.pad.top - g.pad.bottom);
}

/** 窗口矩形 = 岛 + 投影留白；岛贴窗口顶部、水平居中 */
export function islandWindowRect(g: IslandGeometry, height: number) {
  return {
    x: g.x - g.margin.x,
    y: g.y,
    width: g.width + g.margin.x * 2,
    height: height + g.margin.bottom,
  };
}

export function islandGeometry(
  platform: NodeJS.Platform,
  d: DisplayLike,
  pref: 'auto' | 'pill' = 'auto',
): IslandGeometry {
  const menuBarHeight = simulate() ? 37 : Math.max(0, d.workArea.y - d.bounds.y);
  const notch = pref === 'auto' && hasNotch(platform, d);
  const width = Math.min(400, d.bounds.width - 32);
  const inset = notch ? menuBarHeight : 0;
  const pad = notch ? NOTCH_PAD : { top: ISLAND_PAD_Y, bottom: ISLAND_PAD_Y };
  const rowMin = notch ? NOTCH_ROW_MIN : ISLAND_ROW_MIN;
  const x = Math.round(d.bounds.x + (d.bounds.width - width) / 2);
  // 刘海：顶到屏幕最上沿，与刘海融为一体；其它：菜单栏 / 工作区顶部下方留 5px
  const y = notch ? d.bounds.y : d.workArea.y + ISLAND_GAP;
  return {
    mode: notch ? 'notch' : 'pill',
    x,
    y,
    width,
    height: islandHeight({ inset, pad, rowMin }, ISLAND_ROW_DEFAULT),
    collapsed: notch ? { width: NOTCH_WIDTH, height: menuBarHeight } : { width: 132, height: 30 },
    menuBarHeight,
    inset,
    pad: { ...pad },
    rowMin,
    margin: notch ? { x: 0, bottom: 0 } : { ...SHADOW_MARGIN },
  };
}
