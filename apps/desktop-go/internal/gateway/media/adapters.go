package media

import (
	"net/url"
	"strconv"
	"strings"
)

// 各适配器与 Node adapters/* 一一对应

var OpenAIImages = &Adapter{
	ID: "openai-images", Auth: AuthBearer, Edit: true,
	Build: func(i GenInput) HTTPRequest {
		if len(i.Refs) > 0 {
			// 改图 / 参考图：/images/edits，multipart，图片放 image[]
			f := map[string]string{"model": i.Model, "prompt": i.Prompt, "n": "1"}
			if s := OpenAISizeFor(i.Aspect); s != "" {
				f["size"] = s
			}
			files := []MultipartFile{}
			for n, r := range i.Refs {
				ext := "png"
				if p := strings.SplitN(r.Mime, "/", 2); len(p) == 2 && p[1] != "" {
					ext = p[1]
				}
				files = append(files, MultipartFile{Field: "image[]", Name: "image-" + strconv.Itoa(n) + "." + ext, Mime: r.Mime, B64: r.B64})
			}
			return HTTPRequest{Method: "POST", URL: trimSlash(i.BaseURL) + "/images/edits", Multipart: &Multipart{Fields: f, Files: files}}
		}
		b := map[string]any{"model": i.Model, "prompt": i.Prompt, "n": 1}
		if s := OpenAISizeFor(i.Aspect); s != "" {
			b["size"] = s
		}
		return HTTPRequest{Method: "POST", URL: trimSlash(i.BaseURL) + "/images/generations", Body: b}
	},
	Parse: func(body any, _ GenInput) Parse {
		data := arr(obj(body)["data"])
		p := Parse{Kind: "images", Images: dataImages(data)}
		if len(data) > 0 {
			p.RevisedPrompt = str(data[0]["revised_prompt"])
		}
		return p
	},
}

var ArkImage = &Adapter{
	ID: "ark-image", Auth: AuthBearer, Edit: true,
	Build: func(i GenInput) HTTPRequest {
		b := map[string]any{
			"model": i.Model, "prompt": i.Prompt, "size": PixelSizeFor(i.Aspect, 2048, "x"),
			"response_format": "b64_json", "watermark": false, "sequential_image_generation": "disabled",
		}
		if len(i.Refs) > 0 {
			imgs := []any{}
			for _, r := range i.Refs {
				imgs = append(imgs, "data:"+r.Mime+";base64,"+r.B64)
			}
			b["image"] = imgs
		}
		return HTTPRequest{Method: "POST", URL: trimSlash(i.BaseURL) + "/images/generations", Body: b}
	},
	Parse: func(body any, _ GenInput) Parse {
		return Parse{Kind: "images", Images: dataImages(arr(obj(body)["data"]))}
	},
}

func modelPath(m string) string { return url.PathEscape(strings.TrimPrefix(m, "models/")) }

var Gemini = &Adapter{
	ID: "gemini", Auth: AuthGoog, Edit: true,
	Build: func(i GenInput) HTTPRequest {
		gc := map[string]any{"responseModalities": []any{"TEXT", "IMAGE"}}
		if i.Aspect != "auto" && i.Aspect != "" {
			gc["imageConfig"] = map[string]any{"aspectRatio": i.Aspect}
		}
		return HTTPRequest{Method: "POST", URL: trimSlash(i.BaseURL) + "/models/" + modelPath(i.Model) + ":generateContent",
			Body: map[string]any{
				"contents":         []any{map[string]any{"role": "user", "parts": geminiParts(i)}},
				"generationConfig": gc,
			}}
	},
	Parse: func(body any, _ GenInput) Parse {
		out := []Image{}
		for _, c := range arr(obj(body)["candidates"]) {
			for _, p := range arr(obj(c["content"])["parts"]) {
				d := obj(p["inlineData"])
				if d == nil {
					d = obj(p["inline_data"])
				}
				if s := str(d["data"]); s != "" {
					m := str(d["mimeType"])
					if m == "" {
						m = str(d["mime_type"])
					}
					out = append(out, Image{B64: s, Mime: m})
				}
			}
		}
		return Parse{Kind: "images", Images: out}
	},
}

var Imagen = &Adapter{
	ID: "imagen", Auth: AuthGoog,
	Build: func(i GenInput) HTTPRequest {
		params := map[string]any{"sampleCount": 1}
		if i.Aspect != "auto" && i.Aspect != "" {
			params["aspectRatio"] = i.Aspect
		}
		return HTTPRequest{Method: "POST", URL: trimSlash(i.BaseURL) + "/models/" + modelPath(i.Model) + ":predict",
			Body: map[string]any{"instances": []any{map[string]any{"prompt": i.Prompt}}, "parameters": params}}
	},
	Parse: func(body any, _ GenInput) Parse {
		out := []Image{}
		for _, p := range arr(obj(body)["predictions"]) {
			if b := str(p["bytesBase64Encoded"]); b != "" {
				out = append(out, Image{B64: b, Mime: str(p["mimeType"])})
			}
		}
		return Parse{Kind: "images", Images: out}
	},
}

