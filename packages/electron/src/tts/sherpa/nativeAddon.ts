/**
 * sherpa-onnx-node 原生 addon 的防御性加载（尤其 Windows x64）。
 *
 * sherpa-onnx-node 自带的 addon.js 会吞掉真实的 dlopen 错误，统一报
 * "Could not find sherpa-onnx-node"。这里在失败后做诊断，给出可操作的明确原因：
 *  - 平台包缺失（sherpa-onnx-win-x64 没装：node_modules 从别的系统拷来 / optionalDependencies 被禁）
 *  - 平台包里缺 sherpa-onnx.node / onnxruntime.dll / sherpa-onnx-c-api.dll
 *  - 真实 dlopen 错误（缺 VC++ 运行库 MSVCP140 / VCRUNTIME140_1、System32 里同名 onnxruntime.dll 抢先加载、路径权限）
 *  - 打包后 asar 内无法 dlopen → 自动改走 app.asar.unpacked
 * Windows 上加载前会把平台包目录加入 PATH，保证依赖 DLL 能被找到。
 */
import fs from 'node:fs';
import path from 'node:path';

export class SherpaAddonLoadError extends Error {
  constructor(
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SherpaAddonLoadError';
  }
}

export interface AddonLoaderDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  /** require('sherpa-onnx-node') */
  requireAddon?: () => unknown;
  /** 解析某个模块的 package.json 路径（可指定起点目录）；失败抛错 */
  resolvePkgJson?: (pkg: string, fromDir?: string) => string;
  /** 直接 dlopen 平台包里的 .node，用于拿到真实错误 */
  requireNode?: (file: string) => unknown;
  exists?: (p: string) => boolean;
  readdir?: (p: string) => string[];
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

const SUPPORTED = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win-x64',
  'win-ia32',
]);

export function platformPackageName(platform: NodeJS.Platform, arch: string): string {
  const p = platform === 'win32' ? 'win' : platform;
  return `sherpa-onnx-${p}-${arch}`;
}

/** 打包后 .node / dll 在 app.asar.unpacked（asar 内无法 dlopen） */
export function toUnpackedPath(p: string): string {
  return p.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function loadSherpaAddon<T = unknown>(deps: AddonLoaderDeps = {}): T {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? fs.existsSync;
  const readdir = deps.readdir ?? ((p: string) => fs.readdirSync(p));
  const log = deps.log ?? (() => undefined);
  const requireAddon =
    deps.requireAddon ??
    (() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('sherpa-onnx-node');
    });
  const resolvePkgJson =
    deps.resolvePkgJson ??
    ((pkg: string, fromDir?: string) =>
      require.resolve(`${pkg}/package.json`, fromDir ? { paths: [fromDir] } : undefined));
  const requireNode =
    deps.requireNode ??
    ((file: string) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(file);
    });

  const key = `${platform === 'win32' ? 'win' : platform}-${arch}`;
  const pkgName = platformPackageName(platform, arch);

  if (!SUPPORTED.has(key)) {
    throw new SherpaAddonLoadError(
      `sherpa-onnx 不支持当前平台 ${platform}-${arch}（支持：${[...SUPPORTED].join(', ')}）`,
      { platform, arch },
    );
  }

  // 1) 先定位平台包目录；Windows 把它放进 PATH（依赖 DLL 搜索）
  let pkgDir: string | undefined;
  let resolveError: string | undefined;
  try {
    let fromDir: string | undefined;
    try {
      fromDir = path.dirname(resolvePkgJson('sherpa-onnx-node'));
    } catch {
      fromDir = undefined;
    }
    pkgDir = toUnpackedPath(path.dirname(resolvePkgJson(pkgName, fromDir)));
    if (!exists(pkgDir)) pkgDir = path.dirname(resolvePkgJson(pkgName, fromDir));
  } catch (e) {
    resolveError = errMsg(e);
  }
  if (platform === 'win32' && pkgDir) {
    const sep = ';';
    const cur = env.PATH ?? env.Path ?? '';
    if (!cur.toLowerCase().split(sep).includes(pkgDir.toLowerCase())) {
      env.PATH = `${pkgDir}${sep}${cur}`;
      log('prepended sherpa platform package dir to PATH', { pkgDir });
    }
  }

  // 2) 正常加载
  try {
    const addon = requireAddon();
    if (addon) return addon as T;
    throw new Error('sherpa-onnx-node exported an empty addon');
  } catch (firstErr) {
    throw diagnose(firstErr);
  }

  function diagnose(firstErr: unknown): SherpaAddonLoadError {
    const lines: string[] = [
      `sherpa-onnx 原生库加载失败（${platform}-${arch}）：${errMsg(firstErr)}`,
    ];
    const detail: Record<string, unknown> = { platform, arch, pkgName, pkgDir };

    if (!pkgDir) {
      lines.push(
        `未找到平台包 ${pkgName}（${resolveError ?? 'unresolved'}）。` +
          `请在本机重新安装依赖：pnpm install（不要拷贝其它系统的 node_modules，` +
          `不要禁用 optionalDependencies；必要时 pnpm install --force）。`,
      );
      return new SherpaAddonLoadError(lines.join('\n'), detail);
    }

    let files: string[] = [];
    try {
      files = readdir(pkgDir);
    } catch (e) {
      lines.push(`无法读取平台包目录 ${pkgDir}：${errMsg(e)}`);
    }
    detail.files = files;
    const nodeFile = path.join(pkgDir, 'sherpa-onnx.node');
    if (!files.includes('sherpa-onnx.node')) {
      lines.push(
        `平台包 ${pkgDir} 中缺少 sherpa-onnx.node（安装不完整或被杀毒软件隔离），请重装依赖。`,
      );
    }
    if (platform === 'win32') {
      const lower = files.map((f) => f.toLowerCase());
      const need = ['onnxruntime.dll', 'sherpa-onnx-c-api.dll'];
      const missing = need.filter((n) => !lower.includes(n));
      if (missing.length) {
        lines.push(`平台包缺少 DLL：${missing.join(', ')}（可能被杀毒软件隔离），请重装依赖。`);
      }
    }

    // 3) 直接 dlopen，拿真实错误（addon.js 会吞掉它）
    if (files.includes('sherpa-onnx.node')) {
      try {
        requireNode(nodeFile);
        lines.push(
          '直接加载 sherpa-onnx.node 成功，但 sherpa-onnx-node 入口仍失败：请检查依赖安装是否完整。',
        );
      } catch (e) {
        const msg = errMsg(e);
        detail.dlopenError = msg;
        lines.push(`dlopen(${nodeFile}) 实际错误：${msg}`);
        if (platform === 'win32') {
          lines.push(
            '常见原因：① 未安装 Microsoft Visual C++ 2015-2022 x64 运行库（缺 MSVCP140.dll / VCRUNTIME140_1.dll），' +
              '请安装 https://aka.ms/vs/17/release/vc_redist.x64.exe；' +
              '② C:\\Windows\\System32 下的旧版 onnxruntime.dll 被优先加载（版本不匹配 / OrtGetApiBase 找不到），' +
              '请确认平台包目录在 PATH 前面；③ 目录被杀毒软件拦截或路径权限不足。',
          );
        }
      }
    }
    return new SherpaAddonLoadError(lines.join('\n'), detail);
  }
}
