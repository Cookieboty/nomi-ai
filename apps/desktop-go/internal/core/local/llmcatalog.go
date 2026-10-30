// Package local 移植 apps/desktop-electron/internal/core/src/local：本地模型目录 / llama-server / Ollama / 本地数据导出。
package local

import (
	"runtime"
	"strconv"
)

type LocalLlm struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Family      string `json:"family"`
	Params      string `json:"params"`
	Quant       string `json:"quant"`
	Description string `json:"description"`
	URL         string `json:"url"`
	Sha256      string `json:"sha256"`
	Bytes       int64  `json:"bytes"`
	License     string `json:"license"`
	LicenseURL  string `json:"licenseUrl"`
	SourceURL   string `json:"sourceUrl"`
	MinRamGb    int    `json:"minRamGb"`
	Ctx         int    `json:"ctx"`
}

const hf = "https://huggingface.co"

func hr(repo, file string) string { return hf + "/" + repo + "/resolve/main/" + file }

var LocalLlms = []LocalLlm{
	{"qwen3-0.6b-q8", "Qwen3 0.6B", "Qwen3", "0.6B", "Q8_0", "electron.common.smallest-and-fastest-good-for-chit-chat-and", hr("Qwen/Qwen3-0.6B-GGUF", "Qwen3-0.6B-Q8_0.gguf"), "9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031", 639446688, "Apache-2.0", hf + "/Qwen/Qwen3-0.6B/blob/main/LICENSE", hf + "/Qwen/Qwen3-0.6B-GGUF", 4, 8192},
	{"qwen2.5-1.5b-q4km", "Qwen2.5 1.5B Instruct", "Qwen2.5", "1.5B", "Q4_K_M", "electron.common.solid-chinese-performance-small-size", hr("Qwen/Qwen2.5-1.5B-Instruct-GGUF", "qwen2.5-1.5b-instruct-q4_k_m.gguf"), "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e", 1117320736, "Apache-2.0", hf + "/Qwen/Qwen2.5-1.5B-Instruct/blob/main/LICENSE", hf + "/Qwen/Qwen2.5-1.5B-Instruct-GGUF", 6, 8192},
	{"smollm2-1.7b-q4km", "SmolLM2 1.7B Instruct", "SmolLM2", "1.7B", "Q4_K_M", "electron.common.lightweight-english-focused-model-fast", hr("HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF", "smollm2-1.7b-instruct-q4_k_m.gguf"), "decd2598bc2c8ed08c19adc3c8fdd461ee19ed5708679d1c54ef54a5a30d4f33", 1055609536, "Apache-2.0", hf + "/HuggingFaceTB/SmolLM2-1.7B-Instruct", hf + "/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF", 6, 8192},
	{"qwen3-1.7b-q8", "Qwen3 1.7B", "Qwen3", "1.7B", "Q8_0", "electron.common.recommended-for-8-gb-of-memory-good-in", hr("Qwen/Qwen3-1.7B-GGUF", "Qwen3-1.7B-Q8_0.gguf"), "061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a", 1834426016, "Apache-2.0", hf + "/Qwen/Qwen3-1.7B/blob/main/LICENSE", hf + "/Qwen/Qwen3-1.7B-GGUF", 8, 8192},
	{"qwen3-4b-q4km", "Qwen3 4B", "Qwen3", "4B", "Q4_K_M", "electron.common.recommended-for-16-gb-of-memory-noticeably-stronger", hr("Qwen/Qwen3-4B-GGUF", "Qwen3-4B-Q4_K_M.gguf"), "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5", 2497280256, "Apache-2.0", hf + "/Qwen/Qwen3-4B/blob/main/LICENSE", hf + "/Qwen/Qwen3-4B-GGUF", 12, 8192},
	{"phi4-mini-q4km", "Phi-4 mini Instruct", "Phi-4", "3.8B", "Q4_K_M", "electron.common.strong-english-reasoning-and-code-gguf-converted-by", hr("unsloth/Phi-4-mini-instruct-GGUF", "Phi-4-mini-instruct-Q4_K_M.gguf"), "88c00229914083cd112853aab84ed51b87bdf6b9ce42f532d8c85c7c63b1730a", 2491874272, "MIT", hf + "/microsoft/Phi-4-mini-instruct/blob/main/LICENSE", hf + "/unsloth/Phi-4-mini-instruct-GGUF", 12, 8192},
}

