package media

import (
	"reflect"
	"regexp"
	"testing"
)

func pick(t *testing.T, p ProviderInfo, model string) *Endpoint {
	t.Helper()
	return Resolve(p, model, nil)
}

func TestResolveRelayFallsBackToOpenAIImages(t *testing.T) {
	e := pick(t, ProviderInfo{URLs: map[string]string{"chat": "https://amux.ai/v1"}}, "openai/gpt-image-2")
	if e == nil || e.Adapter.ID != "openai-images" || e.BaseURL != "https://amux.ai/v1" || e.Wire != "chat" || e.Auth != AuthBearer {
		t.Fatalf("%+v", e)
	}
}

func TestResolveRelayGeminiWire(t *testing.T) {
	relay := ProviderInfo{URLs: map[string]string{"chat": "https://amux.ai/v1", "gemini": "https://amux.ai/v1beta"},
		Auth: map[string]string{"gemini": "bearer"}}
	e := pick(t, relay, "gemini-2.5-flash-image")
	if e.Adapter.ID != "gemini" || e.BaseURL != "https://amux.ai/v1beta" || e.Auth != "bearer" {
		t.Fatalf("%+v", e)
	}
	if e := pick(t, ProviderInfo{URLs: map[string]string{"chat": "https://amux.ai/v1"}}, "gemini-2.5-flash-image"); e.Adapter.ID != "openai-images" {
		t.Fatal(e.Adapter.ID)
	}
}

func TestResolveVendorSpecific(t *testing.T) {
	google := ProviderInfo{PresetID: "gemini", URLs: map[string]string{
		"chat": "https://generativelanguage.googleapis.com/v1beta/openai", "gemini": "https://generativelanguage.googleapis.com/v1beta"}}
	if e := pick(t, google, "models/imagen-4.0-generate-001"); e.Adapter.ID != "imagen" || e.Auth != AuthGoog {
		t.Fatalf("%+v", e)
	}
	if e := pick(t, google, "gemini-2.5-flash-image"); e.Adapter.ID != "gemini" {
		t.Fatal(e.Adapter.ID)
	}
	if e := pick(t, ProviderInfo{URLs: map[string]string{"chat": "https://ark.cn-beijing.volces.com/api/v3"}}, "doubao-seedream-4-0-250828"); e.Adapter.ID != "ark-image" {
		t.Fatal(e.Adapter.ID)
	}
	ds := pick(t, ProviderInfo{URLs: map[string]string{"chat": "https://dashscope.aliyuncs.com/compatible-mode/v1"}}, "wan2.2-t2i-flash")
	if ds.Adapter.ID != "dashscope-async" || ds.BaseURL != "https://dashscope.aliyuncs.com" {
		t.Fatalf("%+v", ds)
	}
	if e := pick(t, ProviderInfo{URLs: map[string]string{"chat": "https://openrouter.ai/api/v1"}}, "google/gemini-2.5-flash-image"); e.Adapter.ID != "openrouter-chat-image" {
		t.Fatal(e.Adapter.ID)
	}
	if e := pick(t, ProviderInfo{PresetID: "fal", URLs: map[string]string{"chat": "https://fal.run"}}, "fal-ai/flux-pro/v1.1"); e.Adapter.ID != "fal" || e.Auth != AuthKey {
		t.Fatalf("%+v", e)
	}
	if Resolve(ProviderInfo{URLs: map[string]string{}}, "gpt-image-2", nil) != nil {
		t.Fatal("no urls")
	}
	custom := Resolve(ProviderInfo{URLs: map[string]string{"chat": "https://my.example/v1"}}, "x",
		[]Rule{{Adapter: "fal", Host: regexp.MustCompile(`my\.example$`)}})
	if custom == nil || custom.Adapter.ID != "fal" {
		t.Fatal("custom rules")
	}
}

func in(o GenInput) GenInput {
	if o.BaseURL == "" {
		o.BaseURL = "https://api.example.com/v1/"
	}
	if o.Model == "" {
		o.Model = "m"
	}
	if o.Prompt == "" {
		o.Prompt = "a red fox"
	}
	if o.Aspect == "" {
		o.Aspect = "1:1"
	}
	return o
}

