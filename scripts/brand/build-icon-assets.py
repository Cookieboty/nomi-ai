#!/usr/bin/env python3
"""
把 docs/brand/icon-variants/*.svg 栅格化（headless Chrome）并用 Pillow 打包成 apps/desktop-electron/assets 下的
全部应用图标资源（文件名 / 尺寸 / 格式与既有资源一致）：

- icon.icns                      ink-mac：128/256/512/1024 + @2x（32/64/256/512），带 TOC
- icon.ico, icons/<N>x<N>.png    ink-flat（≥64px）/ ink-flat-small（≤48px）
- app-icons/<变体>/app.ico       同 icon.ico 的规则，三个变体各一份
- app-icons/<变体>/dock.png      <变体>-mac 512
- app-icons/<变体>/window.png    <变体>-flat 256
- app-icons/<变体>/tray.png      <变体>-flat-small 32；tray@2x.png 64
trayTemplate*.png（macOS 模板图，纯黑 + alpha）不在此处理：保持单色，由 nomi-tray-template.svg 另行维护。

依赖：Pillow + headless Chrome / Chromium（CHROME 环境变量或 PATH 中的 google-chrome / chromium）。
用法：python3 scripts/brand/build-icon-assets.py [svg目录] [assets目录]
（取代 build-variant-ico.py 的 app.ico 部分；后者仍可单独使用）
"""
import io
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'docs' / 'brand' / 'icon-variants'
# 默认写到 Electron 宿主的打包资源目录（electron-builder buildResources / extraResources）
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / 'apps' / 'desktop-electron' / 'assets'
VARIANTS = ['ink', 'cream', 'sunset']
SMALL = [16, 24, 32, 48]
LARGE = [64, 128, 256]
RENDER = 1024


def chrome() -> str:
    for c in [os.environ.get('CHROME'), 'google-chrome', 'chromium', 'chromium-browser']:
        if c and shutil.which(c):
            return shutil.which(c)  # type: ignore[return-value]
    sys.exit('need headless Chrome/Chromium (set CHROME=...)')


_cache: dict = {}
_tmp = Path(tempfile.mkdtemp(prefix='nomi-icons-'))


def render(name: str) -> Image.Image:
    """SVG → 1024×1024 透明背景 RGBA（Chrome 栅格化，结果缓存）"""
    if name in _cache:
        return _cache[name]
    svg = SRC / f'{name}.svg'
    html = _tmp / f'{name}.html'
    html.write_text(
        '<html><body style="margin:0;background:transparent">'
        f'<img src="{svg.resolve().as_uri()}" style="width:{RENDER}px;height:{RENDER}px;display:block">'
        '</body></html>'
    )
    png = _tmp / f'{name}.png'
    subprocess.run(
        [chrome(), '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
         '--default-background-color=00000000', '--force-device-scale-factor=1',
         f'--window-size={RENDER},{RENDER}', f'--screenshot={png}', html.as_uri()],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    im = Image.open(png).convert('RGBA').crop((0, 0, RENDER, RENDER))
    _cache[name] = im
    return im


def sized(name: str, px: int) -> Image.Image:
    im = render(name)
    return im if px == RENDER else im.resize((px, px), Image.LANCZOS)


def png_bytes(im: Image.Image) -> bytes:
    b = io.BytesIO()
    im.save(b, format='PNG', optimize=True)
    return b.getvalue()


def flat_frame(v: str, px: int) -> Image.Image:
    return sized(f'nomi-{v}-flat-small' if px <= 48 else f'nomi-{v}-flat', px)


def write_ico(v: str, path: Path) -> None:
    sizes = SMALL + LARGE
    frames = [flat_frame(v, s) for s in sizes]
    frames[-1].save(path, format='ICO', sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    print('wrote', path.relative_to(OUT), path.stat().st_size, 'B')


def write_icns(v: str, path: Path) -> None:
    """ic07=128 ic08=256 ic09=512 ic10=1024 ic11=16@2x(32) ic12=32@2x(64) ic13=128@2x(256) ic14=256@2x(512)"""
    entries = [('ic07', 128), ('ic08', 256), ('ic09', 512), ('ic10', 1024),
               ('ic11', 32), ('ic12', 64), ('ic13', 256), ('ic14', 512)]
    blobs = [(t, png_bytes(sized(f'nomi-{v}-mac', px))) for t, px in entries]
    toc = b'TOC ' + struct.pack('>I', 8 + 8 * len(blobs)) + b''.join(
        t.encode() + struct.pack('>I', 8 + len(b)) for t, b in blobs)
    body = toc + b''.join(t.encode() + struct.pack('>I', 8 + len(b)) + b for t, b in blobs)
    path.write_bytes(b'icns' + struct.pack('>I', 8 + len(body)) + body)
    print('wrote', path.relative_to(OUT), path.stat().st_size, 'B')


def save_png(im: Image.Image, path: Path) -> None:
    path.write_bytes(png_bytes(im))
    print('wrote', path.relative_to(OUT), im.size)


def main() -> None:
    # 目录不存在时直接报错，不在过时的位置悄悄新建（宿主目录迁移后漏改过一次，#204）
    if not OUT.is_dir():
        sys.exit(f'output directory not found: {OUT}')
    write_icns('ink', OUT / 'icon.icns')
    write_ico('ink', OUT / 'icon.ico')
    for s in SMALL + LARGE + [512, 1024]:
        save_png(flat_frame('ink', s) if s != 512 and s != 1024 else sized('nomi-ink-flat', s),
                 OUT / 'icons' / f'{s}x{s}.png')
    for v in VARIANTS:
        d = OUT / 'app-icons' / v
        write_ico(v, d / 'app.ico')
        save_png(sized(f'nomi-{v}-mac', 512), d / 'dock.png')
        save_png(sized(f'nomi-{v}-flat', 256), d / 'window.png')
        save_png(sized(f'nomi-{v}-flat-small', 32), d / 'tray.png')
        save_png(sized(f'nomi-{v}-flat-small', 64), d / 'tray@2x.png')
    shutil.rmtree(_tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
