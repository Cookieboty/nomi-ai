import {
  LOCAL_LLMS,
  LLAMA_RUNTIME,
  fitLevel,
  recommend,
  runtimeFor,
  serverArgs,
} from '../../../src/local/llmCatalog';

describe('llmCatalog', () => {
  it('只收录宽松许可证、带校验值的模型', () => {
    for (const m of LOCAL_LLMS) {
      expect(['Apache-2.0', 'MIT']).toContain(m.license);
      expect(m.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(m.bytes).toBeGreaterThan(1e8);
      expect(m.url).toMatch(/^https:\/\/huggingface\.co\/.+\.gguf$/);
      expect(m.family).not.toMatch(/llama|gemma/i);
    }
    expect(LLAMA_RUNTIME.license).toBe('MIT');
    for (const a of LLAMA_RUNTIME.assets) expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('按内存推荐', () => {
    expect(recommend(2).id).toBe(LOCAL_LLMS[0].id);
    const big = recommend(64);
    expect(big.minRamGb).toBeLessThanOrEqual(64);
    expect(recommend(8).minRamGb).toBeLessThanOrEqual(8);
    expect(recommend(8).minRamGb).toBeGreaterThanOrEqual(recommend(4).minRamGb);
  });
  it('fitLevel', () => {
    const m = { ...LOCAL_LLMS[0], minRamGb: 8 };
    expect(fitLevel(m, 16)).toBe('ok');
    expect(fitLevel(m, 6)).toBe('tight');
    expect(fitLevel(m, 4)).toBe('too-big');
  });
  it('运行时平台与参数', () => {
    expect(runtimeFor('linux', 'x64')?.archive).toBe('tar.gz');
    expect(runtimeFor('win32', 'x64')?.archive).toBe('zip');
    expect(runtimeFor('freebsd', 'x64')).toBeNull();
    const a = serverArgs({ model: '/m.gguf', port: 1234, ctx: 4096, threads: 4 });
    expect(a).toEqual(expect.arrayContaining(['--host', '127.0.0.1', '--port', '1234', '-t', '4']));
  });
});
