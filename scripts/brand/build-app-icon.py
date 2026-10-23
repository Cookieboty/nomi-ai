#!/usr/bin/env python3
"""
Nomi 应用图标（原创矢量，MIT）：双色流畅曲线 N（主笔画 + 橙色次笔画衬底）+ 橙色四角星光，
配色 #FB9466 / #F7A67C / 奶油 / 深棕。N 与星光的几何直接取自品牌 docs/brand/nomi-app-icon.svg
（256 方框内的路径 + translate/scale 变换），保证图标与品牌 logo 一致。
生成 SVG 变体到 docs/brand/icon-variants/；栅格化 + 打包 ico/icns/png 见
scripts/brand/build-icon-assets.py（Chrome 栅格化，Pillow 打包）。

- macOS：Apple 图标网格——1024 画布内 824×824 的连续曲率圆角矩形（superellipse，n≈5），
  四周留 100px 透明边，系统投影由 macOS 自己画（这里只画极淡的内阴影 / 渐变）。
- Windows / Linux：同一图形铺满（圆角 22%），小尺寸（≤32px）用加粗笔画的「小号」版本。
"""
import math
import os
import sys

OUT = sys.argv[1] if len(sys.argv) > 1 else 'docs/brand/icon-variants'

BROWN = '#33291F'
CREAM = '#FFF6EC'
ORANGE = '#FB9466'  # 星光
ORANGE_SOFT = '#F7A67C'  # 品牌 logo 的橙色次笔画（N 的橙色阴影 / 衬底）
# sunset 变体底色本身就是橙色，#F7A67C 的次笔画会"隐形"：改用更深的赤陶橙，
# 与奶油主笔画、深棕星光都能拉开层次（对底 #F5946A 约 1.5:1 亮度比 + 明显更深的色相，对奶油 ≥2.5:1）
ORANGE_DEEP = '#C2531F'

VARIANTS = {
    # 名称: (背景渐变上, 背景渐变下, N 主笔画, 星光颜色, 橙色次笔画)
    'cream': ('#FFFAF4', '#F6E6D4', BROWN, ORANGE, ORANGE_SOFT),
    'ink': ('#43362B', '#1F1813', CREAM, ORANGE, ORANGE_SOFT),
    'sunset': ('#FDAA82', '#F07E4C', CREAM, BROWN, ORANGE_DEEP),
}

# 品牌 N（docs/brand/nomi-mark.svg，256×256 方框）。次笔画画在主笔画下层。
SECONDARY_D = 'M84 104 C96 96 112 104 120 128 C128 154 138 188 156 196'
PRIMARY_D = 'M48 200 C48 120 64 70 100 70 C140 70 142 196 180 196 C204 196 214 176 214 150'
STAR_D = 'M200 30 C203 50 210 57 230 60 C210 63 203 70 200 90 C197 70 190 63 170 60 C190 57 197 50 200 30 Z'
STAR_C = (200, 60)  # 星光中心（小号版本以它为中心放大）
GLYPH_C = (131, 123)  # 图形包围盒中心（小号版本以它为中心整体放大）
# nomi-app-icon.svg：896 圆角方块内，translate(192 176)-(64,64)=(128,112)，scale 2.5
BRAND_TILE, BRAND_OFF, BRAND_SCALE = 896, (128, 112), 2.5


def squircle(x, y, size, n=5.0, steps=256):
    """连续曲率圆角矩形（|x|^n + |y|^n = 1），比普通圆角更接近 macOS 图标形状"""
    a = size / 2
    cx, cy = x + a, y + a
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        px = cx + a * math.copysign(abs(c) ** (2 / n), c)
        py = cy + a * math.copysign(abs(s) ** (2 / n), s)
        pts.append(f'{px:.2f},{py:.2f}')
    return 'M' + ' L'.join(pts) + ' Z'


def sparkle(cx, cy, r, waist=0.16):
    """四角星：四个尖角用二次曲线收腰"""
    w = r * waist
    return (
        f'M{cx},{cy - r} Q{cx + w},{cy - w} {cx + r},{cy} '
        f'Q{cx + w},{cy + w} {cx},{cy + r} Q{cx - w},{cy + w} {cx - r},{cy} '
        f'Q{cx - w},{cy - w} {cx},{cy - r} Z'
    )


