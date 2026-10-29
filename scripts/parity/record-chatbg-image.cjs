/**
 * 聊天背景图片处理 golden：在真实 Electron 主进程里跑 electronPorts.ts 的 image 端口（size / resize），
 * 按 ChatBackgroundService.importNow 的规则（长边 > 2560 才缩、PNG 存 PNG、其余 JPEG q85）记录：
 * 能否解码、输出是否缩放、输出格式（魔数）、输出尺寸（再解一次）、是否为空。像素不比（见 docs D-B10-6）。
 * 输入由 createFromBitmap 生成（Go 测试按同尺寸自行编码同格式）；webp/gif/bmp 用固定字节。
 * 用法（需 electron@44.9.3）：xvfb-run electron scripts/parity/record-chatbg-image.cjs [outDir]
 */
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const MAX = 2560;
// —— 以下两段逐字取自 packages/host-electron/src/host/electronPorts.ts 的 image 端口
const size = (data) => { const img = nativeImage.createFromBuffer(Buffer.from(data)); return img.isEmpty() ? null : img.getSize(); };
const resize = (data, opts) => {
  const img = nativeImage.createFromBuffer(Buffer.from(data));
  if (img.isEmpty()) throw new Error('image decode failed');
  const out = img.resize({ ...(opts.width !== undefined ? { width: opts.width } : {}), ...(opts.height !== undefined ? { height: opts.height } : {}), quality: 'best' });
  return new Uint8Array(opts.format === 'png' ? out.toPNG() : out.toJPEG(opts.quality ?? 85));
};
// —— importNow 的缩放分支
function processImage(ext, data) {
  const { width, height } = size(data) ?? { width: 0, height: 0 };
  if (Math.max(width, height) <= MAX) return { ext, resized: null };
  const edge = width >= height ? { width: MAX } : { height: MAX };
  if (ext === '.png') return { ext, resized: resize(data, { ...edge, format: 'png' }) };
  return { ext: '.jpg', resized: resize(data, { ...edge, format: 'jpeg', quality: 85 }) };
}
const magic = (b) => (b.length === 0 ? 'empty' : b[0] === 0x89 ? 'png' : b[0] === 0xff ? 'jpeg' : 'other');
const bitmap = (w, h) => { const b = Buffer.alloc(w * h * 4); for (let i = 0; i < w * h; i++) { b[i * 4] = i % 251; b[i * 4 + 1] = (i >> 3) % 253; b[i * 4 + 2] = 128; b[i * 4 + 3] = 255; } return nativeImage.createFromBitmap(b, { width: w, height: h }); };
const FIXED = {
  gif: 'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
  webp: 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
  bmp: 'Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAA==',
  junk: Buffer.from('not an image').toString('base64'),
};
app.whenReady().then(() => {
  const cases = [];
  const dims = [[100, 80], [2560, 2560], [2561, 2560], [2560, 2561], [2561, 100], [100, 2561], [3000, 3000], [5000, 3333], [3333, 5000], [7777, 1234], [1234, 7777], [4000, 2999], [2999, 4000], [6001, 7], [7, 6001], [9000, 1], [1, 9000], [5121, 1], [5119, 1], [3841, 2]];
  for (const [w, h] of dims) for (const enc of ['png', 'jpeg']) for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const img = bitmap(w, h);
    const data = enc === 'png' ? img.toPNG() : img.toJPEG(90);
    const r = processImage(ext, data);
    const outSize = r.resized && r.resized.length ? nativeImage.createFromBuffer(Buffer.from(r.resized)).getSize() : null;
    cases.push({ enc, w, h, ext, outExt: r.ext, resized: r.resized !== null, format: r.resized ? magic(r.resized) : null, out: outSize });
  }
  for (const [k, b64] of Object.entries(FIXED)) for (const ext of ['.png', '.jpg', '.webp']) {
    const r = processImage(ext, Buffer.from(b64, 'base64'));
    cases.push({ fixed: k, ext, outExt: r.ext, resized: r.resized !== null, size: size(Buffer.from(b64, 'base64')) });
  }
  const dir = process.argv.find((a, i) => i > 1 && !a.startsWith('-') && !a.endsWith('.cjs')) || process.env.NOMI_GOLDEN_DIR || path.join(__dirname, '../../apps/desktop-go/internal/core/chatbg/testdata');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'image.json'), JSON.stringify({ electron: process.versions.electron, fixed: FIXED, cases }, null, 1) + '\n');
  console.log('chatbg image cases', cases.length, 'electron', process.versions.electron);
  app.quit();
});