type RuntimeAsset struct {
	Platform string `json:"platform"`
	URL      string `json:"url"`
	Sha256   string `json:"sha256"`
	Bytes    int64  `json:"bytes"`
	Archive  string `json:"archive"`
}

const LlamaTag = "b11565"
const lr = "https://github.com/ggml-org/llama.cpp/releases/download/" + LlamaTag

type llamaRuntime struct {
	Tag        string         `json:"tag"`
	License    string         `json:"license"`
	LicenseURL string         `json:"licenseUrl"`
	SourceURL  string         `json:"sourceUrl"`
	Assets     []RuntimeAsset `json:"assets"`
}

var LlamaRuntime = llamaRuntime{LlamaTag, "MIT", "https://github.com/ggml-org/llama.cpp/blob/master/LICENSE", "https://github.com/ggml-org/llama.cpp/releases/tag/" + LlamaTag, []RuntimeAsset{
	{"darwin-arm64", lr + "/llama-" + LlamaTag + "-bin-macos-arm64.tar.gz", "19289548468babcd5131cecccf3a9bc7c67030cc7f0a978dafc0db1ba7891068", 12105509, "tar.gz"},
	{"darwin-x64", lr + "/llama-" + LlamaTag + "-bin-macos-x64.tar.gz", "853c2c2ed9d796f3f6d0210aac7768a8398997cf2afdc9916a6112003b13760f", 11596850, "tar.gz"},
	{"linux-x64", lr + "/llama-" + LlamaTag + "-bin-ubuntu-x64.tar.gz", "c571742335d8b3d9a7a15773907d1b0c7d948ece274e88fa17bd77176ad52638", 17712716, "tar.gz"},
	{"linux-arm64", lr + "/llama-" + LlamaTag + "-bin-ubuntu-arm64.tar.gz", "6a862c22bd58f8f86168e0ef7ed875166ad625d42f7cac9825d63b8c55af5c1e", 13828645, "tar.gz"},
	{"win32-x64", lr + "/llama-" + LlamaTag + "-bin-win-cpu-x64.zip", "b45d88c70124b1ca8d8969ce073e81bc22906946d2528cab56c09c7e66420fe2", 19501790, "zip"},
	{"win32-arm64", lr + "/llama-" + LlamaTag + "-bin-win-cpu-arm64.zip", "4bb740aeb8b3463976ab0c1d71f91f3286acbd966970f0c19344e120fe43cdf5", 12371481, "zip"},
}}

// NodePlatform / NodeArch：Go 的 GOOS/GOARCH → process.platform / process.arch
func NodePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

func NodeArch() string {
	if runtime.GOARCH == "amd64" {
		return "x64"
	}
	return runtime.GOARCH
}

func RuntimeFor(platform, arch string) *RuntimeAsset {
	for i := range LlamaRuntime.Assets {
		if LlamaRuntime.Assets[i].Platform == platform+"-"+arch {
			a := LlamaRuntime.Assets[i]
			return &a
		}
	}
	return nil
}

func Recommend(totalRamGb float64, list []LocalLlm) LocalLlm {
	if list == nil {
		list = LocalLlms
	}
	var fit []LocalLlm
	for _, m := range list {
		if float64(m.MinRamGb) <= totalRamGb && m.Family != "SmolLM2" && m.Family != "Phi-4" {
			fit = append(fit, m)
		}
	}
	if len(fit) > 0 {
		return fit[len(fit)-1]
	}
	return list[0]
}

func FitLevel(m LocalLlm, totalRamGb float64) string {
	if totalRamGb >= float64(m.MinRamGb) {
		return "ok"
	}
	if totalRamGb >= float64(m.MinRamGb)*0.75 {
		return "tight"
	}
	return "too-big"
}

func ServerArgs(model string, port, ctx, threads int) []string {
	a := []string{"-m", model, "--host", "127.0.0.1", "--port", strconv.Itoa(port), "-c", strconv.Itoa(ctx), "--jinja", "--no-webui"}
	if threads != 0 {
		a = append(a, "-t", strconv.Itoa(threads))
	}
	return a
}

func ServerNames() []string {
	if runtime.GOOS == "windows" {
		return []string{"llama-server.exe"}
	}
	return []string{"llama-server"}
}
