package igtools

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/media"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var png = []byte{0x89, 0x50, 0x4e, 0x47, 1, 2, 3}

type imgCall struct {
	path    string
	headers http.Header
	body    map[string]any
}

// imageSetup：假供应商（httptest），urls 里的 {srv} 换成服务器地址
func imageSetup(t *testing.T, ref string, urls map[string]string, respond func(w http.ResponseWriter, r *http.Request, n int)) (tools.Definition, *[]imgCall, string) {
	t.Helper()
	calls := &[]imgCall{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var b map[string]any
		_ = json.Unmarshal(raw, &b)
		*calls = append(*calls, imgCall{r.URL.Path, r.Header.Clone(), b})
		if respond != nil {
			respond(w, r, len(*calls))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"b64_json": base64.StdEncoding.EncodeToString(png)}}})
	}))
	t.Cleanup(srv.Close)
	if urls == nil {
		urls = map[string]string{"chat": "{srv}/v1/"}
	}
	resolved := map[string]string{}
	for k, v := range urls {
		resolved[k] = strings.ReplaceAll(v, "{srv}", srv.URL)
	}
	dir := filepath.Join(t.TempDir(), "images")
	defs := ImageTools(ImageDeps{
		ImageRef: func() string { return ref },
		ImageProvider: func(id string) *ImageAccess {
			if id != "amux" {
				return nil
			}
			return &ImageAccess{
				Info: media.ProviderInfo{ID: "amux", URLs: resolved},
				KeyFor: func(w string) string {
					return map[string]string{"chat": "sk-chat", "gemini": "sk-gem"}[w]
				},
				Headers: map[string]string{"X-Extra": "1"},
			}
		},
		ImagesDir: dir,
		Sleep:     func(time.Duration) {},
		Now:       func() time.Time { return time.UnixMilli(1_700_000_000_000) },
	})
	return defs[0], calls, dir
}

func TestImageToolAvailable(t *testing.T) {
	if d, _, _ := imageSetup(t, "", nil, nil); tools.IsAvailable(d) {
		t.Fatal("没分配图片模型时不应提供")
	}
	if d, _, _ := imageSetup(t, "gone/gpt-image-2", nil, nil); tools.IsAvailable(d) {
		t.Fatal("供应商不可用时不应提供")
	}
	if d, _, _ := imageSetup(t, "amux/gpt-image-2", map[string]string{}, nil); tools.IsAvailable(d) {
		t.Fatal("没有端点时不应提供")
	}
	if d, _, _ := imageSetup(t, "amux/openai/gpt-image-2", nil, nil); !tools.IsAvailable(d) || d.Name != ImageTool {
		t.Fatal("分配了图片模型应可用")
	}
}

func TestImageToolRelayOpenAIImages(t *testing.T) {
	d, calls, dir := imageSetup(t, "amux/openai/gpt-image-2", nil, nil)
	out, err := d.Execute(context.Background(), u.NewObj("prompt", "a red fox", "aspect_ratio", "1:1"), tools.ExecContext{})
	if err != nil {
		t.Fatal(err)
	}
	c := (*calls)[0]
	if c.path != "/v1/images/generations" || c.headers.Get("Authorization") != "Bearer sk-chat" || c.headers.Get("X-Extra") != "1" {
		t.Fatalf("call = %+v", c)
	}
	if c.body["model"] != "openai/gpt-image-2" || c.body["prompt"] != "a red fox" || c.body["size"] != "1024x1024" || c.body["n"] != float64(1) {
		t.Fatalf("body = %v", c.body)
	}
	o := out.(*u.Obj)
	img, _ := o.Get("image").(string)
	if !regexp.MustCompile(`^chat-asset://images/nomi-[a-z0-9]+-[a-z0-9]+\.png$`).MatchString(img) || o.Get("adapter") != "openai-images" {
		t.Fatalf("out = %s", u.Stringify(o))
	}
	if strings.Contains(u.Stringify(o), base64.StdEncoding.EncodeToString(png)) {
		t.Fatal("结果不应带 base64")
	}
	b, err := os.ReadFile(filepath.Join(dir, strings.TrimPrefix(img, "chat-asset://images/")))
	if err != nil || string(b) != string(png) {
		t.Fatalf("saved = %v %v", b, err)
	}
}

