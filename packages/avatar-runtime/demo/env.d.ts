/// <reference types="vite/client" />

/** scripts/character/vite-plugin.mjs：所选角色包规范化后的数据（与 renderer 的声明同形） */
declare module 'virtual:character-pack' {
  import type {
    NormalizedPack,
    PackCapabilities,
    PackLayout,
    PackMapping,
  } from '@nomi-ai/character-contract';

  const pack: {
    id: string;
    mode: NormalizedPack['mode'];
    base: string;
    rive: { artboard?: string; stateMachine?: string } | null;
    capabilities: PackCapabilities;
    layout: PackLayout;
    mapping: PackMapping | null;
    assets: NormalizedPack['assets'];
  };
  export default pack;
}
