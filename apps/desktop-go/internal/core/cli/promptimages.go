package cli

import (
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// NormalizedImage = NormalizedImage（Source "" = 缺省）；AbsPath 仅 StagedImage 有。
type NormalizedImage struct {
	Mime    string
	Data    string
	Width   float64
	Height  float64
	Thumb   string
	Source  string
	AbsPath string
}

// Obj = 与 Node 对象同序的 JSON 形状（StagedImage 带 absPath）。
func (im NormalizedImage) Obj() *util.Obj {
	o := util.NewObj("mime", im.Mime, "data", im.Data, "width", im.Width, "height", im.Height, "thumb", im.Thumb)
	if im.Source != "" {
		o.Set("source", im.Source)
	}
	if im.AbsPath != "" {
		o.Set("absPath", im.AbsPath)
	}
	return o
}

type RejectedImage struct {
	Index  int
	Reason string
}

func ImageSupportFor(backend string) string {
	if backend == "dsh" {
		return "none"
	}
	return "full"
}

func UnsupportedImageMessage(backend string) string {
	name := map[string]string{"dsh": "dsh", "claude": "Claude Code", "codex": "Codex", "grok": "Grok", "gemini": "Gemini"}[backend]
	if name == "" {
		name = backend
	}
	return i18n.T("electron.common.the-cli-has-no-image-input-so-images", name)
}

func ModelNoVisionMessage(model string) string {
	return i18n.T("electron.common.the-current-model-doesn-t-support-images-remove", model)
}

func normalizeMime(mime string) string {
	m := util.JSLower(util.JSTrim(mime))
	switch m {
	case "image/jpg":
		return "image/jpeg"
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		return m
	}
	return ""
}

func extFor(mime string) string {
	switch mime {
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	}
	return ".jpg"
}

const (
	ImageDataMax     = 12_000_000
	ThumbFallbackMax = 600_000
)

var wsRun = util.JSRe(`\s+`)

// jsNumberOf = Number(v)。
func jsNumberOf(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0 // null；undefined 在 util.Obj 中读作 nil，Number(undefined)=NaN → ||0 同为 0
	case float64:
		return x
	case bool:
		if x {
			return 1
		}
		return 0
	case string:
		return util.ToNumber(x)
	}
	return math.NaN()
}

func strOrEmpty(v any) string {
	if v == nil {
		return ""
	}
	return util.JSString(v)
}

// InspectImages = inspectImages（raw 为 IPC 传来的数组；max 缺省 8）。
func InspectImages(raw []any, max int) ([]NormalizedImage, []RejectedImage) {
	images := []NormalizedImage{}
	rejected := []RejectedImage{}
	for index, rv := range raw {
		r, _ := rv.(*util.Obj)
		if r == nil {
			r = util.NewObj()
		}
		if len(images) >= max {
			rejected = append(rejected, RejectedImage{index, "over-max"})
			continue
		}
		mime := normalizeMime(strOrEmpty(r.Get("mime")))
		if mime == "" {
			rejected = append(rejected, RejectedImage{index, "mime"})
			continue
		}
		data := wsRun.ReplaceAllString(strOrEmpty(r.Get("data")), "")
		if data == "" {
			rejected = append(rejected, RejectedImage{index, "empty"})
			continue
		}
		n := clisdk.Len(data)
		if n > ImageDataMax {
			rejected = append(rejected, RejectedImage{index, "too-large"})
			continue
		}
		var thumb string
		if t, ok := r.Get("thumb").(string); ok && strings.HasPrefix(t, "data:") {
			thumb = t
		} else if n <= ThumbFallbackMax {
			thumb = "data:" + mime + ";base64," + data
		} else {
			rejected = append(rejected, RejectedImage{index, "no-thumb"})
			continue
		}
		w, h := jsNumberOf(r.Get("width")), jsNumberOf(r.Get("height"))
		if math.IsNaN(w) || w < 0 {
			w = 0
		}
		if math.IsNaN(h) || h < 0 {
			h = 0
		}
		im := NormalizedImage{Mime: mime, Data: data, Width: w + 0, Height: h + 0, Thumb: thumb}
		if s := r.Get("source"); util.Truthy(s) {
			im.Source = util.JSString(s)
		}
		images = append(images, im)
	}
	return images, rejected
}

