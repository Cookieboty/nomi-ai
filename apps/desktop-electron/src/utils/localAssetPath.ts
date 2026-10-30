import * as path from 'path';

/**
 * 去掉资源路径中的查询串 / 片段（如 `model.vrm?v=2` 这类缓存参数），
 * 以及开头的 `./` 或 `/`，得到相对于 renderer 根目录的路径。
 */
export function normalizeRendererRelativePath(filePath: string): string {
  const withoutQuery = filePath.split(/[?#]/)[0];
  return withoutQuery.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

/**
 * 未打包（`electron .`）时 renderer 资源的候选路径，按优先级排列。
 *
 * `app.getAppPath()` 指向 apps/desktop-electron（package.json 所在目录），因此：
 * 1. `<appPath>/<filePath>`                    —— 显式相对 electron 包的路径
 * 2. `<appPath>/dist/renderer/<rel>`           —— scripts/copy-renderer.js 复制后的产物（生产模式加载的就是这里）
 * 3. `<appPath>/../../packages/renderer/dist/<rel>`   —— renderer 自身的构建产物
 * 4. `<appPath>/../../packages/renderer/public/<rel>` —— renderer 源码中的静态资源
 */
export function getUnpackagedAssetCandidates(appPath: string, filePath: string): string[] {
  const rel = normalizeRendererRelativePath(filePath);
  return [
    path.join(appPath, filePath.split(/[?#]/)[0]),
    path.join(appPath, 'dist', 'renderer', rel),
    path.join(appPath, '..', '..', 'packages', 'renderer', 'dist', rel),
    path.join(appPath, '..', '..', 'packages', 'renderer', 'public', rel),
  ];
}

/**
 * 返回第一个存在的候选路径；都不存在时返回第一个候选（调用方会据此报告“文件不存在”）。
 */
export function resolveUnpackagedAssetPath(
  appPath: string,
  filePath: string,
  exists: (p: string) => boolean,
): string {
  const candidates = getUnpackagedAssetCandidates(appPath, filePath);
  return candidates.find((p) => exists(p)) ?? candidates[0];
}
