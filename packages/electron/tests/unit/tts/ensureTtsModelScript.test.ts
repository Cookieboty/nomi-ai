jest.unmock('fs');
jest.unmock('path');

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  SHERPA_ARCHIVE_BYTES,
  SHERPA_ARCHIVE_SHA256,
  SHERPA_MODEL_ID,
  SHERPA_MODEL_URL,
  SHERPA_REQUIRED_FILES,
} from '../../../src/tts/sherpa/manifest';

const script = path.resolve(__dirname, '../../../scripts/ensure-tts-model.mjs');
const src = fs.readFileSync(script, 'utf8');

describe('scripts/ensure-tts-model.mjs', () => {
  it('manifest constants stay in sync with src/tts/sherpa/manifest.ts', () => {
    expect(src).toContain(`const MODEL_ID = '${SHERPA_MODEL_ID}'`);
    expect(src).toContain(SHERPA_MODEL_URL);
    expect(src).toContain(`const MODEL_SHA256 = '${SHERPA_ARCHIVE_SHA256}'`);
    expect(src).toContain(`const MODEL_BYTES = ${SHERPA_ARCHIVE_BYTES}`);
    const block = src.slice(src.indexOf('const REQUIRED = '), src.indexOf('const args = '));
    const files: Record<string, number> = {};
    for (const m of block.matchAll(/'([^']+)':\s*(\d+)/g)) files[m[1]!] = Number(m[2]);
    expect(files).toEqual(SHERPA_REQUIRED_FILES);
  });

  it('NOMI_SKIP_TTS_MODEL=1 skips without touching anything and exits 0', () => {
    const out = execFileSync(process.execPath, [script], {
      env: { ...process.env, NOMI_SKIP_TTS_MODEL: '1' },
      encoding: 'utf8',
    });
    expect(out).toMatch(/NOMI_SKIP_TTS_MODEL=1/);
  });

  const run = (args: string[], env: Record<string, string | undefined>) => {
    const e: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ['CI', 'NOMI_SKIP_TTS_MODEL', 'NOMI_SKIP_MODEL_DOWNLOAD']) delete e[k];
    for (const [k, v] of Object.entries(env)) if (v !== undefined) e[k] = v;
    return execFileSync(process.execPath, [script, ...args], { env: e, encoding: 'utf8' });
  };
  const evalScript = (code: string) =>
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import * as m from ${JSON.stringify(pathToFileURL(script).href)};\n${code}`,
      ],
      { encoding: 'utf8' },
    ).trim();
  /** 按清单建一个「大小全对」的模型目录（稀疏文件，不占真实空间） */
  const fakeModel = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-model-'));
    for (const [rel, bytes] of Object.entries(SHERPA_REQUIRED_FILES)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      const fd = fs.openSync(path.join(dir, rel), 'w');
      fs.ftruncateSync(fd, bytes);
      fs.closeSync(fd);
    }
    return dir;
  };

  it('NOMI_SKIP_MODEL_DOWNLOAD=1 opts out', () => {
    expect(run(['--postinstall'], { NOMI_SKIP_MODEL_DOWNLOAD: '1' })).toMatch(
      /NOMI_SKIP_MODEL_DOWNLOAD=1，跳过/,
    );
  });

  it('postinstall skips on CI unless explicitly opted in', () => {
    expect(run(['--postinstall'], { CI: 'true' })).toMatch(/CI 环境：postinstall 跳过模型下载/);
    const reason = (env: Record<string, string>, postinstall: boolean) =>
      evalScript(
        `console.log(JSON.stringify(m.skipReason(${JSON.stringify(env)}, { postinstall: ${postinstall} })))`,
      );
    expect(reason({ CI: 'true' }, true)).toBe('"CI"');
    expect(reason({ CI: '1' }, true)).toBe('"CI"');
    expect(reason({ CI: 'false' }, true)).toBe('null');
    // pnpm dev 的兜底不受 CI 影响
    expect(reason({ CI: 'true' }, false)).toBe('null');
    expect(reason({ CI: 'true', NOMI_SKIP_MODEL_DOWNLOAD: '0' }, true)).toBe('null');
    expect(reason({ NOMI_SKIP_MODEL_DOWNLOAD: 'true' }, false)).toBe(
      '"NOMI_SKIP_MODEL_DOWNLOAD=1"',
    );
    expect(reason({}, true)).toBe('null');
  });

  it('a complete model (sizes + version marker) is detected without downloading', () => {
    const dir = fakeModel();
    const verify = () =>
      evalScript(`console.log(JSON.stringify(m.verify(${JSON.stringify(dir)})))`);
    // 没有标记（旧版本 / 手动解压）：大小全对即可
    expect(verify()).toBe('[]');
    const out = run(['--check'], { NOMI_SHERPA_TTS_MODEL_DIR: dir });
    expect(out).toContain(`ok (NOMI_SHERPA_TTS_MODEL_DIR): ${dir}`);
    // 用户自己的目录不写标记
    expect(fs.existsSync(path.join(dir, '.nomi-model.json'))).toBe(false);
    fs.writeFileSync(
      path.join(dir, '.nomi-model.json'),
      JSON.stringify({ id: SHERPA_MODEL_ID, sha256: SHERPA_ARCHIVE_SHA256 }),
    );
    expect(verify()).toBe('[]');
    // 版本标记对不上（模型换了版本）：视为不完整，需要重新下载
    fs.writeFileSync(
      path.join(dir, '.nomi-model.json'),
      JSON.stringify({ id: SHERPA_MODEL_ID, sha256: 'old' }),
    );
    expect(verify()).toBe('[".nomi-model.json"]');
    fs.rmSync(path.join(dir, 'tokens.txt'));
    expect(verify()).toContain('tokens.txt');
  });

  it('is wired into postinstall and dev', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.postinstall).toMatch(/ensure-tts-model\.mjs/);
    const dev = fs.readFileSync(path.resolve(__dirname, '../../../scripts/dev.mjs'), 'utf8');
    expect(dev).toMatch(/ensure-tts-model\.mjs/);
    void os;
  });
});
