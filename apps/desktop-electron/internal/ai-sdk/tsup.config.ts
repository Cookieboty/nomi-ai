import { createTsup } from '../../../../tsup.base';

export default createTsup({
  preset: 'node-lib',
  entry: ['src/index.ts', 'src/types/index.ts', 'src/config/index.ts'],
  external: [
    '@nomi-ai/bundle-ig-base',
    '@nomi-ai/bundle-ig-mascot',
    '@nomi-ai/bundle-ig-electron-caps',
  ],
});
