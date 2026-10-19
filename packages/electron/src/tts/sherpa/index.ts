import path from 'node:path';

import { app } from 'electron';

import { SHERPA_MODEL_ID } from './manifest';
import { SherpaTtsService } from './SherpaTtsService';

export { SherpaTtsService, SherpaTtsError } from './SherpaTtsService';
export type { SherpaErrorCode } from './SherpaTtsService';
export * from './manifest';
export { locateModel, verifyModelDir, installModel, removeModel } from './modelStore';
export { SHERPA_MODEL_MISSING_HINT } from './SherpaTtsService';
export { splitSentences } from './sentences';
export { encodeWavPcm16, concatSamples } from './wav';

let singleton: SherpaTtsService | null = null;

/**
 * 下载落点永远是 userData/tts-models（开发 / 打包一致）；安装包不再携带模型。
 * 开发态（未打包）额外定位以下模型目录：
 * - 仓库同级 ../models/<id>（例如 /workspace/models/vits-zh-hf-theresa）
 * - 仓库内 models/<id>
 */
function devModelDirs(): string[] {
  // NOMI_SHERPA_TTS_DEV_DIRS=0：开发 / E2E 时模拟「安装版没有模型」（只看 userData）
  if (app.isPackaged || process.env.NOMI_SHERPA_TTS_DEV_DIRS === '0') return [];
  try {
    const appPath = app.getAppPath();
    // packages/electron → repo root → sibling models
    const electronRoot = path.resolve(appPath);
    const repoRoot = path.resolve(electronRoot, '../..');
    return [
      path.resolve(repoRoot, '../models', SHERPA_MODEL_ID),
      path.resolve(repoRoot, 'models', SHERPA_MODEL_ID),
    ];
  } catch {
    return [];
  }
}

function userDataModelsRoot(): string {
  return path.join(app.getPath('userData'), 'tts-models');
}

export function getSherpaTtsService(): SherpaTtsService {
  if (!singleton) {
    singleton = new SherpaTtsService({
      devDirs: devModelDirs,
      envDir: () => process.env.NOMI_SHERPA_TTS_MODEL_DIR?.trim() || undefined,
      userRoot: () => {
        try {
          return userDataModelsRoot();
        } catch {
          return undefined;
        }
      },
    });
  }
  return singleton;
}
