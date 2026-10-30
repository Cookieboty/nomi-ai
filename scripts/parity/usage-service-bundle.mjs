/**
 * UsageService parity 录制用打包：esbuild 打 UsageService.ts（cli/detect、accounts/homes、SessionHistoryService 打桩：找不到 CLI；i18n 固定 zh-CN）。
 * 由 record-usage-service.mjs 调用：bundleUsageService(outfile)
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const R = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { build } = await import(R + '/node_modules/esbuild/lib/main.js');
const stub = {
  name: 'stub',
  setup(b) {
    b.onResolve({ filter: /^\.\.\/cli\/(accounts\/homes|detect|SessionHistoryService)$/ }, (a) => ({
      path: a.path,
      namespace: 'stub',
    }));
    b.onResolve({ filter: /^\.\.\/i18n$/ }, (a) => ({ path: 'i18n', namespace: 'stubi' }));
    b.onLoad({ filter: /.*/, namespace: 'stubi' }, () => ({
      contents:
        'import { createTranslator } from "@nomi-ai/i18n"; export const t = createTranslator(() => "zh-CN");',
      loader: 'js',
      resolveDir: R,
    }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents:
        'export const resolveCliBinAsync = async () => null; export const zstdDecode = () => { throw new Error("zstd"); }; export const withCliPath = (e) => ({ ...e, PATH: "stub" }); export const officialAccountEnv = (k, e, d) => ({ ...e, ACC: k + ":" + (d ?? "") });',
      loader: 'js',
    }));
  },
};
export async function bundleUsageService(outfile) {
  try {
    await build({
      entryPoints: [R + '/apps/desktop-electron/internal/core/src/usage/UsageService.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
      outfile,
      plugins: [stub],
      alias: {
        '@nomi-ai/types': R + '/packages/types/src/index.ts',
        '@nomi-ai/i18n': R + '/packages/i18n/src/index.ts',
      },
    });
  } catch (e) {
    console.error(
      [...new Set(e.errors.map((x) => x.text + ' @ ' + (x.location?.file || '')))].join('\n'),
    );
    process.exit(1);
  }
}
