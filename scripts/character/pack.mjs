/**
 * Read and validate a character pack directory (validatePackDir from @nomi-ai/character-contract)
 * and derive the data the views need from it.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadContract } from './contract.mjs';
import { DEFAULT_PACK_DIR, rel } from './paths.mjs';

export function formatIssues(result) {
  const lines = [];
  for (const e of result.errors) lines.push(`  error: ${e.file}: ${e.message}`);
  for (const w of result.warnings) lines.push(`  warn: ${w.file}: ${w.message}`);
  return lines.join('\n');
}

/** The official pack must ship every contract voice clip. */
export function isOfficialPack(dir) {
  return join(dir) === join(DEFAULT_PACK_DIR);
}

/**
 * Validate `dir` and return the normalized pack. Throws with the issue list when it is invalid,
 * so a build never ships a broken pack.
 */
export async function loadPack(dir) {
  const { validatePackDir } = await loadContract();
  const result = await validatePackDir(dir, { requireCompleteVoice: isOfficialPack(dir) });
  if (!result.ok || !result.pack) {
    throw new Error(`invalid character pack ${rel(dir)}\n${formatIssues(result)}`);
  }
  return { dir, result, pack: result.pack };
}

/** Every file in the pack, as `/`-separated paths relative to the pack root. */
export function listPackFiles(dir) {
  const out = [];
  const walk = (d, base) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.DS_Store') continue;
      const relPath = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), relPath);
      else if (e.isFile()) out.push(relPath);
    }
  };
  walk(dir, '');
  return out.sort();
}

function localizedName(persona, locales) {
  const zh = persona?.displayName;
  const en = locales.en?.persona?.displayName;
  if (zh && en && zh !== en) return `${en}·${zh}`;
  return en || zh || null;
}

/**
 * Bundled model list (renderer `assets/models/model-list.json`): one entry, the selected pack.
 * `base` is the URL prefix the pack is served under (relative to the renderer page).
 * `manifest.catalog` (displayName / description / author / tags / version / lastUpdated) overrides
 * the derived values, so the official pack keeps the list it shipped with on 2.0.5.
 */
export function modelListFor(pack, base = './character/') {
  const m = pack.manifest;
  const credits = m.credits && typeof m.credits === 'object' ? m.credits : {};
  const catalog = m.catalog ?? {};
  const defaults = m.defaults ?? {};
  const name = catalog.displayName || localizedName(pack.persona, pack.locales) || m.id;
  const spriteDir = pack.assets.spriteManifest?.replace(/\/manifest\.json$/, '');
  const entry = {
    name: m.id,
    displayName: name,
    description: catalog.description || name,
    path: pack.assets.spriteManifest ? `${base}${pack.assets.spriteManifest}` : '',
    ...(spriteDir ? { thumbnail: `${base}${spriteDir}/thumb.png` } : {}),
    author: catalog.author || credits.author || '',
    license: credits.license || '',
    source: credits.source || '',
    tags: catalog.tags ?? ['default', pack.mode],
    config: {
      voice: {
        voiceHint: defaults.voiceHint || 'xiaoxiao',
        rate: defaults.voiceRate ?? 0.92,
        pitch: defaults.voicePitch ?? 1.1,
      },
    },
  };
  if (!entry.path) entry.path = `${base}manifest.json`;
  return {
    models: [entry],
    ...(catalog.lastUpdated ? { lastUpdated: catalog.lastUpdated } : {}),
    version: catalog.version || '4.0.0',
  };
}
