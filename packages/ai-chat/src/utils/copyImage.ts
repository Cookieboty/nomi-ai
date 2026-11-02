/**
 * 把一张图片复制到系统剪贴板（对话里的图片、素材库查看器共用）。
 *
 * - 剪贴板只稳定支持 image/png（Chromium 与 WebKit 都是）：其它格式先经 canvas 转成 PNG；
 * - WebKit（Go 版 macOS）要求 ClipboardItem 在点击的同一个调用栈里创建：内容传 Promise，图片异步读出来再交给它。
 * 必须在点击等用户手势里调用。
 */
async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  );
}

/** src：本页能加载的图片地址（data: / blob: / 资产网关地址）；失败时抛错 */
export async function copyImage(src: string): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write)
    throw new Error('clipboard unavailable');
  const png = fetch(src)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.blob();
    })
    .then(toPng);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
