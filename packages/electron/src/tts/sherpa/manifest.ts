/**
 * sherpa-onnx 本地离线 TTS 默认模型清单。
 * 模型不随安装包分发：开启语音时按需下载到 userData/tts-models（docs/design/tts-on-demand.md），
 * 不进 git；开发态指向仓库同级 ../models/<id> 或 NOMI_SHERPA_TTS_MODEL_DIR。
 * 开发启动若目录缺失/不完整，运行时从下方 URL 自动拉取（仅日志进度，无安装器 UI）。
 */
export interface ModelManifest {
  id: string;
  /** 归档下载 URL（k2-fsa/sherpa-onnx tts-models release） */
  url: string;
  sha256: string;
  /** 归档字节数（进度日志总量） */
  bytes: number;
  /** 归档内顶层目录（解压时剥掉） */
  topDir: string;
  /** 运行所需文件（相对模型目录）→ 精确字节数（完整性校验） */
  files: Readonly<Record<string, number>>;
}

/** 环境变量：覆盖 / 追加归档下载地址（镜像），多个用逗号 / 分号 / 空白分隔，按顺序尝试，最后兜底官方地址 */
export const SHERPA_MODEL_URL_ENV = 'NOMI_SHERPA_TTS_MODEL_URL';

export const SHERPA_MODEL_ID = 'vits-zh-hf-theresa';

export const SHERPA_MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-zh-hf-theresa.tar.bz2';

export const SHERPA_ARCHIVE_SHA256 =
  'f337638c49689e1d87135c4e224daa1aacc0109e784b1cf78eafb1b14a1d9e92';

export const SHERPA_ARCHIVE_BYTES = 120596617;

export const SHERPA_REQUIRED_FILES: Readonly<Record<string, number>> = Object.freeze({
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

export const SHERPA_MANIFEST: ModelManifest = Object.freeze({
  id: SHERPA_MODEL_ID,
  url: SHERPA_MODEL_URL,
  sha256: SHERPA_ARCHIVE_SHA256,
  bytes: SHERPA_ARCHIVE_BYTES,
  topDir: SHERPA_MODEL_ID,
  files: SHERPA_REQUIRED_FILES,
});

/** 默认推理参数：sid=0、speed=1.0（语速与参考样例一致，不加速） */
export const SHERPA_DEFAULT_SID = 0;
export const SHERPA_DEFAULT_SPEED = 1.0;
export const SHERPA_NUM_THREADS = 4;
export const SHERPA_MAX_NUM_SENTENCES = 1;
export const SHERPA_RULE_FSTS = ['phone.fst', 'date.fst', 'number.fst', 'new_heteronym.fst'];

/**
 * 解析下载地址列表：`NOMI_SHERPA_TTS_MODEL_URL`（可多个，镜像优先）→ 清单默认 URL（官方 GitHub）。
 * 只接受 http(s)；归档内容仍按清单 sha256 校验，镜像必须提供同一个 .tar.bz2。
 */
export function resolveModelUrls(
  manifest: ModelManifest,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env[SHERPA_MODEL_URL_ENV] ?? '';
  const urls = raw
    .split(/[\s,;]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u));
  if (!urls.includes(manifest.url)) urls.push(manifest.url);
  return urls;
}
