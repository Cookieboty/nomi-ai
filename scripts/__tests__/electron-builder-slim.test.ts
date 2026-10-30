import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  archToName,
  barePrebuildKeepName,
  shouldDropBarePrebuildDir,
  shouldDropZlibjsBin,
  shouldDropI18nPath,
  slimNodeModulesTree,
  dropUnpackedDuplicates,
  collectRelFiles,
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

  it('excludes mobile bare-* prebuilds in files filter', () => {
    expect(yml).toMatch(/bare-\*\/prebuilds\/android-\*\/\*\*/);
    expect(yml).toMatch(/bare-\*\/prebuilds\/ios-\*\/\*\*/);
  });

  it('keeps asarUnpack for onnx + tesseract (disk load)', () => {
    expect(yml).toMatch(/asarUnpack:[\s\S]*onnxruntime-web\/dist/);
    expect(yml).toMatch(/asarUnpack:[\s\S]*tesseract\.js-core/);
  });
});

describe('after-pack-slim helpers', () => {
  it('archToName maps builder-util Arch enums', () => {
    expect(archToName(1)).toBe('x64');
    expect(archToName(3)).toBe('arm64');
    expect(archToName('x64')).toBe('x64');
  });

  it('bare prebuild keep / drop', () => {
    expect(barePrebuildKeepName('linux', 'x64')).toBe('linux-x64');
    expect(shouldDropBarePrebuildDir('linux-x64', 'linux', 'x64')).toBe(false);
    expect(shouldDropBarePrebuildDir('darwin-arm64', 'linux', 'x64')).toBe(true);
    expect(shouldDropBarePrebuildDir('android-arm64', 'linux', 'x64')).toBe(true);
  });

  it('zlibjs keeps only node-zlib.js', () => {
    expect(shouldDropZlibjsBin('node-zlib.js')).toBe(false);
    expect(shouldDropZlibjsBin('gunzip.dev.min.js')).toBe(true);
    expect(shouldDropZlibjsBin('gunzip.min.js')).toBe(true);
  });

  it('i18n drops src and dist but not dist-cjs', () => {
    expect(shouldDropI18nPath('node_modules/@nomi-ai/i18n/src/index.ts')).toBe(true);
    expect(shouldDropI18nPath('node_modules/@nomi-ai/i18n/dist/index.js')).toBe(true);
    expect(shouldDropI18nPath('node_modules/@nomi-ai/i18n/dist-cjs/index.js')).toBe(false);
    expect(shouldDropI18nPath('node_modules/other/dist/x.js')).toBe(false);
  });

  it('slimNodeModulesTree removes foreign bare + zlib extras + i18n src/dist', () => {
    const root = mkdtempSync(join(tmpdir(), 'nomi-slim-'));
    try {
      const pre = join(root, 'node_modules', 'bare-fs', 'prebuilds');
      mkdirSync(join(pre, 'linux-x64'), { recursive: true });
      mkdirSync(join(pre, 'darwin-arm64'), { recursive: true });
      writeFileSync(join(pre, 'linux-x64', 'a.node'), 'x');
      writeFileSync(join(pre, 'darwin-arm64', 'a.node'), 'x');

      const zbin = join(root, 'node_modules', 'zlibjs', 'bin');
      mkdirSync(zbin, { recursive: true });
      writeFileSync(join(zbin, 'node-zlib.js'), 'main');
      writeFileSync(join(zbin, 'gunzip.dev.min.js'), 'dev');
      writeFileSync(join(zbin, 'gunzip.min.js'), 'min');

      const i18n = join(root, 'node_modules', '@nomi-ai', 'i18n');
      mkdirSync(join(i18n, 'src'), { recursive: true });
      mkdirSync(join(i18n, 'dist'), { recursive: true });
      mkdirSync(join(i18n, 'dist-cjs'), { recursive: true });
      writeFileSync(join(i18n, 'src', 'a.ts'), 's');
      writeFileSync(join(i18n, 'dist', 'a.js'), 'e');
      writeFileSync(join(i18n, 'dist-cjs', 'a.js'), 'c');

      const r = slimNodeModulesTree(root, 'linux', 'x64');
      expect(r.droppedBare).toBe(1);
      expect(existsSync(join(pre, 'linux-x64'))).toBe(true);
      expect(existsSync(join(pre, 'darwin-arm64'))).toBe(false);
      expect(existsSync(join(zbin, 'node-zlib.js'))).toBe(true);
      expect(existsSync(join(zbin, 'gunzip.dev.min.js'))).toBe(false);
      expect(existsSync(join(zbin, 'gunzip.min.js'))).toBe(false);
      expect(existsSync(join(i18n, 'dist-cjs', 'a.js'))).toBe(true);
      expect(existsSync(join(i18n, 'src'))).toBe(false);
      expect(existsSync(join(i18n, 'dist'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dropUnpackedDuplicates removes overlapping asar files', () => {
    const root = mkdtempSync(join(tmpdir(), 'nomi-dedupe-'));
    try {
      const f = join(root, 'node_modules', 'onnxruntime-web', 'dist');
      mkdirSync(f, { recursive: true });
      writeFileSync(join(f, 'ort.wasm'), 'wasm');
      writeFileSync(join(root, 'keep.js'), 'k');
      const n = dropUnpackedDuplicates(root, [
        'node_modules/onnxruntime-web/dist/ort.wasm',
        'missing.js',
      ]);
      expect(n).toBe(1);
      expect(existsSync(join(f, 'ort.wasm'))).toBe(false);
      expect(existsSync(join(root, 'keep.js'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
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
