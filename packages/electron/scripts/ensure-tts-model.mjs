#!/usr/bin/env node
/**
 * 准备离线 TTS 模型（sherpa-onnx · vits-zh-hf-theresa）——跨平台纯 Node，无需额外依赖工具。
 *
 * 触发时机：
 *   - `pnpm i`：packages/electron 的 postinstall（--postinstall）
 *   - `pnpm dev`：scripts/dev.mjs 启动前再跑一遍作为兜底（已完整则毫秒级跳过）
 *   - 手动：node scripts/ensure-tts-model.mjs [--check] [--strict] [--force]
 *
 * 目标目录与运行时一致：<repo>/../models/vits-zh-hf-theresa（Windows 如 D:\self_git\models\vits-zh-hf-theresa）。
 * 幂等：按清单逐文件校验字节数 + 版本标记（.nomi-model.json 记录归档 sha256），完整则直接跳过；
 * 不完整 / 标记对不上（模型换了版本）才下载（sha256）→ 流式解压到 .partial → 校验 → 写标记 → 原子改名。
 *
 * 失败只报错、**退出码 0**（不阻塞 pnpm i / dev；运行时仍会后台异步下载并回退系统语音）。
 * 加 --strict 时失败以非 0 退出（CI 想强校验时用）。
 *
 * 环境变量：
 *   NOMI_SKIP_MODEL_DOWNLOAD=1         跳过（旧名 NOMI_SKIP_TTS_MODEL=1 仍有效）
 *   CI=true                            postinstall 默认跳过（CI 不需要模型；运行时按需下载）；
 *                                      CI 里确实要预下载时设 NOMI_SKIP_MODEL_DOWNLOAD=0
 *   NOMI_SHERPA_TTS_MODEL_URL          镜像地址，多个用逗号 / 分号 / 空白分隔，按序尝试，最后兜底官方 GitHub
 *   NOMI_SHERPA_TTS_MODEL_DIR          已有模型目录（完整则视为就绪、不下载）
 *   NOMI_SHERPA_TTS_ATTEMPTS           每个地址重试次数（默认 3）
 *   NOMI_SHERPA_TTS_IDLE_TIMEOUT_MS    空闲超时（连接 / 两个数据块间隔，默认 30000）
 *   HTTPS_PROXY / HTTP_PROXY           Node 内置 fetch 默认不走代理；存在时脚本会尽力启用（Node ≥ 22.21 / 24.5）
 *
 * 清单常量需与 src/tts/sherpa/manifest.ts 保持一致（tests/unit/tts/ensureTtsModelScript.test.ts 校验）。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const TAG = '[tts-model]';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ELECTRON_ROOT, '../..');

const MODEL_ID = 'vits-zh-hf-theresa';
const MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-zh-hf-theresa.tar.bz2';
const MODEL_SHA256 = 'f337638c49689e1d87135c4e224daa1aacc0109e784b1cf78eafb1b14a1d9e92';
const MODEL_BYTES = 120596617;
const REQUIRED = Object.freeze({
  'theresa.onnx': 121913906,
  'lexicon.txt': 2764076,
  'tokens.txt': 268,
  'phone.fst': 88630,
  'date.fst': 59154,
  'number.fst': 64482,
  'new_heteronym.fst': 21974,
  'dict/jieba.dict.utf8': 5071204,
  'dict/hmm_model.utf8': 519739,
  'dict/user.dict.utf8': 49,
  'dict/idf.utf8': 5998717,
  'dict/stop_words.utf8': 8974,
  'dict/pos_dict/prob_start.utf8': 4347,
  'dict/pos_dict/char_state_tab.utf8': 327139,
  'dict/pos_dict/prob_emit.utf8': 1687686,
  'dict/pos_dict/prob_trans.utf8': 124159,
});

const args = new Set(process.argv.slice(2));
const STRICT = args.has('--strict');
const CHECK_ONLY = args.has('--check');
const FORCE = args.has('--force');
const POSTINSTALL = args.has('--postinstall');

const info = (m) => console.log(`${TAG} ${m}`);
const warn = (m) => console.warn(`${TAG} ${m}`);
const errText = (e) => {
  if (!(e instanceof Error)) return String(e);
  const c = e.code;
  return c && !e.message.includes(c) ? `${c}: ${e.message}` : e.message;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtBytes = (n) =>
  n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** 版本标记：记录装进来的是哪个归档（sha256），清单换版本时据此重新下载 */
export const MARKER = '.nomi-model.json';

