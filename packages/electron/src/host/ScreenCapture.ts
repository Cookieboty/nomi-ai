/**
 * ScreenCapture - 基于 Electron `desktopCapturer` + `screen` 模块实现 ScreenService
 *
 * `desktopCapturer.getSources` 返回的 thumbnail 是 nativeImage；本类把首选 source
 * 的 thumbnail 转 PNG/JPEG buffer。区域截取通过 `crop` 完成。
 */

import type {
  CaptureOptions,
  CaptureResult,
  DisplayInfo,
  ScreenService,
} from '@nomi-ai/bundle-ig-electron-caps';
import { desktopCapturer, nativeImage, screen } from 'electron';

export class ScreenCapture implements ScreenService {
  async listDisplays(): Promise<DisplayInfo[]> {
    return screen.getAllDisplays().map((d) => ({
      id: String(d.id),
      name: (d as unknown as { label?: string }).label ?? `display-${d.id}`,
      primary: d.id === screen.getPrimaryDisplay().id,
      bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
      scaleFactor: d.scaleFactor,
    }));
  }

  async capture(opts: CaptureOptions = {}): Promise<CaptureResult> {
    const displays = screen.getAllDisplays();
    const targetDisplay = opts.displayId
      ? (displays.find((d) => String(d.id) === opts.displayId) ?? screen.getPrimaryDisplay())
      : screen.getPrimaryDisplay();

    const maxWidth = opts.maxWidth ?? targetDisplay.bounds.width;
    const maxHeight = opts.maxHeight ?? targetDisplay.bounds.height;

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: maxWidth, height: maxHeight },
    });

    const source = sources.find((s) => s.display_id === String(targetDisplay.id)) ?? sources[0];
    if (!source) {
      throw new Error('[ScreenCapture] desktopCapturer returned no sources');
    }

    let img = source.thumbnail;
    if (opts.area) {
      img = img.crop({
        x: opts.area.x,
        y: opts.area.y,
        width: opts.area.width,
        height: opts.area.height,
      });
    }

    const mime = opts.mime ?? 'image/png';
    const buf = mime === 'image/jpeg' ? img.toJPEG(85) : img.toPNG();
    const size = img.getSize();

    return {
      displayId: String(targetDisplay.id),
      mime,
      data: new Uint8Array(buf),
      width: size.width,
      height: size.height,
      capturedAt: Date.now(),
    };
  }
}

/** 内部使用：确保 nativeImage 引用被打包（不参与运行时逻辑） */
export const __nativeImageProbe = typeof nativeImage !== 'undefined';
