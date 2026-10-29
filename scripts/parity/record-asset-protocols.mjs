#!/usr/bin/env node
/** chat-asset:// 与 character-pack:// 协议 golden（Node 录制）→ apps/desktop-go/internal/core/assetproto/testdata/protocols.json
 *  - resolveCharacterPackUrl / characterPackMimeFor / registerCharacterPackProtocol：packProtocol.ts 纯模块，直接 import；
 *    handler 用假 protocol.handle 收集，喂真实 Request，录 status / headers / body。
 *  - resolveChatAssetUrl / chatAssetMimeFor：assetProtocol.ts 顶层 import electron，这里切出源码（逐字）去类型后执行；
 *    handler 体与 registerChatAssetProtocol 中的逐字一致（同样切出）。
 *  夹具目录由 tree 描述（Go 测试按同一描述重建），路径以 <ROOT> 记录。
 *  用法：pnpm exec tsx scripts/parity/record-asset-protocols.mjs */
import { mkdirSync, statSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pp = await import(pathToFileURL(join(root, 'packages/core/src/character/packProtocol.ts')).href);
const { CHAT_BG_PRESET_URL } = await import(pathToFileURL(join(root, 'packages/types/src/chatBackground.ts')).href);

// —— 切出 assetProtocol.ts 的纯部分
const src = readFileSync(join(root, 'packages/host-electron/src/host/assetProtocol.ts'), 'utf8');
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error('定位失败: ' + a); return src.slice(i, j); };
let body = cut('const IMG_MIME', '/** chat-asset:// 的特权声明') .replace('presetFile = getChatBackgroundPresetFile(app.isPackaged)', 'presetFile');
const handler = cut('  protocol.handle(CHAT_ASSET_SCHEME, async (req) => {', '\n}\n');
body = `import { promises as fsp } from 'node:fs'; import path from 'node:path';
const CHAT_ASSET_SCHEME='chat-asset'; const CHAT_BG_PRESET_URL=${JSON.stringify(CHAT_BG_PRESET_URL)};
${body}
export function registerChatAsset(protocol, root, presetFile) {
${handler}
}`;
const { code } = await transform(body, { loader: 'ts', format: 'esm' });
const tmpMod = join(mkdtempSync(join(tmpdir(), 'ap-')), 'm.mjs'); writeFileSync(tmpMod, code);
const ca = await import(pathToFileURL(tmpMod).href);

// —— 夹具
const tree = {
  files: {
    'chat/images/a.png': 'PNGDATA', 'chat/images/B.JPG': 'jpgdata', 'chat/images/sub/c.webp': 'webp',
    'chat/images/x y.gif': 'gif', 'chat/images/中文.jpeg': 'zh', 'chat/images/n.txt': 'txt', 'chat/images/noext': 'n',
    'chat/presets/p.jpg': 'nope', 'chat/secret.png': 'secret', 'outside/o.png': 'out',
    'res/backgrounds/nomi-preset.jpg': 'PRESET', 'res/backgrounds/other.jpg': 'other',
    'pack/manifest.json': '{"id":"x"}', 'pack/rive/m.riv': 'RIVE', 'pack/voice/hi.mp3': 'mp3', 'pack/voice/hi.WAV': 'wav',
    'pack/a b.png': 'sp', 'pack/README.md': '# r', 'pack/x.bin': 'bin', 'pack/中.png': 'zh', 'pack/dir/inner.json': '{}',
  },
  symlinks: { 'chat/images/link.png': '../../outside/o.png', 'chat/images/inlink.png': 'a.png', 'pack/out.png': '../outside/o.png', 'pack/in.png': 'rive/m.riv', 'pack/dirlink': 'dir' },
};
const R = realpathSync(mkdtempSync(join(tmpdir(), 'nomi-ap-')));
for (const [p, c] of Object.entries(tree.files)) { mkdirSync(dirname(join(R, p)), { recursive: true }); writeFileSync(join(R, p), c); }
for (const [p, t] of Object.entries(tree.symlinks)) {
  const abs = join(dirname(join(R, p)), t);
  symlinkSync(t, join(R, p), statSync(abs).isDirectory() ? 'dir' : 'file');
}
// Windows 上 path.win32 结果统一成 /（Go 侧同样 ToSlash 后比对）
const rel = (s) => (s == null ? s : s.split(R).join('<ROOT>').split(process.platform === 'win32' ? '\\' : '\0').join('/'));

