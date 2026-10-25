/**
 * 本地小模型目录（GGUF，按需下载）+ llama.cpp 推理服务（llama-server，MIT）。
 * 只收录许可证真正开放的模型；每一项都钉死文件 + sha256（来自 Hugging Face LFS 元数据）。
 * 许可核对（2026-10-12，官方模型卡 cardData.license）：
 *   - Qwen/Qwen3-0.6B · Qwen3-1.7B · Qwen3-4B（apache-2.0）及官方 GGUF 仓库
 *   - Qwen/Qwen2.5-1.5B-Instruct（apache-2.0）；注意 Qwen2.5-3B 为 Qwen Research 许可，未收录
 *   - HuggingFaceTB/SmolLM2-1.7B-Instruct（apache-2.0）
 *   - microsoft/Phi-4-mini-instruct（mit）；GGUF 由 unsloth 转换（仓库许可 mit）
 *   - 未收录 Llama / Gemma 等自定义许可模型
 *   - llama.cpp b11565 release（MIT）https://github.com/ggml-org/llama.cpp/releases/tag/b11565
 */
export interface LocalLlm {
  id: string;
  name: string;
  family: string;
  params: string;
  quant: string;
  description: string;
  url: string;
  sha256: string;
  bytes: number;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
  /** 建议的最小内存（GB） */
  minRamGb: number;
  ctx: number;
}

const HF = 'https://huggingface.co';
const r = (repo: string, file: string) => `${HF}/${repo}/resolve/main/${file}`;

export const LOCAL_LLMS: readonly LocalLlm[] = Object.freeze([
  {
    id: 'qwen3-0.6b-q8',
    name: 'Qwen3 0.6B',
    family: 'Qwen3',
    params: '0.6B',
    quant: 'Q8_0',
    description: 'electron.common.smallest-and-fastest-good-for-chit-chat-and',
    url: r('Qwen/Qwen3-0.6B-GGUF', 'Qwen3-0.6B-Q8_0.gguf'),
    sha256: '9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031',
    bytes: 639446688,
    license: 'Apache-2.0',
    licenseUrl: `${HF}/Qwen/Qwen3-0.6B/blob/main/LICENSE`,
    sourceUrl: `${HF}/Qwen/Qwen3-0.6B-GGUF`,
    minRamGb: 4,
    ctx: 8192,
  },
  {
    id: 'qwen2.5-1.5b-q4km',
    name: 'Qwen2.5 1.5B Instruct',
    family: 'Qwen2.5',
    params: '1.5B',
    quant: 'Q4_K_M',
    description: 'electron.common.solid-chinese-performance-small-size',
    url: r('Qwen/Qwen2.5-1.5B-Instruct-GGUF', 'qwen2.5-1.5b-instruct-q4_k_m.gguf'),
    sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
    bytes: 1117320736,
    license: 'Apache-2.0',
    licenseUrl: `${HF}/Qwen/Qwen2.5-1.5B-Instruct/blob/main/LICENSE`,
    sourceUrl: `${HF}/Qwen/Qwen2.5-1.5B-Instruct-GGUF`,
    minRamGb: 6,
    ctx: 8192,
  },
  {
    id: 'smollm2-1.7b-q4km',
    name: 'SmolLM2 1.7B Instruct',
    family: 'SmolLM2',
    params: '1.7B',
    quant: 'Q4_K_M',
    description: 'electron.common.lightweight-english-focused-model-fast',
    url: r('HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF', 'smollm2-1.7b-instruct-q4_k_m.gguf'),
    sha256: 'decd2598bc2c8ed08c19adc3c8fdd461ee19ed5708679d1c54ef54a5a30d4f33',
    bytes: 1055609536,
    license: 'Apache-2.0',
    licenseUrl: `${HF}/HuggingFaceTB/SmolLM2-1.7B-Instruct`,
    sourceUrl: `${HF}/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF`,
    minRamGb: 6,
    ctx: 8192,
  },
  {
    id: 'qwen3-1.7b-q8',
    name: 'Qwen3 1.7B',
    family: 'Qwen3',
    params: '1.7B',
    quant: 'Q8_0',
    description: 'electron.common.recommended-for-8-gb-of-memory-good-in',
    url: r('Qwen/Qwen3-1.7B-GGUF', 'Qwen3-1.7B-Q8_0.gguf'),
    sha256: '061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a',
    bytes: 1834426016,
    license: 'Apache-2.0',
    licenseUrl: `${HF}/Qwen/Qwen3-1.7B/blob/main/LICENSE`,
    sourceUrl: `${HF}/Qwen/Qwen3-1.7B-GGUF`,
    minRamGb: 8,
    ctx: 8192,
  },
  {
    id: 'qwen3-4b-q4km',
    name: 'Qwen3 4B',
    family: 'Qwen3',
    params: '4B',
    quant: 'Q4_K_M',
    description: 'electron.common.recommended-for-16-gb-of-memory-noticeably-stronger',
    url: r('Qwen/Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf'),
    sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
    bytes: 2497280256,
    license: 'Apache-2.0',
    licenseUrl: `${HF}/Qwen/Qwen3-4B/blob/main/LICENSE`,
    sourceUrl: `${HF}/Qwen/Qwen3-4B-GGUF`,
    minRamGb: 12,
    ctx: 8192,
  },
  {
    id: 'phi4-mini-q4km',
    name: 'Phi-4 mini Instruct',
    family: 'Phi-4',
    params: '3.8B',
    quant: 'Q4_K_M',
    description: 'electron.common.strong-english-reasoning-and-code-gguf-converted-by',
    url: r('unsloth/Phi-4-mini-instruct-GGUF', 'Phi-4-mini-instruct-Q4_K_M.gguf'),
    sha256: '88c00229914083cd112853aab84ed51b87bdf6b9ce42f532d8c85c7c63b1730a',
    bytes: 2491874272,
    license: 'MIT',
    licenseUrl: `${HF}/microsoft/Phi-4-mini-instruct/blob/main/LICENSE`,
    sourceUrl: `${HF}/unsloth/Phi-4-mini-instruct-GGUF`,
    minRamGb: 12,
    ctx: 8192,
  },
]);

