declare module 'unbzip2-stream' {
  import type { Transform } from 'node:stream';
  function unbzip2(): Transform;
  export = unbzip2;
}
