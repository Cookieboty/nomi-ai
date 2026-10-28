import { createTsup } from '../../tsup.base';

export default createTsup({
  preset: 'node-lib',
  entry: ['src/index.ts'],
  external: ['@nomi-ai/ai-sdk', '@nomi-ai/bundle-ig-base'],
});