export interface RuntimeAsset {
  platform: string;
  url: string;
  sha256: string;
  bytes: number;
  archive: 'zip' | 'tar.gz';
}

const LLAMA_TAG = 'b11565';
const LR = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}`;
export const LLAMA_RUNTIME = {
  tag: LLAMA_TAG,
  license: 'MIT',
  licenseUrl: 'https://github.com/ggml-org/llama.cpp/blob/master/LICENSE',
  sourceUrl: `https://github.com/ggml-org/llama.cpp/releases/tag/${LLAMA_TAG}`,
  assets: [
    {
      platform: 'darwin-arm64',
      url: `${LR}/llama-${LLAMA_TAG}-bin-macos-arm64.tar.gz`,
      sha256: '19289548468babcd5131cecccf3a9bc7c67030cc7f0a978dafc0db1ba7891068',
      bytes: 12105509,
      archive: 'tar.gz',
    },
    {
      platform: 'darwin-x64',
      url: `${LR}/llama-${LLAMA_TAG}-bin-macos-x64.tar.gz`,
      sha256: '853c2c2ed9d796f3f6d0210aac7768a8398997cf2afdc9916a6112003b13760f',
      bytes: 11596850,
      archive: 'tar.gz',
    },
    {
      platform: 'linux-x64',
      url: `${LR}/llama-${LLAMA_TAG}-bin-ubuntu-x64.tar.gz`,
      sha256: 'c571742335d8b3d9a7a15773907d1b0c7d948ece274e88fa17bd77176ad52638',
      bytes: 17712716,
      archive: 'tar.gz',
    },
    {
      platform: 'linux-arm64',
      url: `${LR}/llama-${LLAMA_TAG}-bin-ubuntu-arm64.tar.gz`,
      sha256: '6a862c22bd58f8f86168e0ef7ed875166ad625d42f7cac9825d63b8c55af5c1e',
      bytes: 13828645,
      archive: 'tar.gz',
    },
    {
      platform: 'win32-x64',
      url: `${LR}/llama-${LLAMA_TAG}-bin-win-cpu-x64.zip`,
      sha256: 'b45d88c70124b1ca8d8969ce073e81bc22906946d2528cab56c09c7e66420fe2',
      bytes: 19501790,
      archive: 'zip',
    },
    {
      platform: 'win32-arm64',
      url: `${LR}/llama-${LLAMA_TAG}-bin-win-cpu-arm64.zip`,
      sha256: '4bb740aeb8b3463976ab0c1d71f91f3286acbd966970f0c19344e120fe43cdf5',
      bytes: 12371481,
      archive: 'zip',
    },
  ] as RuntimeAsset[],
};

export function runtimeFor(platform = process.platform, arch = process.arch): RuntimeAsset | null {
  return LLAMA_RUNTIME.assets.find((a) => a.platform === `${platform}-${arch}`) ?? null;
}

/** 按内存推荐：留出系统与应用自身的余量，选能放下的最大模型 */
export function recommend(totalRamGb: number, list: readonly LocalLlm[] = LOCAL_LLMS): LocalLlm {
  const fit = list.filter(
    (m) => m.minRamGb <= totalRamGb && m.family !== 'SmolLM2' && m.family !== 'Phi-4',
  );
  return (fit.length ? fit[fit.length - 1] : list[0]) as LocalLlm;
}

export function fitLevel(m: LocalLlm, totalRamGb: number): 'ok' | 'tight' | 'too-big' {
  if (totalRamGb >= m.minRamGb) return 'ok';
  if (totalRamGb >= m.minRamGb * 0.75) return 'tight';
  return 'too-big';
}

export function serverArgs(o: {
  model: string;
  port: number;
  ctx: number;
  threads?: number;
}): string[] {
  const a = [
    '-m',
    o.model,
    '--host',
    '127.0.0.1',
    '--port',
    String(o.port),
    '-c',
    String(o.ctx),
    '--jinja',
    '--no-webui',
  ];
  if (o.threads) a.push('-t', String(o.threads));
  return a;
}

export const SERVER_NAMES = process.platform === 'win32' ? ['llama-server.exe'] : ['llama-server'];
