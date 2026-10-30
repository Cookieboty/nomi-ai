/**
 * electron-builder afterPack：安装包瘦身（2.0.5 easy wins）
 *
 * 1. 去掉 asarUnpack 在 app.asar 内留下的重复副本（onnxruntime-web / tesseract）
 * 2. bare-* prebuilds 只保留当前平台+架构
 * 3. zlibjs 去掉 .dev / .pretty 与未使用的 .min 分文件（主入口 node-zlib.js 已自包含）
 * 4. @nomi-ai/i18n 去掉 src 与 ESM dist（打包主进程只 require dist-cjs）
 *
 * assets 与 tesseract 变体裁剪在 electron-builder.yml 的 files 里完成。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPackage, extractAll, uncache } from '@electron/asar';
import { Arch } from 'builder-util';

/** @param {string | number} arch */
export function archToName(arch) {
  if (typeof arch === 'string') return arch;
  return Arch[arch] ?? String(arch);
}

/** 保留的 bare prebuild 目录名：`${electronPlatformName}-${arch}` */
export function barePrebuildKeepName(platform, archName) {
  return `${platform}-${archName}`;
}

/**
 * @param {string} dirName prebuilds 下的一级目录名
 * @param {string} platform
 * @param {string} archName
 */
export function shouldDropBarePrebuildDir(dirName, platform, archName) {
  return dirName !== barePrebuildKeepName(platform, archName);
}

/** zlibjs/bin 下可删的文件名（保留 node-zlib.js） */
export function shouldDropZlibjsBin(fileName) {
  if (fileName === 'node-zlib.js' || fileName === '.gitkeep') return false;
  return true;
}

/**
 * @param {string} rel posix 相对路径
 * @returns {boolean}
 */
export function shouldDropI18nPath(rel) {
  const n = rel.replace(/\\/g, '/');
  const m = /(?:^|\/)node_modules\/@nomi-ai\/i18n\/([^/]+)/.exec(n);
  if (!m) return false;
  return m[1] === 'src' || m[1] === 'dist';
}

/**
 * 收集目录下所有文件的相对路径（posix）
 * @param {string} root
 * @param {string} [prefix]
 * @param {Set<string>} [out]
 */
export function collectRelFiles(root, prefix = '', out = new Set()) {
  if (!fs.existsSync(root)) return out;
  for (const name of fs.readdirSync(root)) {
    const abs = path.join(root, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) collectRelFiles(abs, rel, out);
    else if (st.isFile() || st.isSymbolicLink()) out.add(rel.replace(/\\/g, '/'));
  }
  return out;
}

/**
 * @param {string} treeRoot 已解压的 app 根（含 node_modules）
 * @param {string} platform
 * @param {string} archName
 * @returns {{ droppedBare: number, droppedZlib: number, droppedI18n: number }}
 */
export function slimNodeModulesTree(treeRoot, platform, archName) {
  let droppedBare = 0;
  let droppedZlib = 0;
  let droppedI18n = 0;
  const nm = path.join(treeRoot, 'node_modules');
  if (!fs.existsSync(nm)) return { droppedBare, droppedZlib, droppedI18n };

  for (const pkg of fs.readdirSync(nm)) {
    if (!pkg.startsWith('bare-')) continue;
    const pre = path.join(nm, pkg, 'prebuilds');
    if (!fs.existsSync(pre)) continue;
    for (const dir of fs.readdirSync(pre)) {
      if (!shouldDropBarePrebuildDir(dir, platform, archName)) continue;
      fs.rmSync(path.join(pre, dir), { recursive: true, force: true });
      droppedBare += 1;
    }
  }

  const zlibBin = path.join(nm, 'zlibjs', 'bin');
  if (fs.existsSync(zlibBin)) {
    for (const f of fs.readdirSync(zlibBin)) {
      if (!shouldDropZlibjsBin(f)) continue;
      fs.rmSync(path.join(zlibBin, f), { force: true });
      droppedZlib += 1;
    }
  }

  const i18nRoot = path.join(nm, '@nomi-ai', 'i18n');
  if (fs.existsSync(i18nRoot)) {
    for (const sub of ['src', 'dist']) {
      const p = path.join(i18nRoot, sub);
      if (!fs.existsSync(p)) continue;
      fs.rmSync(p, { recursive: true, force: true });
      droppedI18n += 1;
    }
  }

  return { droppedBare, droppedZlib, droppedI18n };
}

/**
 * 从 asar 解压树中删除与 app.asar.unpacked 重复的文件
 * @param {string} extractedRoot
 * @param {Iterable<string>} unpackedRels
 * @returns {number}
 */
export function dropUnpackedDuplicates(extractedRoot, unpackedRels) {
  let n = 0;
  for (const rel of unpackedRels) {
    const abs = path.join(extractedRoot, rel);
    if (!fs.existsSync(abs)) continue;
    fs.rmSync(abs, { force: true });
    n += 1;
  }
  return n;
}

/**
 * @param {import('app-builder-lib').AfterPackContext} context
 */
export default async function afterPack(context) {
  const platform = context.electronPlatformName;
  const archName = archToName(context.arch);
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir);
  const asarPath = path.join(resourcesDir, 'app.asar');
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');

  if (!fs.existsSync(asarPath)) {
    console.log('[after-pack-slim] no app.asar, skip');
    return;
  }

  const unpackedRels = collectRelFiles(unpackedDir);
  if (fs.existsSync(unpackedDir)) {
    const u = slimNodeModulesTree(unpackedDir, platform, archName);
    console.log(
      `[after-pack-slim] unpacked trim bare=${u.droppedBare} zlib=${u.droppedZlib} i18n=${u.droppedI18n}`,
    );
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-asar-slim-'));
  try {
    extractAll(asarPath, tmp);
    const t = slimNodeModulesTree(tmp, platform, archName);
    const dup = dropUnpackedDuplicates(tmp, unpackedRels);
    console.log(
      `[after-pack-slim] asar trim bare=${t.droppedBare} zlib=${t.droppedZlib} i18n=${t.droppedI18n} dedupe=${dup} platform=${platform}-${archName}`,
    );
    fs.rmSync(asarPath, { force: true });
    // 丢掉旧 asar 的内存缓存，否则同路径再读会看到重建前的内容
    uncache(asarPath);
    await createPackage(tmp, asarPath);
    uncache(asarPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