func TestImageToolGeminiWire(t *testing.T) {
	d, calls, _ := imageSetup(t, "amux/gemini-2.5-flash-image",
		map[string]string{"chat": "{srv}/v1", "gemini": "{srv}/v1beta"},
		func(w http.ResponseWriter, _ *http.Request, _ int) {
			_ = json.NewEncoder(w).Encode(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{
				"parts": []any{map[string]any{"inlineData": map[string]any{"data": base64.StdEncoding.EncodeToString(png)}}}}}}})
		})
	if _, err := d.Execute(context.Background(), u.NewObj("prompt", "x"), tools.ExecContext{}); err != nil {
		t.Fatal(err)
	}
	c := (*calls)[0]
	if c.path != "/v1beta/models/gemini-2.5-flash-image:generateContent" || c.headers.Get("x-goog-api-key") != "sk-gem" {
		t.Fatalf("call = %+v", c)
	}
}

func TestImageToolAsyncPollThenRejectsPrivateURL(t *testing.T) {
	// DashScope 规则看主机名：用规则表外的自定义端点不便注入，这里直接驱动 run（适配器 + 轮询循环）
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/image-synthesis"):
			_ = json.NewEncoder(w).Encode(map[string]any{"output": map[string]any{"task_id": "t1", "task_status": "PENDING"}})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"output": map[string]any{"task_status": "SUCCEEDED",
				"results": []any{map[string]any{"url": "http://127.0.0.1/a.png"}}}})
		}
	}))
	defer srv.Close()
	d := ImageDeps{Sleep: func(time.Duration) {}}
	tgt := &imageTarget{model: "wan2.2-t2i-flash", access: &ImageAccess{KeyFor: func(string) string { return "k" }},
		endpoint: &media.Endpoint{Adapter: media.DashScope, BaseURL: srv.URL, Wire: "chat", Auth: media.AuthBearer}}
	img, _, err := d.run(context.Background(), tgt, "x", "1:1", nil, "")
	if err != nil || img.URL != "http://127.0.0.1/a.png" {
		t.Fatalf("img=%+v err=%v", img, err)
	}
	if _, err := d.bytesOf(context.Background(), img); err == nil {
		t.Fatal("内网图片地址应被拒绝")
	}
}

func TestImageToolUpstreamError(t *testing.T) {
	d, _, _ := imageSetup(t, "amux/m", nil, func(w http.ResponseWriter, _ *http.Request, _ int) {
		w.WriteHeader(429)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": "quota exceeded"}})
	})
	_, err := d.Execute(context.Background(), u.NewObj("prompt", "x"), tools.ExecContext{})
	if err == nil || !strings.Contains(err.Error(), "429") || !strings.Contains(err.Error(), "quota exceeded") {
		t.Fatalf("err = %v", err)
	}
}

func TestImageHelpers(t *testing.T) {
	if p, m, ok := SplitImageRef("amux/openai/gpt-image-2"); !ok || p != "amux" || m != "openai/gpt-image-2" {
		t.Fatal(p, m, ok)
	}
	if _, _, ok := SplitImageRef("noslash"); ok {
		t.Fatal("noslash")
	}
	if ImageExt([]byte{0xff, 0xd8, 0}) != "jpg" || ImageExt([]byte("RIFF")) != "webp" || ImageExt(png) != "png" {
		t.Fatal("ext")
	}
}

func TestForLoopSkipsUnavailable(t *testing.T) {
	r := tools.NewInMemory()
	r.Register(tools.Definition{Name: "on"})
	r.Register(tools.Definition{Name: "off", Available: func() bool { return false }})
	r.Register(tools.Definition{Name: "boom", Available: func() bool { panic("x") }})
	got := []string{}
	for _, d := range tools.ForLoop(r, "") {
		got = append(got, d.Name)
	}
	if strings.Join(got, ",") != "on" {
		t.Fatalf("got %v", got)
	}
}