/** 缺失或大小不符的相对路径（只 stat，毫秒级）；标记存在但版本不符时报 MARKER */
export function verify(dir) {
  const bad = [];
  for (const [rel, bytes] of Object.entries(REQUIRED)) {
    try {
      if (fs.statSync(path.join(dir, rel)).size !== bytes) bad.push(rel);
    } catch {
      bad.push(rel);
    }
  }
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    if (m?.id !== MODEL_ID || m?.sha256 !== MODEL_SHA256) bad.push(MARKER);
  } catch (e) {
    // 没有标记（旧版本装的 / 手动解压的）：大小全对就认；标记损坏视为不符
    if (e?.code !== 'ENOENT') bad.push(MARKER);
  }
  return bad;
}

function writeMarker(dir) {
  try {
    fs.writeFileSync(
      path.join(dir, MARKER),
      `${JSON.stringify({ id: MODEL_ID, sha256: MODEL_SHA256, bytes: MODEL_BYTES })}\n`,
    );
  } catch {
    /* 只读目录：下次仍按大小校验 */
  }
}

const truthy = (v) => !!v && !['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase());

/** 是否跳过、以及原因（null = 不跳过） */
export function skipReason(env = process.env, { postinstall = false } = {}) {
  if (env.NOMI_SKIP_MODEL_DOWNLOAD !== undefined && env.NOMI_SKIP_MODEL_DOWNLOAD !== '') {
    return truthy(env.NOMI_SKIP_MODEL_DOWNLOAD) ? 'NOMI_SKIP_MODEL_DOWNLOAD=1' : null;
  }
  if (env.NOMI_SKIP_TTS_MODEL === '1') return 'NOMI_SKIP_TTS_MODEL=1';
  if (postinstall && truthy(env.CI)) return 'CI';
  return null;
}

const rmQuiet = (p, recursive = false) => {
  try {
    // Windows：杀软 / 索引服务可能短暂占用 → 带重试
    fs.rmSync(p, { recursive, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* ignore */
  }
};

function renameWithRetry(from, to, attempts = 8) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (i >= attempts - 1 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e?.code))
        throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * (i + 1));
    }
  }
}

/** 解析下载地址：env 镜像优先，最后兜底官方 */
export function resolveUrls(env = process.env) {
  const urls = (env.NOMI_SHERPA_TTS_MODEL_URL ?? '')
    .split(/[\s,;]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u));
  if (!urls.includes(MODEL_URL)) urls.push(MODEL_URL);
  return urls;
}

/** 清理历史遗留：0KB / 残留 .part、.download 里的旧归档、.partial 半成品 */
function cleanupResidue(root) {
  const dl = path.join(root, '.download');
  try {
    for (const name of fs.readdirSync(dl)) {
      if (name.endsWith('.lock')) continue;
      const p = path.join(dl, name);
      let size = -1;
      try {
        size = fs.statSync(p).size;
      } catch {
        /* ignore */
      }
      rmQuiet(p);
      info(
        `cleaned stale ${path.join('.download', name)}${size >= 0 ? ` (${fmtBytes(size)})` : ''}`,
      );
    }
  } catch {
    /* 没有 .download 目录 */
  }
  rmQuiet(path.join(root, `${MODEL_ID}.partial`), true);
}

function probeWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
  } catch (e) {
    throw new Error(
      `目录不可写：${dir}（${errText(e)}）。请检查盘符是否存在 / 目录权限，` +
        `或手动解压到该目录（见 docs/features/voice.md）`,
      { cause: e },
    );
  }
}

/** 单进程锁：避免 postinstall 与 dev 兜底同时下载同一个文件互相踩 .part */
function acquireLock(root) {
  const lock = path.join(root, '.download', 'prepare.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => rmQuiet(lock);
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      let stale = true;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        const pid = Number(fs.readFileSync(lock, 'utf8'));
        let alive = false;
        if (pid > 0) {
          try {
            process.kill(pid, 0);
            alive = true;
          } catch (err) {
            alive = err?.code === 'EPERM';
          }
        }
        stale = !alive || age > 30 * 60_000;
      } catch {
        /* 读不到就当过期 */
      }
      if (!stale) return null;
      rmQuiet(lock);
    }
  }
  return null;
}

function enableProxyFromEnv() {
  const hasProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!hasProxy || process.env.NODE_USE_ENV_PROXY) return;
  try {
    if (typeof http.setGlobalProxyFromEnv === 'function') {
      http.setGlobalProxyFromEnv();
      info('using proxy from environment');
    } else {
      info(
        '检测到代理环境变量，但当前 Node 不支持自动启用；可设置 NODE_USE_ENV_PROXY=1（Node ≥ 24）或使用镜像 NOMI_SHERPA_TTS_MODEL_URL',
      );
    }
  } catch {
    /* ignore */
  }
}

