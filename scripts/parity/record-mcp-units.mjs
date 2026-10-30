import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
// Unit fixtures for internal/ai/mcp: cross-spawn escape (argv[2] = cross-spawn package dir) + eventsource-parser 3.1.1.
// Usage: node scripts/parity/record-mcp-units.mjs <cross-spawn-dir> > apps/desktop-go/internal/ai/mcp/testdata/units.json
const r0 = createRequire(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../apps/desktop-electron/internal/ai-runtime/package.json',
  ),
);
const mcp = path.dirname(r0.resolve('@ai-sdk/mcp/package.json'));
const r1 = createRequire(path.join(mcp, 'package.json'));
const pu = path.dirname(r1.resolve('@ai-sdk/provider-utils/package.json'));
const r2 = createRequire(path.join(pu, 'package.json'));
const epj = r2.resolve('eventsource-parser/package.json');
console.error(JSON.parse((await import('node:fs')).readFileSync(epj, 'utf8')).version);
const { createParser } = await import(pathToFileURL(r2.resolve('eventsource-parser')).href);
const e = createRequire(import.meta.url)(process.argv[2] + '/lib/util/escape.js');
const args = ['a b', 'x"y', 'back\\slash\\', '100%', '&|<>^', '', 'a\\"b', '"'];
const esc = args.map((a) => [a, e.argument(a, false), e.argument(a, true)]);
const chunks = [
  ['\u00ef\u00bb\u00bfdata: a\n\n'],
  ['data: x\r\nda', 'ta: y\r\n\r\nevent: e\nid: 7\ndata:z\n\n', ': c\nfoo: 1\ndata: tail'],
  ['data\n\nid: a\u0000b\ndata: q\n\nretry: 5\ndata:  sp\r\r'],
];
const sse = chunks.map((cs) => {
  const ev = [];
  const p = createParser({ onEvent: (x) => ev.push(x) });
  cs.forEach((c) => p.feed(c));
  return { chunks: cs, events: ev };
});
console.log(JSON.stringify({ escape: esc, sse }, null, 1));