func TestImageToolEditAndReference(t *testing.T) {
	var gotForm []string
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = r.ParseMultipartForm(1 << 20)
		gotForm = append([]string{r.FormValue("prompt")}, func() []string {
			out := []string{}
			for _, fh := range r.MultipartForm.File["image[]"] {
				out = append(out, fh.Filename)
			}
			return out
		}()...)
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"b64_json": base64.StdEncoding.EncodeToString(png)}}})
	}))
	defer srv.Close()
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "nomi-src.png"), png, 0o600)
	_ = os.WriteFile(filepath.Join(dir, "grok-b.jpg"), png, 0o600)
	var metas []GeneratedMeta
	d := ImageDeps{
		ImageRef: func() string { return "amux/gpt-image-2" },
		ImageProvider: func(string) *ImageAccess {
			return &ImageAccess{Info: media.ProviderInfo{ID: "amux", URLs: map[string]string{"chat": srv.URL + "/v1"}}, KeyFor: func(string) string { return "k" }}
		},
		ImagesDir:   dir,
		OnGenerated: func(_ string, m GeneratedMeta) { metas = append(metas, m) },
	}
	tool := ImageTools(d)[0]
	out, err := tool.Execute(context.Background(), u.NewObj("prompt", "make it blue", "edit_image", "chat-asset://images/nomi-src.png"), tools.ExecContext{ConversationID: "c1"})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/images/edits" || strings.Join(gotForm, ",") != "make it blue,image-0.png" || out.(*u.Obj).Get("mode") != "edit" {
		t.Fatalf("path=%s form=%v out=%s", gotPath, gotForm, u.Stringify(out))
	}
	if metas[0].EditedFrom != "nomi-src.png" || metas[0].ConversationID != "c1" {
		t.Fatalf("%+v", metas[0])
	}
	out, err = tool.Execute(context.Background(), u.NewObj("prompt", "same style", "reference_images", []any{"nomi-src.png", "chat-asset://images/grok-b.jpg"}), tools.ExecContext{})
	if err != nil {
		t.Fatal(err)
	}
	if len(gotForm) != 3 || out.(*u.Obj).Get("mode") != "reference" || strings.Join(metas[1].References, ",") != "nomi-src.png,grok-b.jpg" {
		t.Fatalf("form=%v metas=%+v", gotForm, metas[1])
	}
	if _, err := tool.Execute(context.Background(), u.NewObj("prompt", "x", "edit_image", "../../etc/passwd"), tools.ExecContext{}); err == nil {
		t.Fatal("路径穿越应拒绝")
	}
}

// 指定了模型（重新生成）：原模型不可用就报错，不改用当前图片模型（#224）
func TestGenerateAssetPinnedModelNoFallback(t *testing.T) {
	var hits []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.Host)
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"b64_json": base64.StdEncoding.EncodeToString(png)}}})
	}))
	t.Cleanup(srv.Close)
	var generated []GeneratedMeta
	d := ImageDeps{
		ImageRef: func() string { return "other/openai/gpt-image-2" },
		ImageProvider: func(id string) *ImageAccess {
			if id != "amux" && id != "other" {
				return nil
			}
			return &ImageAccess{Info: media.ProviderInfo{ID: id, URLs: map[string]string{"chat": srv.URL + "/" + id + "/v1/"}},
				KeyFor: func(string) string { return "k" }}
		},
		ImagesDir:   filepath.Join(t.TempDir(), "images"),
		OnGenerated: func(_ string, m GeneratedMeta) { generated = append(generated, m) },
		Sleep:       func(time.Duration) {},
	}
	_, err := d.GenerateAsset(context.Background(), GenerateReq{Prompt: "a fox", ModelRef: "gone/gpt-image-2"})
	if err == nil || len(hits) != 0 || len(generated) != 0 {
		t.Fatalf("err=%v hits=%v generated=%v", err, hits, generated)
	}
	r, err := d.GenerateAsset(context.Background(), GenerateReq{Prompt: "a fox", ModelRef: "amux/openai/gpt-image-2"})
	if err != nil || r.Provider != "amux" {
		t.Fatalf("%+v %v", r, err)
	}
	r, err = d.GenerateAsset(context.Background(), GenerateReq{Prompt: "a fox"})
	if err != nil || r.Provider != "other" {
		t.Fatalf("%+v %v", r, err)
	}
}
