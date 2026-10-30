export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * RGBA 像素（WebGL 读回，行从下往上）→ 不透明区域的水平扫描线矩形（CSS 像素，窗口坐标）。
 * band = 每条扫描带的设备像素高度；pad = 四周外扩（CSS 像素），容纳抗锯齿边缘。
 */
export function alphaSpans(
  pixels: Uint8Array,
  width: number,
  height: number,
  opts: {
    band?: number;
    threshold?: number;
    gap?: number;
    pad?: number;
    scale?: number;
    offsetX?: number;
    offsetY?: number;
    /** rows stored top-down (Canvas2D getImageData) instead of GL bottom-up */
    topDown?: boolean;
  } = {},
): Rect[] {
  const band = opts.band ?? 8;
  const threshold = opts.threshold ?? 16;
  const gap = opts.gap ?? 6;
  const pad = opts.pad ?? 3;
  const scale = opts.scale ?? 1; // 设备像素 → CSS 像素
  const ox = opts.offsetX ?? 0;
  const oy = opts.offsetY ?? 0;
  const out: Rect[] = [];
  for (let top = 0; top < height; top += band) {
    // 带内任一行不透明即算
    const bottom = Math.min(height, top + band);
    const filled = new Uint8Array(width);
    for (let yy = top; yy < bottom; yy += 2) {
      const row = opts.topDown ? yy : height - 1 - yy; // GL 行序自下而上
      const base = row * width * 4;
      for (let x = 0; x < width; x += 1) if (pixels[base + x * 4 + 3] > threshold) filled[x] = 1;
    }
    let x = 0;
    while (x < width) {
      if (!filled[x]) {
        x += 1;
        continue;
      }
      const start = x;
      let end = x;
      let miss = 0;
      while (x < width && miss <= gap) {
        if (filled[x]) {
          end = x;
          miss = 0;
        } else miss += 1;
        x += 1;
      }
      out.push({
        x: ox + start * scale - pad,
        y: oy + top * scale - pad,
        width: (end - start + 1) * scale + pad * 2,
        height: (bottom - top) * scale + pad * 2,
      });
    }
  }
  return out;
}

/** 矩形签名（用于去重上报） */
export function rectsKey(rects: Rect[]): string {
  return rects
    .map(
      (r) => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`,
    )
    .join(';');
}