async function downloadOnce(url, dest, idleMs) {
  const ctl = new AbortController();
  let timer;
  let timedOut = false;
  let rejectIdle;
  const idle = new Promise((_, j) => (rejectIdle = j));
  idle.catch(() => undefined);
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      rejectIdle(new Error(`下载停滞：${Math.round(idleMs / 1000)}s 内无数据（超时）`));
      ctl.abort();
    }, idleMs);
  };
  const guard = (p) => Promise.race([p, idle]);
  const tmp = `${dest}.part`;
  rmQuiet(tmp);
  let out;
  try {
    arm();
    const res = await guard(fetch(url, { redirect: 'follow', signal: ctl.signal }));
    if (!res.ok || !res.body) {
      throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    }
    const total = Number(res.headers.get('content-length')) || MODEL_BYTES;
    out = fs.createWriteStream(tmp);
    out.on('error', () => undefined);
    const hash = createHash('sha256');
    let received = 0;
    let lastPct = -1;
    let lastLog = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await guard(reader.read());
      if (done) break;
      arm();
      hash.update(value);
      received += value.byteLength;
      if (!out.write(value)) {
        await guard(
          new Promise((r, j) => {
            const onErr = (e) => j(e);
            out.once('error', onErr);
            out.once('drain', () => {
              out.off('error', onErr);
              r();
            });
          }),
        );
      }
      const pct = Math.min(100, Math.floor((received / total) * 100));
      const now = Date.now();
      if (pct >= lastPct + 10 || now - lastLog > 5000) {
        lastPct = pct;
        lastLog = now;
        info(`download ${pct}% (${fmtBytes(received)} / ${fmtBytes(total)})`);
      }
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    if (received === 0) throw new Error('下载内容为空（0 字节）');
    const actual = hash.digest('hex');
    if (actual !== MODEL_SHA256) {
      throw new Error(
        `sha256 不匹配（镜像内容不是官方归档 / 下载被截断或被代理改写）：期望 ${MODEL_SHA256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`,
      );
    }
    renameWithRetry(tmp, dest);
  } catch (e) {
    out?.destroy();
    rmQuiet(tmp);
    throw timedOut ? new Error(`下载停滞：${Math.round(idleMs / 1000)}s 内无数据（超时）`) : e;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadArchive(urls, dest) {
  const attempts = Math.max(1, Number(process.env.NOMI_SHERPA_TTS_ATTEMPTS) || 3);
  const idleMs = Math.max(1000, Number(process.env.NOMI_SHERPA_TTS_IDLE_TIMEOUT_MS) || 30_000);
  const failures = [];
  for (const url of urls) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        info(`fetching ${url} (attempt ${attempt}/${attempts})`);
        await downloadOnce(url, dest, idleMs);
        return;
      } catch (e) {
        const msg = errText(e);
        failures.push(`${url} #${attempt}: ${msg}`);
        warn(`download failed (${attempt}/${attempts}): ${msg}`);
        if (e?.status >= 400 && e.status < 500) break; // 地址失效 / 无权限：换下一个
        if (attempt < attempts) await sleep(1500 * attempt);
      }
    }
  }
  throw new Error(
    `下载失败（已尝试 ${urls.length} 个地址）：${failures.slice(-3).join(' | ')}\n` +
      `  - 国内网络 / GitHub 慢：设置镜像 NOMI_SHERPA_TTS_MODEL_URL=<同一 .tar.bz2 的镜像地址>\n` +
      `  - 需要代理：设置 HTTPS_PROXY（Node 24 可加 NODE_USE_ENV_PROXY=1）\n` +
      `  - 或手动下载 ${MODEL_URL} 并解压（见 docs/features/voice.md）`,
  );
}

