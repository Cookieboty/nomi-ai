import { createTsup } from '../../../../tsup.base';

export default createTsup({
  preset: 'node-lib',
  entry: { index: 'src/index.ts', 'testing/index': 'src/testing/index.ts' },
});
