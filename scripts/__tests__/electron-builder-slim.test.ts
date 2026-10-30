import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';

import {
  createPackage,
  createPackageWithOptions,
  extractFile,
  getRawHeader,
  uncache,
} from '@electron/asar';
import { minimatch } from 'minimatch';
import { describe, expect, it } from 'vitest';

import afterPack, {
  collectRelFiles,
  headerEntry,
  missingUnpackedEntries,
} from '../../apps/desktop-electron/scripts/after-pack-slim.mjs';

const yml = readFileSync(
  join(__dirname, '../../apps/desktop-electron/electron-builder.yml'),
  'utf8',
);

describe('electron-builder slim (2.0.5 easy wins)', () => {
  it('registers afterPack slim hook', () => {
    expect(yml).toMatch(/afterPack:\s*\.\/scripts\/after-pack-slim\.mjs/);
  });

  it('excludes assets from asar (extraResources only)', () => {
    expect(yml).toMatch(/'!assets\/\*\*'/);
    // 不再把 assets 正向打进 asar
    expect(yml).not.toMatch(/^\s*- assets\/\*\*\/?\*?$/m);
  });

  it('excludes zlibjs unused bins and i18n src/dist', () => {
    expect(yml).toMatch(/zlibjs\/bin\/\*\.dev\.js/);
    expect(yml).toMatch(/@nomi-ai\/i18n\/src/);
    expect(yml).toMatch(/@nomi-ai\/i18n\/dist/);
  });

  it('excludes mobile and other-platform bare-* prebuilds in files filter', () => {
    expect(yml).toMatch(/bare-\*\/prebuilds\/android-\*\/\*\*/);
    expect(yml).toMatch(/bare-\*\/prebuilds\/ios-\*\/\*\*/);
    const line =
      /'(!\*\*\/node_modules\/bare-\*\/prebuilds\/!\(\$\{platform\}-\$\{arch\}\)\/\*\*)'/.exec(yml);
    expect(line).not.toBeNull();
    // electron-builder 按目标展开宏后，用 minimatch（extglob）判断：只留下当前平台 + 架构
    const pattern = line![1]!.slice(1).replace('${platform}', 'darwin').replace('${arch}', 'arm64');
    const dropped = (p: string) => minimatch(p, pattern, { dot: true });
    expect(dropped('node_modules/bare-fs/prebuilds/darwin-x64/bare-fs.bare')).toBe(true);
    expect(dropped('node_modules/bare-fs/prebuilds/win32-x64/bare-fs.bare')).toBe(true);
    expect(dropped('node_modules/bare-fs/prebuilds/darwin-arm64/bare-fs.bare')).toBe(false);
    expect(dropped('node_modules/bare-fs/index.js')).toBe(false);
  });

  it('keeps asarUnpack for onnx + tesseract (disk load)', () => {
    expect(yml).toMatch(/asarUnpack:[\s\S]*onnxruntime-web\/dist/);
    expect(yml).toMatch(/asarUnpack:[\s\S]*tesseract\.js-core/);
  });
});

describe('after-pack-slim on a real asar (#188)', () => {
  /** 用 @electron/asar 打一个带 unpacked 条目的小包，形状同 electron-builder 的 asarUnpack */
  async function buildApp() {
    const dir = mkdtempSync(join(tmpdir(), 'nomi-afterpack-'));
    const src = join(dir, 'src');
    const files: Record<string, string> = {
      'package.json': '{"name":"app","main":"dist/main.js"}',
      'dist/main.js': 'module.exports = 1',
      'node_modules/tesseract.js/package.json': '{"name":"tesseract.js","main":"src/index.js"}',
      'node_modules/tesseract.js/src/index.js': 'module.exports = "ocr"',
      'node_modules/tesseract.js-core/tesseract-core-relaxedsimd.wasm': 'wasm',
      'node_modules/onnxruntime-web/package.json': '{"name":"onnxruntime-web"}',
      'node_modules/onnxruntime-web/dist/ort.node.min.js': 'module.exports = "ort"',
      'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm': 'wasm',
      'node_modules/bare-fs/prebuilds/darwin-arm64/bare-fs.bare': 'bin',
    };
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(src, rel, '..'), { recursive: true });
      writeFileSync(join(src, rel), body);
    }
    const resources = join(dir, 'Resources');
    mkdirSync(resources);
    const asarPath = join(resources, 'app.asar');
    await createPackageWithOptions(src, asarPath, {
      unpack: '**/node_modules/onnxruntime-web/dist/**',
      unpackDir: '**/node_modules/{tesseract.js,tesseract.js-core}',
    });
    uncache(asarPath);
    const context = {
      appOutDir: dir,
      packager: { getResourcesDir: () => resources },
    } as unknown as Parameters<typeof afterPack>[0];
    return { dir, resources, asarPath, unpackedDir: `${asarPath}.unpacked`, context };
  }

  const UNPACKED = [
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
    'node_modules/onnxruntime-web/dist/ort.node.min.js',
    'node_modules/tesseract.js-core/tesseract-core-relaxedsimd.wasm',
    'node_modules/tesseract.js/package.json',
    'node_modules/tesseract.js/src/index.js',
  ];

  it('leaves the archive untouched and the unpacked entries flagged in the header', async () => {
    const t = await buildApp();
    try {
      const before = readFileSync(t.asarPath);
      expect([...collectRelFiles(t.unpackedDir)].sort()).toEqual(UNPACKED);
      await afterPack(t.context);
      // 不重建：字节完全一致
      expect(readFileSync(t.asarPath).equals(before)).toBe(true);
      uncache(t.asarPath);
      const { header } = getRawHeader(t.asarPath);
      for (const rel of UNPACKED) {
        const e = headerEntry(header, rel);
        expect(e, rel).toBeDefined();
        expect(e.unpacked, rel).toBe(true);
        // unpacked 条目的内容只在 .unpacked 目录里：按原路径读得到（extractFile 按本平台分隔符切路径）
        expect(extractFile(t.asarPath, normalize(rel)).toString()).toBe(
          readFileSync(join(t.unpackedDir, rel), 'utf8'),
        );
      }
      // 普通文件仍在 asar 数据区
      expect(headerEntry(header, 'dist/main.js').unpacked).toBeUndefined();
      expect(missingUnpackedEntries(t.asarPath, t.unpackedDir)).toEqual([]);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('fails the build when the header lost unpacked entries (the old dedupe-and-rebuild)', async () => {
    const t = await buildApp();
    try {
      // 复现旧做法：从去掉 unpacked 文件的树不带 unpack 选项重建，header 里就没有这些条目了
      const tree = join(t.dir, 'rebuilt');
      mkdirSync(join(tree, 'dist'), { recursive: true });
      writeFileSync(join(tree, 'package.json'), '{}');
      writeFileSync(join(tree, 'dist', 'main.js'), 'module.exports = 1');
      rmSync(t.asarPath);
      await createPackage(tree, t.asarPath);
      expect(missingUnpackedEntries(t.asarPath, t.unpackedDir)).toEqual(UNPACKED);
      await expect(afterPack(t.context)).rejects.toThrow(/lacks 5 unpacked entries/);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('collectRelFiles lists nested files as posix paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'nomi-collect-'));
    try {
      mkdirSync(join(root, 'a', 'b'), { recursive: true });
      writeFileSync(join(root, 'a', 'b', 'c.txt'), 'c');
      writeFileSync(join(root, 'd.txt'), 'd');
      const set = collectRelFiles(root);
      expect([...set].sort()).toEqual(['a/b/c.txt', 'd.txt']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
