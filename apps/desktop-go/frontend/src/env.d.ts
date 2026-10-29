/// <reference types="vite/client" />
/// <reference types="vite/client" />
declare module 'virtual:character-pack' {
  const pack: import('@nomi-ai/character-contract').CharacterPack & { base: string };
  export default pack;
}