def mark(fg, star, accent, x0, y0, size, small=False):
    """双色 N + 星光，(x0, y0, size) 为底板方块。几何与 nomi-app-icon.svg 的变换同比例：
    N 方框原点 = 底板原点 + BRAND_OFF/BRAND_TILE * size，缩放 = BRAND_SCALE * size / BRAND_TILE。
    小号（≤48px）：整体放大 12%、主笔画 40→52、次笔画 30→44（保证 16px 仍能看见橙色）、星光放大 1.3 倍。"""
    k = size / BRAND_TILE
    sc = BRAND_SCALE * k
    tx, ty = x0 + BRAND_OFF[0] * k, y0 + BRAND_OFF[1] * k
    if small:
        g = 1.12
        # 以图形中心为不动点放大：p' = c + g (p - c)
        tx += (1 - g) * GLYPH_C[0] * sc
        ty += (1 - g) * GLYPH_C[1] * sc
        sc *= g
        w1, w2, sr = 52, 44, 1.3
    else:
        w1, w2, sr = 40, 30, 1.0
    star_t = ''
    if sr != 1.0:
        cx, cy = STAR_C
        star_t = f' transform="translate({cx * (1 - sr):.2f} {cy * (1 - sr):.2f}) scale({sr})"'
    return (
        f'<g transform="translate({tx:.2f} {ty:.2f}) scale({sc:.4f})">'
        f'<path d="{SECONDARY_D}" fill="none" stroke="{accent}" stroke-width="{w2}" stroke-linecap="round"/>'
        f'<path d="{PRIMARY_D}" fill="none" stroke="{fg}" stroke-width="{w1}" '
        f'stroke-linecap="round" stroke-linejoin="round"/>'
        f'<path d="{STAR_D}" fill="{star}"{star_t}/>'
        f'</g>'
    )


def legacy_mono_mark(fg, star, x0, y0, s):
    """macOS 托盘模板图专用的单色 N（纯黑 + alpha，系统约定：只看 alpha，不能有第二种颜色）。
    形状沿用既有 nomi-tray-template.svg，保持 trayTemplate*.png 不变。"""
    sw = 0.205 * s
    P = lambda u, v: f'{x0 + u * s:.1f} {y0 + v * s:.1f}'
    d = (
        f'M{P(0.17, 0.80)} '
        f'C{P(0.17, 0.52)} {P(0.24, 0.30)} {P(0.38, 0.30)} '
        f'C{P(0.53, 0.30)} {P(0.52, 0.78)} {P(0.67, 0.78)} '
        f'C{P(0.78, 0.78)} {P(0.82, 0.66)} {P(0.82, 0.55)}'
    )
    star_r = 0.15 * s
    return (
        f'<path d="{d}" fill="none" stroke="{fg}" stroke-width="{sw:.1f}" '
        f'stroke-linecap="round" stroke-linejoin="round"/>'
        f'<path d="{sparkle(x0 + 0.80 * s, y0 + 0.24 * s, star_r)}" fill="{star}"/>'
    )


def svg(name, mac=True, small=False):
    top, bottom, fg, star, accent = VARIANTS[name]
    if mac:
        x, size = 100, 824
        shape = f'<path d="{squircle(x, x, size)}" fill="url(#bg)"/>'
        hl = f'<path d="{squircle(x, x, size)}" fill="url(#sheen)"/>'
        rim = (
            f'<path d="{squircle(x + 1, x + 1, size - 2)}" fill="none" '
            f'stroke="#000" stroke-opacity="0.08" stroke-width="2"/>'
        )
    else:
        x, size = 0, 1024
        r = 1024 * 0.22
        shape = f'<rect width="1024" height="1024" rx="{r}" fill="url(#bg)"/>'
        hl = f'<rect width="1024" height="1024" rx="{r}" fill="url(#sheen)"/>'
        rim = ''
    body = mark(fg, star, accent, x, x, size, small)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <title>Nomi app icon ({name}{', mac grid' if mac else ''}{', small' if small else ''})</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{top}"/>
      <stop offset="1" stop-color="{bottom}"/>
    </linearGradient>
    <radialGradient id="sheen" cx="0.3" cy="0.12" r="0.9">
      <stop offset="0" stop-color="#fff" stop-opacity="0.18"/>
      <stop offset="0.6" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  {shape}
  {hl}
  {rim}
  {body}
</svg>
'''


def tray(template):
    """托盘：只有图形，无底板。mac 模板图为纯黑 + alpha（系统自动反色），保持单色"""
    assert template, 'tray-color 用 svg(sunset, small) 生成'
    fg = star = '#000000'
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  {legacy_mono_mark(fg, star, 20, 20, 984)}
</svg>
'''


def tray_color():
    """Windows / Linux 托盘：小号满版图标（深浅任务栏都看得清）"""
    return svg('sunset', mac=False, small=True)


os.makedirs(OUT, exist_ok=True)
for v in VARIANTS:
    for mac in (True, False):
        for small in (False, True):
            if mac and small:
                continue
            suffix = ('-mac' if mac else '-flat') + ('-small' if small else '')
            with open(os.path.join(OUT, f'nomi-{v}{suffix}.svg'), 'w') as f:
                f.write(svg(v, mac, small))
with open(os.path.join(OUT, 'nomi-tray-template.svg'), 'w') as f:
    f.write(tray(True))
with open(os.path.join(OUT, 'nomi-tray-color.svg'), 'w') as f:
    f.write(tray_color())
print('wrote', sorted(os.listdir(OUT)))