async function extractTarBz2(archive, destDir) {
  const require = createRequire(path.join(ELECTRON_ROOT, 'package.json'));
  let tar;
  let unbzip2;
  try {
    tar = require('tar-stream');
    unbzip2 = require('unbzip2-stream');
  } catch (e) {
    throw new Error(
      `缺少解压依赖 tar-stream / unbzip2-stream（请先完成 pnpm install）：${errText(e)}`,
      { cause: e },
    );
  }
  fs.mkdirSync(destDir, { recursive: true });
  const root = path.resolve(destDir);
  const prefix = `${MODEL_ID}/`;
  const extract = tar.extract();
  extract.on('entry', (header, stream, next) => {
    let rel = header.name.replace(/\\/g, '/');
    if (rel.startsWith(prefix)) rel = rel.slice(prefix.length);
    else if (rel === MODEL_ID) rel = '';
    const abs = rel ? path.resolve(root, rel) : null;
    const ok =
      header.type === 'file' &&
      rel &&
      !rel.startsWith('/') &&
      !/^[a-zA-Z]:/.test(rel) &&
      !rel.split('/').includes('..') &&
      abs &&
      abs.startsWith(root + path.sep);
    if (!ok) {
      stream.resume();
      stream.on('end', next);
      return;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    pipeline(stream, fs.createWriteStream(abs, { mode: 0o644 })).then(
      () => next(),
      (err) => next(err),
    );
  });
  await pipeline(fs.createReadStream(archive), unbzip2(), extract);
}

async function install(root) {
  const finalDir = path.join(root, MODEL_ID);
  const partial = `${finalDir}.partial`;
  const archive = path.join(root, '.download', `${MODEL_ID}.tar.bz2`);
  probeWritable(root);
  const release = acquireLock(root);
  if (!release) {
    info('另一个进程正在准备模型，跳过（运行时会在后台继续等待 / 回退系统语音）');
    return false;
  }
  try {
    cleanupResidue(root);
    await downloadArchive(resolveUrls(), archive);
    info(`extracting → ${partial}`);
    try {
      await extractTarBz2(archive, partial);
    } catch (e) {
      throw new Error(
        `解压失败（${partial}）：${errText(e)}（磁盘空间不足 / 目录被占用 / 归档损坏）`,
        { cause: e },
      );
    }
    const bad = verify(partial);
    if (bad.length) throw new Error(`解压后清单校验失败：${bad.slice(0, 3).join(', ')}`);
    writeMarker(partial);
    try {
      rmQuiet(finalDir, true);
      renameWithRetry(partial, finalDir);
    } catch (e) {
      throw new Error(
        `安装失败（${partial} → ${finalDir}）：${errText(e)}（目录可能被杀毒软件 / 资源管理器占用）`,
        { cause: e },
      );
    }
    info(`ready: ${finalDir}`);
    return true;
  } finally {
    rmQuiet(partial, true);
    rmQuiet(archive);
    rmQuiet(`${archive}.part`);
    release();
    try {
      fs.rmdirSync(path.join(root, '.download')); // 空目录才会删掉
    } catch {
      /* 非空或不存在 */
    }
  }
}

export async function main() {
  const skip = skipReason(process.env, { postinstall: POSTINSTALL });
  if (skip) {
    info(
      skip === 'CI'
        ? 'CI 环境：postinstall 跳过模型下载（运行时按需下载；需要时设 NOMI_SKIP_MODEL_DOWNLOAD=0）'
        : `${skip}，跳过模型准备`,
    );
    return 0;
  }
  const root = path.resolve(REPO_ROOT, '../models');
  const finalDir = path.join(root, MODEL_ID);

  const envDir = process.env.NOMI_SHERPA_TTS_MODEL_DIR?.trim();
  if (envDir && !FORCE && verify(envDir).length === 0) {
    if (!POSTINSTALL) info(`ok (NOMI_SHERPA_TTS_MODEL_DIR): ${envDir}`);
    return 0;
  }
  if (!FORCE && verify(finalDir).length === 0) {
    // 旧版本装的没有版本标记：大小全对，补上标记，下次直接按标记判断
    if (!CHECK_ONLY && !fs.existsSync(path.join(finalDir, MARKER))) writeMarker(finalDir);
    // 已完整：顺手清掉历史残留（0KB .part 等），不下载
    if (fs.existsSync(path.join(root, '.download')) || fs.existsSync(`${finalDir}.partial`))
      cleanupResidue(root);
    info(`ok: ${finalDir}`);
    return 0;
  }
  if (CHECK_ONLY) {
    warn(`模型不完整：${finalDir}（缺失 / 大小不符：${verify(finalDir).slice(0, 3).join(', ')}）`);
    return 1;
  }
  enableProxyFromEnv();
  info(`model missing → ${finalDir}`);
  try {
    if (FORCE) rmQuiet(finalDir, true);
    await install(root);
    return 0;
  } catch (e) {
    console.error(`${TAG} 模型准备失败：${errText(e)}`);
    console.error(
      `${TAG} 不影响安装 / 启动：应用运行时会再次后台下载，期间自动回退系统语音。` +
        `手动方案：解压归档到 ${finalDir}，或设置 NOMI_SHERPA_TTS_MODEL_DIR。`,
    );
    return STRICT ? 1 : 0;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`${TAG} unexpected error: ${errText(e)}`);
      process.exit(STRICT ? 1 : 0);
    },
  );
}
