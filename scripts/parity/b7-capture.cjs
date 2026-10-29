/**
 * 批次 7 语料采集（jest setupFilesAfterEnv）：包住 @nomi-ai/cli-plugins/main 的流解析器，
 * 把每个解析器实例收到的行写到 $B7_CAPTURE（JSONL）。record-b7.mjs 再在 Node 里重放录 golden。
 */
const fs = jest.requireActual('node:fs'); // tests/setup.ts 全局 mock 了 fs
const out = process.env.B7_CAPTURE;
let seq = 0;
const log = (o) => fs.appendFileSync(out, JSON.stringify(o) + '\n');
jest.mock('@nomi-ai/cli-plugins/main', () => {
  const real = jest.requireActual('@nomi-ai/cli-plugins/main');
  const file = expect.getState().testPath ?? '';
  const wrapped = { ...real };
  const states = new WeakMap();
  for (const fn of ['parseClaudeLine', 'parseCodexLine', 'parseGrokLine', 'parseDshLine']) {
    wrapped[fn] = (line, state) => {
      if (state && typeof state === 'object') {
        if (!states.has(state)) states.set(state, `${fn}#${++seq}`);
        log({ file, fn: `${fn}+state`, id: states.get(state), line });
      } else log({ file, fn, id: `${fn}#${++seq}`, line });
      return real[fn](line, state);
    };
  }
  for (const fn of ['createClaudeParser', 'createCodexParser', 'createGrokParser', 'createDshParser']) {
    if (!real[fn]) continue;
    wrapped[fn] = (...a) => {
      const id = `${fn}#${++seq}`;
      const p = real[fn](...a);
      return (line) => {
        log({ file, fn, id, line });
        return p(line);
      };
    };
  }
  return wrapped;
});
