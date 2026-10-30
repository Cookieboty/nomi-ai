/**
 * electron-builder afterPack：只校验，不改 app.asar（#188）
 *
 * 安装包瘦身全部在打包输入阶段完成（electron-builder.yml 的 files）：assets、zlibjs 分文件、
 * @nomi-ai/i18n 的 src / ESM dist、onnxruntime-web / tesseract 变体、非当前平台的 bare-* prebuilds。
 *
 * 以前这里会解开 app.asar、删掉「与 app.asar.unpacked 重复」的文件再用 createPackage 重建。但 asarUnpack
 * 的文件本来就不在 asar 的数据区里，header 里只有一条 unpacked 记录；extractAll 从 .unpacked 目录复制
 * 出来的并不是重复副本。重建后的 header 丢了这些记录，Electron 按原路径 require（tesseract.js、
 * onnxruntime-web）直接找不到文件，知识库 OCR 与 Silero VAD 失效。
 *
 * 现在保留 electron-builder 生成的 header，afterPack 只检查 app.asar.unpacked 下的每个文件在 header 里
 * 都有、且标记为 unpacked，缺了就让打包失败，而不是装好后按需功能才报错。
 */
import fs from 'node:fs';
import path from 'node:path';

import { getRawHeader, uncache } from '@electron/asar';

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
 * 按 posix 相对路径在 asar header 里找条目
 * @param {{ files?: Record<string, any> }} header
 * @param {string} rel
 */
export function headerEntry(header, rel) {
  let node = header;
  for (const part of rel.split('/')) {
    node = node?.files?.[part];
    if (!node) return undefined;
  }
  return node;
}

/**
 * app.asar.unpacked 下的文件在 header 里缺失或没有标记 unpacked 的列表（空 = 正常）
 * @param {string} asarPath
 * @param {string} unpackedDir
 * @returns {string[]}
 */
export function missingUnpackedEntries(asarPath, unpackedDir) {
  // 同一路径的 asar 可能被替换过，读之前丢掉 @electron/asar 的缓存
  uncache(asarPath);
  const { header } = getRawHeader(asarPath);
  const bad = [];
  for (const rel of collectRelFiles(unpackedDir)) {
    const e = headerEntry(header, rel);
    if (!e || e.files || !e.unpacked) bad.push(rel);
  }
  return bad.sort();
}

/**
 * @param {Pick<import('app-builder-lib').AfterPackContext, 'appOutDir' | 'packager'>} context
 */
export default async function afterPack(context) {
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir);
  const asarPath = path.join(resourcesDir, 'app.asar');
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');
  if (!fs.existsSync(asarPath) || !fs.existsSync(unpackedDir)) return;
  const bad = missingUnpackedEntries(asarPath, unpackedDir);
  if (bad.length) {
    throw new Error(
      `[after-pack-slim] app.asar header lacks ${bad.length} unpacked entries (not loadable by path):\n` +
        bad.slice(0, 20).join('\n'),
    );
  }
}
