/**
 * Vite plugin: serve / emit the selected character pack (CHARACTER_PACK or characters/nomi).
 *
 * The pack is read in place — nothing in the source tree is overwritten:
 *   - dev: files are served under `/character/…` straight from the pack directory;
 *   - build: files are emitted into `dist/character/…` (electron-builder ships renderer/dist as
 *     resources/renderer, so the packaged app's built-in pack is resources/renderer/character).
 *
 * `scope: 'all'` (renderer) ships the whole pack, exposes `virtual:character-pack` (the normalized
 * pack data) and the bundled `assets/models/model-list.json`. `scope: 'onboarding'` (ai-chat)
 * ships only the onboarding illustrations, at `character/onboarding/<file>`.
 */
import { createReadStream, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import { listPackFiles, loadPack, modelListFor } from './pack.mjs';
import { selectedPackDir } from './paths.mjs';

export const VIRTUAL_ID = 'virtual:character-pack';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
export const PACK_URL_PREFIX = 'character/';
const MODEL_LIST = 'assets/models/model-list.json';
const ONBOARDING = ['welcome.webp', 'profile.webp', 'provider.webp', 'privacy.webp'];

const MIME = {
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Data the renderer reads at runtime (no file system access in the view). */
export function packModuleData(pack) {
  const m = pack.manifest;
  return {
    id: m.id,
    mode: pack.mode,
    base: `./${PACK_URL_PREFIX}`,
    rive: m.rive ?? null,
    defaults: m.defaults ?? {},
    capabilities: m.capabilities ?? {},
    layout: pack.layout,
    persona: pack.persona,
    locales: pack.locales,
    mapping: pack.mapping,
    assets: pack.assets,
  };
}

/** pack-relative path → published path (under `character/`), or null when not shipped. */
export function publishedFiles(dir, pack, scope) {
  if (scope === 'onboarding') {
    return ONBOARDING.map((f) => [`${pack.assets.onboardingDir}/${f}`, `onboarding/${f}`]);
  }
  return listPackFiles(dir).map((f) => [f, f]);
}

/** @param {{ scope?: 'all' | 'onboarding', packDir?: string }} [opts] */
export function characterPackPlugin(opts = {}) {
  const scope = opts.scope ?? 'all';
  const dir = opts.packDir ?? selectedPackDir();
  let loaded = null;
  const load = () => (loaded ??= loadPack(dir));

  return {
    name: 'nomi-character-pack',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null;
      const { pack } = await load();
      for (const f of ['manifest.json', 'persona.json', 'mapping.json']) {
        this.addWatchFile(join(dir, f));
      }
      return `export default ${JSON.stringify(packModuleData(pack))};\n`;
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
        try {
          const { pack } = await load();
          if (scope === 'all' && url === `/${MODEL_LIST}`) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(modelListFor(pack)));
            return;
          }
          if (!url.startsWith(`/${PACK_URL_PREFIX}`)) return next();
          const wanted = url.slice(PACK_URL_PREFIX.length + 1);
          const hit = publishedFiles(dir, pack, scope).find(([, out]) => out === wanted);
          if (!hit) return next();
          res.setHeader('Content-Type', MIME[extname(hit[1])] ?? 'application/octet-stream');
          createReadStream(join(dir, ...hit[0].split('/'))).pipe(res);
        } catch (err) {
          next(err);
        }
      });
    },
    async generateBundle() {
      const { pack } = await load();
      for (const [src, out] of publishedFiles(dir, pack, scope)) {
        this.emitFile({
          type: 'asset',
          fileName: `${PACK_URL_PREFIX}${out}`,
          source: readFileSync(join(dir, ...src.split('/'))),
        });
      }
      if (scope === 'all') {
        this.emitFile({
          type: 'asset',
          fileName: MODEL_LIST,
          source: `${JSON.stringify(modelListFor(pack), null, 2)}\n`,
        });
      }
    },
  };
}