const chatUrls = [CHAT_BG_PRESET_URL, CHAT_BG_PRESET_URL + '?x=1', 'chat-asset://presets/other.jpg', 'chat-asset://presets/p.jpg',
  'chat-asset://images/a.png', 'chat-asset://IMAGES/a.png', 'chat-asset://images/B.JPG', 'chat-asset://images/b.jpg', 'chat-asset://images/sub/c.webp',
  'chat-asset://images/x%20y.gif', 'chat-asset://images/x y.gif', 'chat-asset://images/%E4%B8%AD%E6%96%87.jpeg', 'chat-asset://images/中文.jpeg',
  'chat-asset://images/n.txt', 'chat-asset://images/noext', 'chat-asset://images/../secret.png', 'chat-asset://images/%2e%2e/secret.png',
  'chat-asset://images/..%2fsecret.png', 'chat-asset://images/sub%2f..%2f..%2fsecret.png', 'chat-asset://images/a.png%00', 'chat-asset://images/%00a.png',
  'chat-asset://images//a.png', 'chat-asset://images/sub//c.webp', 'chat-asset://images/./a.png', 'chat-asset://images/sub/../a.png',
  'chat-asset://images\\a.png', 'chat-asset://images/sub\\c.webp', 'chat-asset://images/link.png', 'chat-asset://images/inlink.png',
  'chat-asset://images/missing.png', 'chat-asset://images/', 'chat-asset://images', 'chat-asset://other/a.png', 'chat-asset://images/%zz.png',
  'chat-asset://images/a.png?q=1#h', 'chat-asset://images/a.png#frag', 'chat-asset://user@images/a.png', 'chat-asset://images:80/a.png',
  'http://images/a.png', 'chat-asset:images/a.png', 'not a url', '', 'CHAT-ASSET://images/a.png', 'chat-asset://images/A.PNG'];
const packUrls = ['character-pack://pack/manifest.json', 'character-pack://pack/rive/m.riv', 'character-pack://PACK/rive/m.riv', 'character-pack://pack/voice/hi.mp3',
  'character-pack://pack/voice/hi.WAV', 'character-pack://pack/a%20b.png', 'character-pack://pack/a b.png', 'character-pack://pack/README.md', 'character-pack://pack/x.bin',
  'character-pack://pack/%E4%B8%AD.png', 'character-pack://pack/dir/inner.json', 'character-pack://pack/dir', 'character-pack://pack/dir/', 'character-pack://pack/',
  'character-pack://pack', 'character-pack://pack/../outside/o.png', 'character-pack://pack/%2e%2e/outside/o.png', 'character-pack://pack/..%2foutside%2fo.png',
  'character-pack://pack/dir%2f..%2f..%2foutside%2fo.png', 'character-pack://pack/out.png', 'character-pack://pack/in.png', 'character-pack://pack/dirlink/inner.json',
  'character-pack://pack//manifest.json', 'character-pack://pack/./manifest.json', 'character-pack://pack/dir/../manifest.json', 'character-pack://pack\\manifest.json',
  'character-pack://pack/dir\\inner.json', 'character-pack://pack/missing.png', 'character-pack://other/manifest.json', 'character-pack://pack/%zz', 'character-pack://pack/a%00',
  'character-pack://pack/manifest.json?v=2', 'character-pack://pack/manifest.json#x', 'character-pack://u:p@pack/manifest.json', 'character-pack://pack:1/manifest.json',
  'character-pack:pack/manifest.json', 'chat-asset://pack/manifest.json', 'bogus', ''];

async function run(register, url) {
  let h; register({ handle: (_s, fn) => (h = fn) });
  let req; try { req = new Request(url); } catch { return { request: 'invalid' }; }
  const res = await h(req);
  const headers = {}; res.headers.forEach((v, k) => (headers[k] = v));
  return { status: res.status, headers, body: Buffer.from(await res.arrayBuffer()).toString('latin1') };
}
const chatRoot = join(R, 'chat'), preset = join(R, 'res/backgrounds/nomi-preset.jpg');
const chat = [];
for (const u of chatUrls) {
  chat.push({ url: u, resolved: rel(await ca.resolveChatAssetUrl(chatRoot, u, preset)),
    response: await run((p) => ca.registerChatAsset(p, chatRoot, preset), u) });
}
const pack = [];
for (const u of packUrls) {
  pack.push({ url: u, resolved: rel(await pp.resolveCharacterPackUrl(join(R, 'pack'), u)), noRoot: await pp.resolveCharacterPackUrl(null, u),
    response: await run((p) => pp.registerCharacterPackProtocol(p, () => join(R, 'pack')), u) });
}
const noRootResp = await run((p) => pp.registerCharacterPackProtocol(p, () => null), 'character-pack://pack/manifest.json');
const mimes = ['a.png', 'a.PNG', 'a.jpg', 'a.jpeg', 'a.webp', 'a.gif', 'a.mp3', 'a.wav', 'a.json', 'a.riv', 'a.md', 'a.txt', 'a', '.png', 'a.tar.gz', 'dir.d/a'];
const mime = mimes.map((f) => ({ file: f, pack: pp.characterPackMimeFor(f), chat: ca.chatAssetMimeFor(f) }));
// NOMI_GOLDEN_DIR：CI 在 mac/win 上现场录制到该目录（Go 测试经 NOMI_LIVE_GOLDENS 读取），不覆盖提交的 Linux golden
const outDir = process.env.NOMI_GOLDEN_DIR || join(root, 'apps/desktop-go/internal/core/assetproto/testdata');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'protocols.json'),
  JSON.stringify({ tree, chat, pack, noRootResp, mime }, null, 1) + '\n');
console.log(process.platform, 'protocols: chat', chat.length, 'pack', pack.length, 'mime', mime.length);
