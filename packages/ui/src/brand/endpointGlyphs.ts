/** Nomi 使用自有品牌路径；agent 引用共享 LobeHub 产品图标，避免重复维护替代图形。 */
export type EndpointGlyphKey =
  'nomi' | 'claude' | 'codex' | 'dsh' | 'grok' | 'gemini' | 'kimi' | 'minimax' | 'external';

export interface GlyphPath {
  d: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  /** 可选：包在 <g transform> 里 */
  transform?: string;
}

export interface EndpointGlyph {
  /** LobeHub 产品图标 id；与供应商品牌 id 区分。 */
  brand?: string;
  /** 侧栏使用的彩色版本；没有彩色版本时沿用 brand。 */
  colorBrand?: string;
  /** 方块底色（自有 Nomi 图形） */
  tile: string;
  /** 方块描边（浅色底在深色界面上需要） */
  tileStroke?: string;
  /** 透明展示时，白色笔画使用的品牌色；缺省时跟随文字色。 */
  markInk?: string;
  paths: GlyphPath[];
}

const NOMI_MARK = 'translate(2.05 2.15) scale(0.0455)';

export const ENDPOINT_GLYPHS: Readonly<Record<EndpointGlyphKey, EndpointGlyph>> = {
  nomi: {
    tile: '#FCEFE1',
    paths: [
      {
        d: 'M84 104 C96 96 112 104 120 128 C128 154 138 188 156 196',
        stroke: '#F7A67C',
        strokeWidth: 30,
        transform: NOMI_MARK,
      },
      {
        d: 'M48 200 C48 120 64 70 100 70 C140 70 142 196 180 196 C204 196 214 176 214 150',
        stroke: '#33291F',
        strokeWidth: 40,
        transform: NOMI_MARK,
      },
      {
        d: 'M200 30 C203 50 210 57 230 60 C210 63 203 70 200 90 C197 70 190 63 170 60 C190 57 197 50 200 30 Z',
        fill: '#FB9466',
        transform: NOMI_MARK,
      },
    ],
  },
  claude: { brand: 'claudecode', tile: 'transparent', paths: [] },
  codex: { brand: 'codex', colorBrand: 'codex-color', tile: 'transparent', paths: [] },
  dsh: { brand: 'deepseek', tile: 'transparent', paths: [] },
  grok: { brand: 'grok', tile: 'transparent', paths: [] },
  gemini: { brand: 'geminicli', colorBrand: 'gemini', tile: 'transparent', paths: [] },
  kimi: { brand: 'kimi', tile: 'transparent', paths: [] },
  minimax: { brand: 'minimax', tile: 'transparent', paths: [] },
  external: {
    tile: '#5b6472',
    paths: [
      { d: 'M4 5l3 3-3 3', fill: 'none', stroke: '#fff', strokeWidth: 1.6 },
      { d: 'M8.5 11.5H12', fill: 'none', stroke: '#fff', strokeWidth: 1.6 },
    ],
  },
};

/** 各端点的代表色（徽标、边框等） */
export const ENDPOINT_COLOR: Readonly<Record<EndpointGlyphKey, string>> = {
  nomi: '#f4895a',
  claude: '#d97757',
  codex: '#111111',
  dsh: '#4D6BFE',
  grok: '#111111',
  gemini: '#2f5bd3',
  kimi: '#1783FF',
  minimax: '#F23F5D',
  external: '#5b6472',
};