func NormalizeImages(raw []any, max int) []NormalizedImage {
	im, _ := InspectImages(raw, max)
	return im
}

// RejectedImagesMessage = rejectedImagesMessage。
func RejectedImagesMessage(rejected []RejectedImage, max int) string {
	has := func(r string) bool {
		for _, x := range rejected {
			if x.Reason == r {
				return true
			}
		}
		return false
	}
	parts := []string{}
	if has("too-large") {
		parts = append(parts, i18n.T("electron.common.image-too-large-max-about-9mb-each"))
	}
	if has("no-thumb") {
		parts = append(parts, i18n.T("electron.common.image-has-no-preview-and-is-too-large"))
	}
	if has("mime") {
		parts = append(parts, i18n.T("electron.common.only-png-jpeg-webp-gif-images-are-supported"))
	}
	if has("empty") {
		parts = append(parts, i18n.T("electron.common.image-is-empty"))
	}
	if has("over-max") {
		parts = append(parts, i18n.T("electron.common.at-most-images-per-message", float64(max)))
	}
	return i18n.T("electron.common.image-s-can-t-be-sent-remove-them", float64(len(rejected)), strings.Join(parts, "；"))
}

// StageImages = stageImages（失败时 Node 同步抛出 → error）。
func StageImages(dir string, images []NormalizedImage) ([]NormalizedImage, error) {
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return nil, err
	}
	out := []NormalizedImage{}
	for _, im := range images {
		file := filepath.Join(dir, clisdk.RandomUUID()+extFor(im.Mime))
		if err := os.WriteFile(file, nodeBase64(im.Data), 0o666); err != nil {
			return nil, err
		}
		im.AbsPath = file
		out = append(out, im)
	}
	return out, nil
}

func ImageThumbsForMessage(images []NormalizedImage) []any {
	out := []any{}
	for _, im := range images {
		o := util.NewObj("thumb", im.Thumb, "width", im.Width, "height", im.Height)
		if im.Source != "" {
			o.Set("source", im.Source)
		}
		out = append(out, o)
	}
	return out
}

func ClaudeContentBlocks(text string, images []NormalizedImage) []any {
	blocks := []any{}
	for _, im := range images {
		blocks = append(blocks, util.NewObj("type", "image", "source", util.NewObj("type", "base64", "media_type", im.Mime, "data", im.Data)))
	}
	if util.JSTrim(text) != "" {
		blocks = append(blocks, util.NewObj("type", "text", "text", text))
	} else if len(blocks) == 0 {
		blocks = append(blocks, util.NewObj("type", "text", "text", ""))
	}
	return blocks
}

func CodexTurnInput(text string, staged []NormalizedImage) []any {
	in := []any{util.NewObj("type", "text", "text", text, "text_elements", []any{})}
	for _, im := range staged {
		in = append(in, util.NewObj("type", "localImage", "path", im.AbsPath))
	}
	return in
}

func CodexImageArgs(staged []NormalizedImage) []string {
	args := []string{}
	for _, im := range staged {
		args = append(args, "--image", im.AbsPath)
	}
	return args
}

func AcpPromptParts(text string, images []NormalizedImage) []any {
	parts := []any{}
	if util.JSTrim(text) != "" {
		parts = append(parts, util.NewObj("type", "text", "text", text))
	}
	for _, im := range images {
		parts = append(parts, util.NewObj("type", "image", "mimeType", im.Mime, "data", im.Data))
	}
	if len(parts) == 0 {
		parts = append(parts, util.NewObj("type", "text", "text", ""))
	}
	return parts
}

func GrokPromptFileArgv(dir, text string, images []NormalizedImage) ([]string, error) {
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return nil, err
	}
	file := filepath.Join(dir, "grok-prompt-"+clisdk.RandomUUID()+".json")
	if err := os.WriteFile(file, []byte(util.Stringify(AcpPromptParts(text, images))), 0o600); err != nil {
		return nil, err
	}
	return []string{"--prompt-file", file}, nil
}

func CleanupStagedDir(dir string) { _ = os.RemoveAll(dir) }
