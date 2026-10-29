#!/usr/bin/env node
/** chatBg golden parity：@nomi-ai/types sanitizeChatBg 在 Node 上的输出 → apps/desktop-go/internal/core/chatbg/testdata/sanitize.json
 *  用法：pnpm exec tsx scripts/parity/record-chatbg.mjs */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { sanitizeChatBg } = await import(pathToFileURL(join(root, 'packages/types/src/chatBackground.ts')).href);
const vals = [undefined, null, 0, -1, 0.01, 0.05, 0.5, 1, 1.5, 8, 40, 41, -0, 1e308, '3', true, [], {}, 'chat-asset://images/panel-bg.a.png',
  'chat-asset://presets/background.jpg', 'chat-asset://presets/other.jpg', 'http://x', '', 'chat-asset://images/'];
const cases = [];
for (const imageUrl of vals) for (const blur of vals.slice(0, 18)) for (const opacity of [undefined, 0, 0.01, 0.3, 1, 2, 'x', null]) {
  const input = JSON.stringify({ imageUrl, blur, opacity });
  cases.push({ input, out: JSON.stringify(sanitizeChatBg(JSON.parse(input))) });
}
for (const raw of ['null', '[]', '1', '"s"', 'true', '[1,2]']) cases.push({ input: raw, out: JSON.stringify(sanitizeChatBg(JSON.parse(raw))) });
writeFileSync(join(root, 'apps/desktop-go/internal/core/chatbg/testdata/sanitize.json'), JSON.stringify(cases).replace(/},{/g, '},\n{') + '\n');
console.log('chatbg sanitize:', cases.length);
