import { createTsup } from '../../../../tsup.base';

export default createTsup({
  preset: 'node-lib',
  entry: ['src/index.ts', 'src/seams/index.ts'],
  external: ['@nomi-ai/bundle-ig-base', 'electron', '@picovoice/porcupine-node', 'nodejs-whisper'],
});
