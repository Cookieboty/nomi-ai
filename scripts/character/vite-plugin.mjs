/**
 * Vite plugin: serve / emit the selected character pack (CHARACTER_PACK or characters/nomi).
 *
 * The pack is read in place — nothing in the source tree is overwritten:
 *   - dev: files are served under `/character/…` straight from the pack directory;
 *   - build: files are emitted into `dist/character/…` (electron-builder ships renderer/dist as
 *     resources/renderer, so the packaged app's built-in pack is resources/renderer/character).
 *
 * `scope: 'all'` (renderer) ships the whole pack, exposes `virtual:character-pack` (the normalized
 * pack data), `virtual:character-static-art` (the selected pack's low-resource static art, see
 * `staticArtModule`) and the bundled `assets/models/model-list.json`. `scope: 'onboarding'`
 * (ai-chat) ships only the onboarding illustrations, at `character/onboarding/<file>`.
 */
import { createReadStream, readFileSync } from 'node:fs';
import { extname, join, sep } from 'node:path';

import { isOfficialPack, listPackFiles, loadPack, modelListFor, remoteFilesOf } from './pack.mjs';
import { DEFAULT_PACK_STATIC_ART, selectedPackDir } from './paths.mjs';

export const VIRTUAL_ID = 'virtual:character-pack';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
export const STATIC_ART_ID = 'virtual:character-static-art';
const RESOLVED_STATIC_ART_ID = `\0${STATIC_ART_ID}`;
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

/**
 * `virtual:character-static-art`: the static art the desktop character shows when the renderer
 * setting is `svg` (the default), as a URL — or null when the selected pack has none, in which case
 * the view keeps the pack's own mode. It always belongs to the selected pack, never to another one:
 *   - a static pack: its own static image (`./character/<assets.static>`);
 *   - the official pack (Rive): its SVG static art, emitted as a separate asset (`?url`);
 *   - any other pack: null.
 */
export function staticArtModule(dir, pack) {
  if (pack.assets.static) {
    return `export default ${JSON.stringify(`./${PACK_URL_PREFIX}${pack.assets.static}`)};\n`;
  }
  if (isOfficialPack(dir)) {
    const file = DEFAULT_PACK_STATIC_ART.split(sep).join('/');
    return `export { default } from ${JSON.stringify(`${file}?url`)};\n`;
  }
  return 'export default null;\n';
}

/**
 * pack-relative path → published path (under `character/`). Remote assets (manifest
 * `assets.remote`, e.g. the official .riv) are not shipped: the kernel downloads them on demand.
 */
export function publishedFiles(dir, pack, scope) {
  if (scope === 'onboarding') {
    return ONBOARDING.map((f) => [`${pack.assets.onboardingDir}/${f}`, `onboarding/${f}`]);
  }
  const remote = new Set(remoteFilesOf(pack).map((r) => r.rel));
  return listPackFiles(dir)
    .filter((f) => !remote.has(f))
    .map((f) => [f, f]);
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
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      if (id === STATIC_ART_ID && scope === 'all') return RESOLVED_STATIC_ART_ID;
      return null;
    },
    async load(id) {
      if (id === RESOLVED_STATIC_ART_ID) {
        const { pack } = await load();
        this.addWatchFile(join(dir, 'manifest.json'));
        return staticArtModule(dir, pack);
      }
      if (id !== RESOLVED_ID) return null;
      const { pack } = await load();
      for (const f of ['manifest.json', 'persona.json', 'mapping.json']) {
        this.addWatchFile(join(dir, f));
      }
      return `export default ${JSON.stringify(packModuleData(pack))};\n`;
    },
    configureServer(server) {
      // 开发服务器带 base 时（Go 宿主开发态 /mascot/、/chat/）请求路径带前缀；Electron 开发态 base 为 /
      const base = server.config.base || '/';
      server.middlewares.use(async (req, res, next) => {
        let url = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
        if (base !== '/' && url.startsWith(base)) url = `/${url.slice(base.length)}`;
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
