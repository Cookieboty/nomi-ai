/**
 * OCR 语言数据（按需下载，不随安装包分发）：tesseract-ocr/tessdata_fast（Apache-2.0），钉死提交 + sha256。
 * 识别引擎 tesseract.js（Apache-2.0，含 tesseract.js-core WASM）随应用依赖安装。
 */
export interface OcrAsset {
  id: string;
  lang: string;
  name: string;
  description: string;
  url: string;
  sha256: string;
  bytes: number;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
  fileName: string;
}

const TESSDATA_COMMIT = '87416418657359cb625c412a48b6e1d6d41c29bd';
const RAW = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_COMMIT}`;

export const OCR_ASSETS: readonly OcrAsset[] = Object.freeze([
  {
    id: 'ocr-eng',
    lang: 'eng',
    name: 'electron.common.ocr-english-data',
    description: 'electron.common.tesseract-english-fast-language-model-for-recognizing-english',
    url: `${RAW}/eng.traineddata`,
    sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2',
    bytes: 4113088,
    license: 'Apache-2.0',
    licenseUrl: 'https://github.com/tesseract-ocr/tessdata_fast/blob/main/LICENSE',
    sourceUrl: `https://github.com/tesseract-ocr/tessdata_fast/tree/${TESSDATA_COMMIT}`,
    fileName: 'eng.traineddata',
  },
  {
    id: 'ocr-chi_sim',
    lang: 'chi_sim',
    name: 'electron.common.ocr-simplified-chinese-data',
    description: 'electron.common.tesseract-simplified-chinese-fast-language-model-for-recognizing',
    url: `${RAW}/chi_sim.traineddata`,
    sha256: 'a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730',
    bytes: 2469156,
    license: 'Apache-2.0',
    licenseUrl: 'https://github.com/tesseract-ocr/tessdata_fast/blob/main/LICENSE',
    sourceUrl: `https://github.com/tesseract-ocr/tessdata_fast/tree/${TESSDATA_COMMIT}`,
    fileName: 'chi_sim.traineddata',
  },
]);

export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'gif']);
