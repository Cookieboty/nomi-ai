package knowledge

import (
	"math"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
)

type KbSource struct {
	ID      string  `json:"id"`
	Kind    string  `json:"kind"`
	Path    string  `json:"path"`
	AddedAt float64 `json:"addedAt"`
	Enabled bool    `json:"enabled"`
}

type KbModelRef struct {
	Enabled    bool   `json:"enabled"`
	ProviderID string `json:"providerId"`
	Model      string `json:"model"`
}

type KbOcr struct {
	Enabled bool     `json:"enabled"`
	Langs   []string `json:"langs"`
}

type KbSettings struct {
	Sources      []KbSource `json:"sources"`
	Embed        KbModelRef `json:"embed"`
	Rerank       KbModelRef `json:"rerank"`
	Ocr          KbOcr      `json:"ocr"`
	CloudConsent []string   `json:"cloudConsent"`
	TopK         int        `json:"topK"`
}

func DefaultKbSettings() KbSettings {
	return KbSettings{Sources: []KbSource{}, Ocr: KbOcr{Langs: []string{"chi_sim", "eng"}}, CloudConsent: []string{}, TopK: 6}
}

func obj(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func str(v any, max int) string {
	if s, ok := v.(string); ok {
		return deps.Slice0(s, max)
	}
	return ""
}

func modelRef(v any) KbModelRef {
	o := obj(v)
	return KbModelRef{Enabled: o["enabled"] == true, ProviderID: str(o["providerId"], 200), Model: str(o["model"], 200)}
}

// SanitizeKbSettings：raw 为 JSON 解出的任意值
func SanitizeKbSettings(raw any) KbSettings {
	o := obj(raw)
	out := KbSettings{Sources: []KbSource{}, CloudConsent: []string{}}
	if arr, ok := o["sources"].([]any); ok {
		for _, x := range arr {
			s, ok := x.(map[string]any)
			if !ok {
				continue
			}
			id, ok1 := s["id"].(string)
			p, ok2 := s["path"].(string)
			if !ok1 || s["kind"] != "folder" || !ok2 || p == "" {
				continue
			}
			at, _ := s["addedAt"].(float64)
			out.Sources = append(out.Sources, KbSource{ID: id, Kind: "folder", Path: p, AddedAt: at, Enabled: s["enabled"] != false})
		}
	}
	out.Embed, out.Rerank = modelRef(o["embed"]), modelRef(o["rerank"])
	ocr := obj(o["ocr"])
	langs := []string{"chi_sim", "eng"}
	if arr, ok := ocr["langs"].([]any); ok {
		langs = []string{}
		for _, l := range arr {
			if l == "eng" || l == "chi_sim" {
				langs = append(langs, l.(string))
			}
		}
	}
	if len(langs) == 0 {
		langs = []string{"eng"}
	}
	out.Ocr = KbOcr{Enabled: ocr["enabled"] == true, Langs: langs}
	if arr, ok := o["cloudConsent"].([]any); ok {
		for _, x := range arr {
			if s, ok := x.(string); ok {
				out.CloudConsent = append(out.CloudConsent, s)
			}
		}
	}
	topK := 6.0
	if n, ok := o["topK"].(float64); ok {
		topK = math.Floor(n + 0.5)
	}
	out.TopK = int(math.Min(12, math.Max(2, topK)))
	return out
}