func TestAdapters(t *testing.T) {
	r := OpenAIImages.Build(in(GenInput{Aspect: "3:2"}))
	if r.URL != "https://api.example.com/v1/images/generations" || !reflect.DeepEqual(r.Body, map[string]any{"model": "m", "prompt": "a red fox", "n": 1, "size": "1536x1024"}) {
		t.Fatalf("%+v", r)
	}
	if _, ok := OpenAIImages.Build(in(GenInput{Aspect: "auto"})).Body["size"]; ok {
		t.Fatal("auto size")
	}
	p := OpenAIImages.Parse(map[string]any{"data": []any{map[string]any{"b64_json": "AAA", "revised_prompt": "r"}}}, in(GenInput{}))
	if p.Kind != "images" || p.Images[0].B64 != "AAA" || p.RevisedPrompt != "r" {
		t.Fatalf("%+v", p)
	}
	if b := ArkImage.Build(in(GenInput{})).Body; b["size"] != "2048x2048" || b["response_format"] != "b64_json" || b["watermark"] != false {
		t.Fatalf("%v", b)
	}
	g := Gemini.Build(in(GenInput{Model: "models/gemini-2.5-flash-image", Aspect: "16:9"}))
	if g.URL != "https://api.example.com/v1/models/gemini-2.5-flash-image:generateContent" {
		t.Fatal(g.URL)
	}
	gp := Gemini.Parse(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{
		map[string]any{"text": "hi"}, map[string]any{"inlineData": map[string]any{"mimeType": "image/png", "data": "BBB"}}}}}}}, in(GenInput{}))
	if len(gp.Images) != 1 || gp.Images[0].B64 != "BBB" || gp.Images[0].Mime != "image/png" {
		t.Fatalf("%+v", gp)
	}
	if Imagen.Build(in(GenInput{Model: "imagen-4.0"})).URL != "https://api.example.com/v1/models/imagen-4.0:predict" {
		t.Fatal("imagen url")
	}
	op := OpenRouterChatImage.Parse(map[string]any{"choices": []any{map[string]any{"message": map[string]any{
		"images": []any{map[string]any{"image_url": map[string]any{"url": "data:image/png;base64,DDD"}}}}}}}, in(GenInput{}))
	if op.Images[0].B64 != "DDD" || op.Images[0].Mime != "image/png" {
		t.Fatalf("%+v", op)
	}
	if f := Fal.Build(in(GenInput{BaseURL: "https://fal.run", Model: "fal-ai/flux-pro/v1.1"})); f.URL != "https://fal.run/fal-ai/flux-pro/v1.1" || f.Body["image_size"] != "square_hd" {
		t.Fatalf("%+v", f)
	}
	di := in(GenInput{BaseURL: "https://dashscope.aliyuncs.com"})
	if d := DashScope.Build(di); d.URL != "https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis" || d.Headers["X-DashScope-Async"] != "enable" {
		t.Fatalf("%+v", d)
	}
	poll := DashScope.Parse(map[string]any{"output": map[string]any{"task_id": "t1", "task_status": "PENDING"}}, di)
	if poll.Kind != "poll" || poll.AfterMs != 2000 || poll.Next.URL != "https://dashscope.aliyuncs.com/api/v1/tasks/t1" {
		t.Fatalf("%+v", poll)
	}
	if ok := DashScope.Parse(map[string]any{"output": map[string]any{"task_status": "SUCCEEDED", "results": []any{map[string]any{"url": "https://x/y.png"}}}}, di); ok.Images[0].URL != "https://x/y.png" {
		t.Fatalf("%+v", ok)
	}
	if f := DashScope.Parse(map[string]any{"output": map[string]any{"task_status": "FAILED", "message": "bad prompt"}}, di); f.Kind != "failed" || f.Message != "bad prompt" {
		t.Fatalf("%+v", f)
	}
}

func TestAuthHeaders(t *testing.T) {
	if !reflect.DeepEqual(AuthHeaders(AuthBearer, "k"), map[string]string{"Authorization": "Bearer k"}) ||
		!reflect.DeepEqual(AuthHeaders(AuthKey, "k"), map[string]string{"Authorization": "Key k"}) ||
		!reflect.DeepEqual(AuthHeaders(AuthGoog, "k"), map[string]string{"x-goog-api-key": "k"}) ||
		len(AuthHeaders(AuthBearer, "")) != 0 {
		t.Fatal("auth headers")
	}
}

func TestAdaptersEdit(t *testing.T) {
	refs := []Ref{{Mime: "image/png", B64: "PNG"}}
	o := OpenAIImages.Build(in(GenInput{Refs: refs, Aspect: "1:1"}))
	if o.URL != "https://api.example.com/v1/images/edits" || o.Body != nil || o.Multipart == nil {
		t.Fatalf("%+v", o)
	}
	if !reflect.DeepEqual(o.Multipart.Fields, map[string]string{"model": "m", "prompt": "a red fox", "n": "1", "size": "1024x1024"}) ||
		!reflect.DeepEqual(o.Multipart.Files, []MultipartFile{{Field: "image[]", Name: "image-0.png", Mime: "image/png", B64: "PNG"}}) {
		t.Fatalf("%+v", o.Multipart)
	}
	g := Gemini.Build(in(GenInput{Refs: refs}))
	parts := g.Body["contents"].([]any)[0].(map[string]any)["parts"].([]any)
	if !reflect.DeepEqual(parts, []any{map[string]any{"inline_data": map[string]any{"mime_type": "image/png", "data": "PNG"}}, map[string]any{"text": "a red fox"}}) {
		t.Fatalf("%v", parts)
	}
	if a := ArkImage.Build(in(GenInput{Refs: refs})).Body["image"]; !reflect.DeepEqual(a, []any{"data:image/png;base64,PNG"}) {
		t.Fatalf("%v", a)
	}
	or := OpenRouterChatImage.Build(in(GenInput{Refs: refs})).Body["messages"].([]any)[0].(map[string]any)["content"]
	if !reflect.DeepEqual(or, []any{map[string]any{"type": "text", "text": "a red fox"},
		map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,PNG"}}}) {
		t.Fatalf("%v", or)
	}
	for _, a := range []*Adapter{OpenAIImages, Gemini, ArkImage, OpenRouterChatImage} {
		if !a.Edit {
			t.Fatal(a.ID)
		}
	}
	for _, a := range []*Adapter{Imagen, Fal, DashScope} {
		if a.Edit {
			t.Fatal(a.ID)
		}
	}
}
