/**
 * 本地语音模型目录（按需下载，不随安装包分发）。
 * 每一项都钉死版本 + sha256，并在下载前向用户展示许可。
 * 来源核对（2026-10-12）：
 *   - whisper.cpp b5454 release assets（MIT）https://github.com/ggml-org/whisper.cpp/releases/tag/b5454
 *   - ggml whisper 权重（MIT）https://huggingface.co/ggerganov/whisper.cpp
 *   - Silero VAD（MIT）https://github.com/snakers4/silero-vad
 */
export type VoiceAssetKind = 'whisper-bin' | 'whisper-model' | 'vad';

export interface VoiceAsset {
  id: string;
  kind: VoiceAssetKind;
  name: string;
  description: string;
  url: string;
  sha256: string;
  bytes: number;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
  /** 归档类型：下载后解包 */
  archive?: 'zip' | 'tar.gz';
  /** 仅适用的平台（process.platform-process.arch） */
  platforms?: string[];
  /** 下载后落地文件名（非归档） */
  fileName?: string;
}

const WHISPER_REL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454';
const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const SILERO_COMMIT = '1e261b036686cd0017d500ee96acd1c4ba572a9d';

export const VOICE_ASSETS: readonly VoiceAsset[] = Object.freeze([
  {
    id: 'whisper-bin-win-x64',
    kind: 'whisper-bin',
    name: 'electron.common.whisper-cpp-engine-windows-x64-cpu',
    description: 'electron.common.official-prebuilt-whisper-cli-for-local-offline-recognition',
    url: `${WHISPER_REL}/whisper-bin-x64.zip`,
    sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
    bytes: 8928640,
    license: 'MIT',
    licenseUrl: 'https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE',
    sourceUrl: 'https://github.com/ggml-org/whisper.cpp/releases/tag/b5454',
    archive: 'zip',
    platforms: ['win32-x64'],
  },
  {
    id: 'whisper-bin-linux-x64',
    kind: 'whisper-bin',
    name: 'electron.common.whisper-cpp-engine-linux-x64',
    description: 'electron.common.official-prebuilt-whisper-cli-for-local-offline-recognition',
    url: `${WHISPER_REL}/whisper-bin-ubuntu-x64.tar.gz`,
    sha256: 'a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c',
    bytes: 10364195,
    license: 'MIT',
    licenseUrl: 'https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE',
    sourceUrl: 'https://github.com/ggml-org/whisper.cpp/releases/tag/b5454',
    archive: 'tar.gz',
    platforms: ['linux-x64'],
  },
  {
    id: 'whisper-bin-linux-arm64',
    kind: 'whisper-bin',
    name: 'electron.common.whisper-cpp-engine-linux-arm64',
    description: 'electron.common.official-prebuilt-whisper-cli-for-local-offline-recognition',
    url: `${WHISPER_REL}/whisper-bin-ubuntu-arm64.tar.gz`,
    sha256: '6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149',
    bytes: 4608377,
    license: 'MIT',
    licenseUrl: 'https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE',
    sourceUrl: 'https://github.com/ggml-org/whisper.cpp/releases/tag/b5454',
    archive: 'tar.gz',
    platforms: ['linux-arm64'],
  },
  {
    id: 'ggml-tiny',
    kind: 'whisper-model',
    name: 'electron.common.whisper-tiny-multilingual-75-mb',
    description: 'electron.common.fastest-good-for-short-commands-chinese-accuracy-is',
    url: `${HF}/ggml-tiny.bin`,
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
    bytes: 77691713,
    license: 'MIT',
    licenseUrl: 'https://github.com/openai/whisper/blob/main/LICENSE',
    sourceUrl: 'https://huggingface.co/ggerganov/whisper.cpp',
    fileName: 'ggml-tiny.bin',
  },
  {
    id: 'ggml-base',
    kind: 'whisper-model',
    name: 'electron.common.whisper-base-multilingual-148-mb',
    description: 'electron.common.balance-of-speed-and-accuracy-recommended',
    url: `${HF}/ggml-base.bin`,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    bytes: 147951465,
    license: 'MIT',
    licenseUrl: 'https://github.com/openai/whisper/blob/main/LICENSE',
    sourceUrl: 'https://huggingface.co/ggerganov/whisper.cpp',
    fileName: 'ggml-base.bin',
  },
  {
    id: 'silero-vad',
    kind: 'vad',
    name: 'Silero VAD（2.3 MB）',
    description: 'electron.common.speech-detection-for-hands-free-mode-detects-when',
    url: `https://raw.githubusercontent.com/snakers4/silero-vad/${SILERO_COMMIT}/src/silero_vad/data/silero_vad.onnx`,
    sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
    bytes: 2327524,
    license: 'MIT',
    licenseUrl: 'https://github.com/snakers4/silero-vad/blob/master/LICENSE',
    sourceUrl: `https://github.com/snakers4/silero-vad/tree/${SILERO_COMMIT}`,
    fileName: 'silero_vad.onnx',
  },
]);

export const platformKey = (p = process.platform, a = process.arch): string => `${p}-${a}`;

/** 当前平台可见的资产（引擎二进制按平台过滤） */
export function assetsFor(pk = platformKey()): VoiceAsset[] {
  return VOICE_ASSETS.filter((a) => !a.platforms || a.platforms.includes(pk));
}

export function findAsset(id: string): VoiceAsset | undefined {
  return VOICE_ASSETS.find((a) => a.id === id);
}
