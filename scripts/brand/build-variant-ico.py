#!/usr/bin/env python3
"""
为每个应用图标变体生成 Windows .ico（#56：运行时 win.setAppDetails 需要磁盘上的 .ico）。

输出 packages/host-electron/assets/app-icons/<变体>/app.ico，尺寸 16/24/32/48/64/128/256：
16–48px 用 nomi-<变体>-flat-small.svg，≥64px 用 nomi-<变体>-flat.svg（与 assets/icon.ico 同规则）。

依赖：Pillow + 一个 headless Chrome / Chromium（CHROME 环境变量或 PATH 中的 google-chrome / chromium）。
用法：python3 scripts/brand/build-variant-ico.py
"""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'docs' / 'brand' / 'icon-variants'
OUT = ROOT / 'packages' / 'electron' / 'assets' / 'app-icons'
VARIANTS = ['ink', 'cream', 'sunset']
SMALL = [16, 24, 32, 48]
LARGE = [64, 128, 256]
RENDER = 512


def chrome() -> str:
    for c in [os.environ.get('CHROME'), 'google-chrome', 'chromium', 'chromium-browser']:
        if c and shutil.which(c):
            return shutil.which(c)  # type: ignore[return-value]
    sys.exit('need headless Chrome/Chromium (set CHROME=...)')


def render(svg: Path, tmp: Path) -> Image.Image:
    html = tmp / (svg.stem + '.html')
    html.write_text(
        '<html><body style="margin:0;background:transparent">'
        f'<img src="{svg.as_uri()}" style="width:{RENDER}px;height:{RENDER}px;display:block">'
        '</body></html>'
    )
    png = tmp / (svg.stem + '.png')
    subprocess.run(
        [chrome(), '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
         '--default-background-color=00000000', '--force-device-scale-factor=1',
         f'--window-size={RENDER},{RENDER}', f'--screenshot={png}', html.as_uri()],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return Image.open(png).convert('RGBA').crop((0, 0, RENDER, RENDER))


def main() -> None:
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        for v in VARIANTS:
            small = render(SRC / f'nomi-{v}-flat-small.svg', tmp)
            large = render(SRC / f'nomi-{v}-flat.svg', tmp)
            frames = [small.resize((s, s), Image.LANCZOS) for s in SMALL] + [
                large.resize((s, s), Image.LANCZOS) for s in LARGE
            ]
            out = OUT / v / 'app.ico'
            # Pillow 写 ico：以最大帧为基准，按 sizes 逐个取 append_images 中尺寸匹配的帧
            frames[-1].save(out, format='ICO', sizes=[(s, s) for s in SMALL + LARGE],
                            append_images=frames[:-1])
            print(f'wrote {out.relative_to(ROOT)} ({out.stat().st_size} B)')


if __name__ == '__main__':
    main()