var OpenRouterChatImage = &Adapter{
	ID: "openrouter-chat-image", Auth: AuthBearer, Edit: true,
	Build: func(i GenInput) HTTPRequest {
		var content any = i.Prompt
		if len(i.Refs) > 0 {
			parts := []any{map[string]any{"type": "text", "text": i.Prompt}}
			for _, r := range i.Refs {
				parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:" + r.Mime + ";base64," + r.B64}})
			}
			content = parts
		}
		b := map[string]any{"model": i.Model, "modalities": []any{"image", "text"},
			"messages": []any{map[string]any{"role": "user", "content": content}}}
		if i.Aspect != "auto" && i.Aspect != "" {
			b["image_config"] = map[string]any{"aspect_ratio": i.Aspect}
		}
		return HTTPRequest{Method: "POST", URL: trimSlash(i.BaseURL) + "/chat/completions", Body: b}
	},
	Parse: func(body any, _ GenInput) Parse {
		out := []Image{}
		for _, c := range arr(obj(body)["choices"]) {
			for _, im := range arr(obj(c["message"])["images"]) {
				if u := str(obj(im["image_url"])["url"]); u != "" {
					out = append(out, fromDataURL(u))
				}
			}
		}
		return Parse{Kind: "images", Images: out}
	},
}

var falSize = map[string]string{"1:1": "square_hd", "3:2": "landscape_4_3", "2:3": "portrait_4_3", "16:9": "landscape_16_9", "9:16": "portrait_16_9"}

var Fal = &Adapter{
	ID: "fal", Auth: AuthKey,
	Build: func(i GenInput) HTTPRequest {
		b := map[string]any{"prompt": i.Prompt, "num_images": 1, "sync_mode": true}
		if s := falSize[i.Aspect]; s != "" {
			b["image_size"] = s
		}
		return HTTPRequest{Method: "POST", URL: trimSlash(i.BaseURL) + "/" + strings.TrimLeft(i.Model, "/"), Body: b}
	},
	Parse: func(body any, _ GenInput) Parse {
		out := []Image{}
		for _, im := range arr(obj(body)["images"]) {
			if u := str(im["url"]); u != "" {
				img := fromDataURL(u)
				if ct := str(im["content_type"]); ct != "" {
					img.Mime = ct
				}
				out = append(out, img)
			}
		}
		return Parse{Kind: "images", Images: out}
	},
}

var dashSize = map[string]string{"1:1": "1024*1024", "3:2": "1440*960", "2:3": "960*1440", "16:9": "1280*720", "9:16": "720*1280"}

var DashScope = &Adapter{
	ID: "dashscope-async", Auth: AuthBearer, TimeoutMs: 180_000,
	Build: func(i GenInput) HTTPRequest {
		params := map[string]any{"n": 1}
		if s := dashSize[i.Aspect]; s != "" {
			params["size"] = s
		}
		return HTTPRequest{Method: "POST", URL: trimSlash(i.BaseURL) + "/api/v1/services/aigc/text2image/image-synthesis",
			Headers: map[string]string{"X-DashScope-Async": "enable"},
			Body:    map[string]any{"model": i.Model, "input": map[string]any{"prompt": i.Prompt}, "parameters": params}}
	},
	Parse: func(body any, i GenInput) Parse {
		out := obj(obj(body)["output"])
		status, id := str(out["task_status"]), str(out["task_id"])
		switch status {
		case "SUCCEEDED":
			imgs := []Image{}
			for _, r := range arr(out["results"]) {
				if u := str(r["url"]); u != "" {
					imgs = append(imgs, Image{URL: u})
				}
			}
			return Parse{Kind: "images", Images: imgs}
		case "FAILED", "CANCELED", "UNKNOWN":
			msg := str(out["message"])
			if msg == "" {
				msg = status
			}
			return Parse{Kind: "failed", Message: msg}
		}
		if id != "" {
			return Parse{Kind: "poll", AfterMs: 2000,
				Next: &HTTPRequest{Method: "GET", URL: trimSlash(i.BaseURL) + "/api/v1/tasks/" + url.PathEscape(id)}}
		}
		return Parse{Kind: "images", Images: []Image{}}
	},
}

// geminiParts：参考图作为 inline_data 放在文字前面
func geminiParts(i GenInput) []any {
	parts := []any{}
	for _, r := range i.Refs {
		parts = append(parts, map[string]any{"inline_data": map[string]any{"mime_type": r.Mime, "data": r.B64}})
	}
	return append(parts, map[string]any{"text": i.Prompt})
}

// Adapters：注册表（id → 适配器）
var Adapters = map[string]*Adapter{}

func init() {
	for _, a := range []*Adapter{OpenAIImages, ArkImage, Gemini, Imagen, OpenRouterChatImage, Fal, DashScope} {
		Adapters[a.ID] = a
	}
}
