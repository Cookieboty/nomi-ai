package media

// auto.go：图片模型的识别与自动匹配（Nomi 没指定图片模型时按对话模型挑）。
// 规则：同家族优先（对话模型所在的供应商优先）；没有同家族的按 gpt → gemini → … 顺次；
// 同家族同供应商取版本最新的；只考虑端点规则能处理的模型。

import (
	"regexp"
	"sort"
	"strings"
	"unicode"
)

var imageFamilies = regexp.MustCompile(`^(?:doubao-|bytedance-|stability-|bfl-)?(gpt-image|chatgpt-image|dall-?e|imagen|flux|stable-diffusion|sdxl|sd-?3|midjourney|mj-|seedream|seededit|jimeng|cogview|wanx|wan\d.*-t2i|kolors|recraft|ideogram|hidream|playground-v)`)

// Go RE2 没有前瞻：image 段后面必须是结尾或 - _ . 数字
var imageSegment = regexp.MustCompile(`(^|[-_.])image($|[-_.\d])`)

func baseName(id string) string {
	n := strings.ToLower(id)
	return n[strings.LastIndex(n, "/")+1:]
}

// IsImageModelID = isImageModelId
func IsImageModelID(id string) bool {
	b := baseName(id)
	return imageFamilies.MatchString(b) || imageSegment.MatchString(b)
}

// ImageFamilyFallback = IMAGE_FAMILY_FALLBACK
var ImageFamilyFallback = []string{"openai", "google", "bytedance", "qwen", "xai", "other"}

var (
	chatOpenAI = regexp.MustCompile(`^(gpt|chatgpt|o\d|codex)`)
	chatGoogle = regexp.MustCompile(`^(gemini|gemma)`)
	chatByte   = regexp.MustCompile(`^(doubao|seed)`)
	chatQwen   = regexp.MustCompile(`^(qwen|qwq|qvq)`)
	imgOpenAI  = regexp.MustCompile(`^(gpt-image|chatgpt-image|dall-?e)`)
	imgGoogle  = regexp.MustCompile(`^(gemini|imagen)`)
	imgByte    = regexp.MustCompile(`(seedream|seededit|jimeng)`)
	imgQwen    = regexp.MustCompile(`^(qwen|wanx|wan\d)`)
)

// ChatModelFamily = chatModelFamily（认不出为 ""）
func ChatModelFamily(id string) string {
	b := strings.TrimPrefix(baseName(id), "models/")
	switch {
	case chatOpenAI.MatchString(b):
		return "openai"
	case chatGoogle.MatchString(b):
		return "google"
	case chatByte.MatchString(b):
		return "bytedance"
	case chatQwen.MatchString(b):
		return "qwen"
	case strings.HasPrefix(b, "grok"):
		return "xai"
	}
	return ""
}

// ImageModelFamily = imageModelFamily
func ImageModelFamily(id string) string {
	b := strings.TrimPrefix(baseName(id), "models/")
	switch {
	case imgOpenAI.MatchString(b):
		return "openai"
	case imgGoogle.MatchString(b):
		return "google"
	case imgByte.MatchString(b):
		return "bytedance"
	case imgQwen.MatchString(b):
		return "qwen"
	case strings.HasPrefix(b, "grok"):
		return "xai"
	}
	return "other"
}

type AutoProvider struct {
	Info   ProviderInfo
	Models []string
}

// naturalLess：按数字段自然排序（Intl.Collator numeric），大小写不敏感
func naturalLess(a, b string) bool {
	a, b = strings.ToLower(a), strings.ToLower(b)
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		ca, cb := rune(a[i]), rune(b[j])
		if unicode.IsDigit(ca) && unicode.IsDigit(cb) {
			si := i
			for i < len(a) && unicode.IsDigit(rune(a[i])) {
				i++
			}
			sj := j
			for j < len(b) && unicode.IsDigit(rune(b[j])) {
				j++
			}
			na, nb := strings.TrimLeft(a[si:i], "0"), strings.TrimLeft(b[sj:j], "0")
			if len(na) != len(nb) {
				return len(na) < len(nb)
			}
			if na != nb {
				return na < nb
			}
			continue
		}
		if ca != cb {
			return ca < cb
		}
		i++
		j++
	}
	return len(a)-i < len(b)-j
}

// AutoImageModel = autoImageModel：返回 `供应商/模型`；一个可用的都没有返回 ""
func AutoImageModel(mainRef string, providers []AutoProvider) string {
	mainProvider, want := "", ""
	if i := strings.Index(mainRef, "/"); i > 0 {
		mainProvider, want = mainRef[:i], ChatModelFamily(mainRef[i+1:])
	}
	type cand struct{ ref, provider, model, family string }
	var cands []cand
	for _, p := range providers {
		for _, m := range p.Models {
			if IsImageModelID(m) && Resolve(p.Info, m, nil) != nil {
				cands = append(cands, cand{p.Info.ID + "/" + m, p.Info.ID, m, ImageModelFamily(m)})
			}
		}
	}
	if len(cands) == 0 {
		return ""
	}
	order := []string{}
	if want != "" {
		order = append(order, want)
	}
	for _, f := range ImageFamilyFallback {
		if f != want {
			order = append(order, f)
		}
	}
	providerOrder := func(id string) int {
		if id == mainProvider {
			return -1
		}
		for i, p := range providers {
			if p.Info.ID == id {
				return i
			}
		}
		return len(providers)
	}
	for _, f := range order {
		var hits []cand
		for _, c := range cands {
			if c.family == f {
				hits = append(hits, c)
			}
		}
		if len(hits) == 0 {
			continue
		}
		sort.SliceStable(hits, func(i, j int) bool {
			pi, pj := providerOrder(hits[i].provider), providerOrder(hits[j].provider)
			if pi != pj {
				return pi < pj
			}
			return naturalLess(baseName(hits[j].model), baseName(hits[i].model))
		})
		return hits[0].ref
	}
	return ""
}
