package knowledge

// OcrAsset：OCR 语言数据（按需下载）；tesseract-ocr/tessdata_fast 钉死提交 + sha256
type OcrAsset struct {
	ID          string `json:"id"`
	Lang        string `json:"lang"`
	Name        string `json:"name"`
	Description string `json:"description"`
	URL         string `json:"url"`
	Sha256      string `json:"sha256"`
	Bytes       int64  `json:"bytes"`
	License     string `json:"license"`
	LicenseURL  string `json:"licenseUrl"`
	SourceURL   string `json:"sourceUrl"`
	FileName    string `json:"fileName"`
}

const tessdataCommit = "87416418657359cb625c412a48b6e1d6d41c29bd"
const rawBase = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/" + tessdataCommit

var OcrAssets = []OcrAsset{
	{"ocr-eng", "eng", "electron.common.ocr-english-data",
		"electron.common.tesseract-english-fast-language-model-for-recognizing-english",
		rawBase + "/eng.traineddata", "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2", 4113088,
		"Apache-2.0", "https://github.com/tesseract-ocr/tessdata_fast/blob/main/LICENSE",
		"https://github.com/tesseract-ocr/tessdata_fast/tree/" + tessdataCommit, "eng.traineddata"},
	{"ocr-chi_sim", "chi_sim", "electron.common.ocr-simplified-chinese-data",
		"electron.common.tesseract-simplified-chinese-fast-language-model-for-recognizing",
		rawBase + "/chi_sim.traineddata", "a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730", 2469156,
		"Apache-2.0", "https://github.com/tesseract-ocr/tessdata_fast/blob/main/LICENSE",
		"https://github.com/tesseract-ocr/tessdata_fast/tree/" + tessdataCommit, "chi_sim.traineddata"},
}

var ImageExts = map[string]bool{"png": true, "jpg": true, "jpeg": true, "webp": true, "bmp": true, "tif": true, "tiff": true, "gif": true}
