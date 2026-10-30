// Package voice 对应 apps/desktop-electron/internal/core/src/voice（不含豆包 volcAsr 与主进程 Silero：见 D-B9）。
package voice

import (
	"runtime"
	"slices"
)

// Asset = VoiceAsset（catalog.ts）
type Asset struct {
	ID          string
	Kind        string
	Name        string
	Description string
	URL         string
	Sha256      string
	Bytes       int64
	License     string
	LicenseURL  string
	SourceURL   string
	Archive     string
	Platforms   []string
	FileName    string
}

// Assets = VOICE_ASSETS（版本 + sha256 钉死，与 Node 逐字一致）
var Assets = []Asset{
	{ID: "whisper-bin-win-x64", Kind: "whisper-bin", Name: "electron.common.whisper-cpp-engine-windows-x64-cpu", Description: "electron.common.official-prebuilt-whisper-cli-for-local-offline-recognition", URL: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip", Sha256: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb", Bytes: 8928640, License: "MIT", LicenseURL: "https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE", SourceURL: "https://github.com/ggml-org/whisper.cpp/releases/tag/b5454", Archive: "zip", Platforms: []string{"win32-x64"}},
	{ID: "whisper-bin-linux-x64", Kind: "whisper-bin", Name: "electron.common.whisper-cpp-engine-linux-x64", Description: "electron.common.official-prebuilt-whisper-cli-for-local-offline-recognition", URL: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-x64.tar.gz", Sha256: "a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c", Bytes: 10364195, License: "MIT", LicenseURL: "https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE", SourceURL: "https://github.com/ggml-org/whisper.cpp/releases/tag/b5454", Archive: "tar.gz", Platforms: []string{"linux-x64"}},
	{ID: "whisper-bin-linux-arm64", Kind: "whisper-bin", Name: "electron.common.whisper-cpp-engine-linux-arm64", Description: "electron.common.official-prebuilt-whisper-cli-for-local-offline-recognition", URL: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-arm64.tar.gz", Sha256: "6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149", Bytes: 4608377, License: "MIT", LicenseURL: "https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE", SourceURL: "https://github.com/ggml-org/whisper.cpp/releases/tag/b5454", Archive: "tar.gz", Platforms: []string{"linux-arm64"}},
	{ID: "ggml-tiny", Kind: "whisper-model", Name: "electron.common.whisper-tiny-multilingual-75-mb", Description: "electron.common.fastest-good-for-short-commands-chinese-accuracy-is", URL: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin", Sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21", Bytes: 77691713, License: "MIT", LicenseURL: "https://github.com/openai/whisper/blob/main/LICENSE", SourceURL: "https://huggingface.co/ggerganov/whisper.cpp", FileName: "ggml-tiny.bin"},
	{ID: "ggml-base", Kind: "whisper-model", Name: "electron.common.whisper-base-multilingual-148-mb", Description: "electron.common.balance-of-speed-and-accuracy-recommended", URL: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin", Sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe", Bytes: 147951465, License: "MIT", LicenseURL: "https://github.com/openai/whisper/blob/main/LICENSE", SourceURL: "https://huggingface.co/ggerganov/whisper.cpp", FileName: "ggml-base.bin"},
	{ID: "silero-vad", Kind: "vad", Name: "Silero VAD（2.3 MB）", Description: "electron.common.speech-detection-for-hands-free-mode-detects-when", URL: "https://raw.githubusercontent.com/snakers4/silero-vad/1e261b036686cd0017d500ee96acd1c4ba572a9d/src/silero_vad/data/silero_vad.onnx", Sha256: "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3", Bytes: 2327524, License: "MIT", LicenseURL: "https://github.com/snakers4/silero-vad/blob/master/LICENSE", SourceURL: "https://github.com/snakers4/silero-vad/tree/1e261b036686cd0017d500ee96acd1c4ba572a9d", FileName: "silero_vad.onnx"},
}

// NodePlatform / NodeArch：process.platform / process.arch 的取值
func NodePlatform() string {
	switch runtime.GOOS {
	case "windows":
		return "win32"
	}
	return runtime.GOOS
}

func NodeArch() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x64"
	case "386":
		return "ia32"
	}
	return runtime.GOARCH
}

// PlatformKey = platformKey()
func PlatformKey() string { return NodePlatform() + "-" + NodeArch() }

// AssetsFor = assetsFor(pk)
func AssetsFor(pk string) []Asset {
	out := []Asset{}
	for _, a := range Assets {
		if a.Platforms == nil || slices.Contains(a.Platforms, pk) {
			out = append(out, a)
		}
	}
	return out
}

// FindAsset = findAsset(id)
func FindAsset(id string) *Asset {
	for i := range Assets {
		if Assets[i].ID == id {
			a := Assets[i]
			return &a
		}
	}
	return nil
}
