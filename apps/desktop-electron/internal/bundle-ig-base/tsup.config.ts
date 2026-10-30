import { createTsup } from '../../../../tsup.base';

export default createTsup({
  preset: 'node-lib',
  entry: ['src/index.ts', 'src/types/index.ts'],
});
