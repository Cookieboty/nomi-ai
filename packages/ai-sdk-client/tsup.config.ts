import { createTsup } from '../../tsup.base';

export default createTsup({
  preset: 'react-lib',
  entry: ['src/index.ts', 'src/react/index.ts'],
  external: ['react', 'react-dom'],
  format: ['esm'],
});
