/**
 * avatar-runtime 的独立开发页（不经 renderer / 契约 / Electron）：
 *   pnpm --filter @nomi-ai/avatar-runtime demo                     # characters/test-dummy
 *   AVATAR_DEMO_PACK=characters/nomi pnpm --filter @nomi-ai/avatar-runtime demo
 * 角色包经 scripts/character/vite-plugin.mjs 直接读（`/character/…` + `virtual:character-pack`）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// @ts-expect-error -- plain .mjs build helpers without type declarations
import { characterPackPlugin } from '../../../scripts/character/vite-plugin.mjs';
// @ts-expect-error -- plain .mjs build helpers without type declarations
import { DEV_HOST, PORTS } from '../../../scripts/ports.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const packDir = path.resolve(repo, process.env.AVATAR_DEMO_PACK ?? 'characters/test-dummy');

export default defineConfig({
  root: here,
  base: './',
  plugins: [react(), characterPackPlugin({ scope: 'all', packDir })],
  server: { host: DEV_HOST, port: PORTS.demo, open: false },
  build: { outDir: path.join(here, 'dist'), emptyOutDir: true },
});
