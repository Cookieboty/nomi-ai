/**
 * `virtual:character-pack` — the character pack this build ships, normalized by validatePack
 * (scripts/character/vite-plugin.mjs). Paths in `assets` are relative to `base`.
 */
declare module 'virtual:character-pack' {
  import type {
    CharacterLocaleData,
    NormalizedPack,
    PackCapabilities,
    PackLayout,
    PackMapping,
    PersonaData,
  } from '@nomi-ai/character-contract';

  const pack: {
    id: string;
    mode: NormalizedPack['mode'];
    /** URL prefix of the bundled pack files, e.g. `./character/` */
    base: string;
    rive: { artboard?: string; stateMachine?: string } | null;
    defaults: { voiceHint?: string; voiceRate?: number; voicePitch?: number } & Record<
      string,
      unknown
    >;
    capabilities: PackCapabilities;
    layout: PackLayout;
    persona: PersonaData | null;
    locales: Partial<Record<string, CharacterLocaleData>>;
    mapping: PackMapping | null;
    assets: NormalizedPack['assets'];
  };
  export default pack;
}

/**
 * `virtual:character-static-art` — the selected pack's static art for the default `svg` renderer
 * (scripts/character/vite-plugin.mjs `staticArtModule`): a URL, or null when the pack has none.
 */
declare module 'virtual:character-static-art' {
  const url: string | null;
  export default url;
}
