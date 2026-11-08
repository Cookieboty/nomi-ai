package igtools

// image_generate：用「模型」页给 Nomi 分配的图片模型
// （clients.nomi.models.image，`供应商/模型`）生图。各家接口差异在 gateway/media：
// 端点规则选适配器与地址，适配器拼请求 / 解析响应；这里只发请求、放 Key、轮询、下载与保存。
// 没分配 / 供应商不可用 / 没有端点时不提供（Definition.Available）；结果只回 chat-asset 地址；
// 返回图片 URL 时只下载公网地址、不跟随跳转（防 SSRF）。

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aifacade"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/media"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	ImageTool            = "image_generate"
	maxImageBytes        = 25 * 1024 * 1024
	defaultTaskTimeoutMs = 180_000
	imageToolDesc        = "Generate an image from a text prompt with the image model the user configured for Nomi. Write the prompt in English when possible and be specific (subject, style, composition). Images are only sent to the image model when the user explicitly asks for it: to change an existing generated image pass its chat-asset://images/... link as edit_image and describe the change; to make a new image based on existing ones (style, subject, composition) pass up to 4 links as reference_images. Otherwise leave both out. The generated image is shown to the user automatically under this step; reply briefly about what you drew and do not paste the image link."
	imageSchemaJSON      = `{` + draft + `"type":"object","properties":{"prompt":{"type":"string","minLength":1,"maxLength":4000,"description":"What to draw, or how to change the image"},"aspect_ratio":{"description":"Aspect ratio; omit for the model default","type":"string","enum":["auto","1:1","3:2","2:3","16:9","9:16"]},"edit_image":{"description":"Only to edit an existing generated image: its chat-asset://images/... link","type":"string","maxLength":300},"reference_images":{"description":"Only to generate from reference images: chat-asset://images/... links","maxItems":4,"type":"array","items":{"type":"string","maxLength":300}}},"required":["prompt"],"additionalProperties":false}`
	// MaxReferences：最多带几张参考图
	MaxReferences = 4
)

var imageIn = aifacade.ObjOf('S', "prompt", str(1, 4000),
	"edit_image", aifacade.Opt(str(0, 300)),
	"reference_images", aifacade.Opt(aifacade.Unknown),
	"aspect_ratio", aifacade.Opt(aifacade.Enum(media.Aspects...)))

// ImageAccess = ImageProviderAccess（gwstore.Service.ImageProvider 的形状）
type ImageAccess struct {
	Info    media.ProviderInfo
	KeyFor  func(wire string) string
	Headers map[string]string
}

// ImageDeps = ImageToolDeps
type ImageDeps struct {
	ImageRef      func() string
	ImageProvider func(providerID string) *ImageAccess
	ImagesDir     string
	// ImageAuto：当前的图片模型是不是自动匹配来的（结果里标出来）
	ImageAuto func() bool
	// OnGenerated：生成了一张图（素材库记下模型 / 提示词 / 画幅 / 改图来源 / 参考图 / 会话）
	OnGenerated func(file string, meta GeneratedMeta)
	Client      *http.Client
	Sleep       func(time.Duration)
	Now         func() time.Time
	// LookupAll：下载图片 URL 前的解析（测试注入）；nil = 系统解析
	LookupAll security.LookupAll
}

// GeneratedMeta：生成图片的元数据
type GeneratedMeta struct {
	// Model：`供应商/模型`
	Model, Prompt, Aspect, EditedFrom, ConversationID string
	References                                        []string
}

// GenerateReq = generateImageAsset 的 req
type GenerateReq struct {
	Prompt, Aspect, EditFrom, ModelRef, ConversationID string
	References                                         []string
}

// GenerateResult = generateImageAsset 的返回
type GenerateResult struct {
	File, URL, Model, Provider, Adapter, RevisedPrompt string
	// Retries：失败后自动重试了几次才成功（image_retry.go）
	Retries int
}

// SplitImageRef：`供应商/模型` → 供应商 id 与模型 id（模型 id 自己可以含 `/`）
func SplitImageRef(ref string) (provider, model string, ok bool) {
	i := strings.Index(ref, "/")
	if i <= 0 || i >= len(ref)-1 {
		return "", "", false
	}
	return ref[:i], ref[i+1:], true
}

type imageTarget struct {
	model    string
	endpoint *media.Endpoint
	access   *ImageAccess
}

func (d ImageDeps) target() *imageTarget { return d.targetFor("") }

// targetFor：ref 指定时用它（重新生成沿用原图的模型），否则用当前的图片模型
func (d ImageDeps) targetFor(ref string) *imageTarget {
	if d.ImageProvider == nil || (ref == "" && d.ImageRef == nil) {
		return nil
	}
	if ref == "" {
		ref = d.ImageRef()
	}
	p, m, ok := SplitImageRef(ref)
	if !ok {
		return nil
	}
	a := d.ImageProvider(p)
	if a == nil {
		return nil
	}
	e := media.Resolve(a.Info, m, nil)
	if e == nil {
		return nil
	}
	return &imageTarget{model: m, endpoint: e, access: a}
}

// ImageExt：按文件头猜扩展名
func ImageExt(b []byte) string {
	if len(b) >= 2 && b[0] == 0xff && b[1] == 0xd8 {
		return "jpg"
	}
	if len(b) >= 4 && string(b[:4]) == "RIFF" {
		return "webp"
	}
	return "png"
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func (d ImageDeps) client() *http.Client {
	if d.Client != nil {
		return d.Client
	}
	return &http.Client{Timeout: 3 * time.Minute}
}

func (d ImageDeps) send(ctx context.Context, r media.HTTPRequest, headers map[string]string) (any, error) {
	var body io.Reader
	contentType := ""
	if r.Multipart != nil {
		buf := &bytes.Buffer{}
		w := multipart.NewWriter(buf)
		for _, k := range sortedKeys(r.Multipart.Fields) {
			_ = w.WriteField(k, r.Multipart.Fields[k])
		}
		for _, f := range r.Multipart.Files {
			raw, err := base64.StdEncoding.DecodeString(f.B64)
			if err != nil {
				return nil, err
			}
			h := make(textproto.MIMEHeader)
			h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`, f.Field, f.Name))
			h.Set("Content-Type", f.Mime)
			part, err := w.CreatePart(h)
			if err != nil {
				return nil, err
			}
			_, _ = part.Write(raw)
		}
		_ = w.Close()
		body, contentType = buf, w.FormDataContentType()
	} else if r.Body != nil {
		raw, _ := json.Marshal(r.Body)
		body, contentType = bytes.NewReader(raw), "application/json"
	}
	req, err := http.NewRequestWithContext(ctx, r.Method, r.URL, body)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	for k, v := range r.Headers {
		req.Header.Set(k, v)
	}
	res, err := d.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	text, _ := io.ReadAll(io.LimitReader(res.Body, maxImageBytes*2))
	var parsed any
	jsonErr := json.Unmarshal(text, &parsed)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		msg := media.UpstreamErrorMessage(parsed)
		if msg == "" {
			msg = string(text)
		}
		return nil, &imageHTTPError{Status: res.StatusCode, RetryAfter: retryAfterOf(res.Header),
			msg: i18n.T("electron.image.service-returned", res.StatusCode, clip(msg, 300))}
	}
	if jsonErr != nil {
		return nil, &imageTransient{i18n.T("electron.image.no-image-in-response", clip(string(text), 200))}
	}
	return parsed, nil
}

// run = runImageEndpoint：首次请求 →（异步任务则轮询）→ 第一张图
func (d ImageDeps) run(ctx context.Context, t *imageTarget, prompt, aspect string, refs []media.Ref, refMode string) (media.Image, string, error) {
	now, sleep := d.Now, d.Sleep
	if now == nil {
		now = time.Now
	}
	if sleep == nil {
		sleep = time.Sleep
	}
	a := t.endpoint.Adapter
	if len(refs) > 0 && !a.Edit {
		return media.Image{}, "", errors.New(i18n.T("electron.image.edit-not-supported", t.model))
	}
	in := media.GenInput{BaseURL: t.endpoint.BaseURL, Model: t.model, Prompt: prompt, Aspect: aspect}
	if len(refs) > 0 {
		in.Refs, in.RefMode = refs, refMode
	}
	headers := map[string]string{}
	for k, v := range t.access.Headers {
		headers[k] = v
	}
	key := ""
	if t.access.KeyFor != nil {
		key = t.access.KeyFor(t.endpoint.Wire)
	}
	for k, v := range media.AuthHeaders(t.endpoint.Auth, key) {
		headers[k] = v
	}
	timeout := a.TimeoutMs
	if timeout == 0 {
		timeout = defaultTaskTimeoutMs
	}
	deadline := now().Add(time.Duration(timeout) * time.Millisecond)
	body, err := d.send(ctx, a.Build(in), headers)
	for err == nil {
		p := a.Parse(body, in)
		switch p.Kind {
		case "failed":
			return media.Image{}, "", &imageTransient{i18n.T("electron.image.task-failed", p.Message)}
		case "images":
			if len(p.Images) == 0 {
				raw, _ := json.Marshal(body)
				return media.Image{}, "", &imageTransient{i18n.T("electron.image.no-image-in-response", clip(string(raw), 200))}
			}
			return p.Images[0], p.RevisedPrompt, nil
		}
		wait := time.Duration(p.AfterMs) * time.Millisecond
		if now().Add(wait).After(deadline) {
			return media.Image{}, "", &imageTransient{i18n.T("electron.image.task-timeout")}
		}
		sleep(wait)
		body, err = d.send(ctx, *p.Next, headers)
	}
	return media.Image{}, "", err
}

// bytesOf = imageBytes：base64 直接解；URL 只下载公网地址、不跟随跳转
func (d ImageDeps) bytesOf(ctx context.Context, img media.Image) ([]byte, error) {
	if img.B64 != "" {
		return base64.StdEncoding.DecodeString(img.B64)
	}
	if img.URL == "" {
		return nil, errors.New(i18n.T("electron.image.no-image-in-response", ""))
	}
	pu, err := security.AssertPublicHttpUrlResolved(img.URL, d.LookupAll)
	if err != nil {
		return nil, err
	}
	c := *d.client()
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pu.URL.String(), nil)
	if err != nil {
		return nil, err
	}
	res, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, &imageHTTPError{Status: res.StatusCode, RetryAfter: retryAfterOf(res.Header),
			msg: i18n.T("electron.image.download-failed", res.StatusCode)}
	}
	if res.ContentLength > maxImageBytes {
		return nil, errors.New(i18n.T("electron.image.too-large"))
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, maxImageBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxImageBytes {
		return nil, errors.New(i18n.T("electron.image.too-large"))
	}
	return b, nil
}

var assetName = regexp.MustCompile(`(?i)^[a-z][a-z0-9]*-[A-Za-z0-9._-]+\.(png|jpe?g|webp|gif)$`)

// AssetPathOf = assetPathOf：素材库里的图片（chat-asset 链接或文件名）→ 本地路径；不是生成的图片返回 ""
func AssetPathOf(imagesDir, ref string) string {
	name := strings.TrimPrefix(ref, "chat-asset://images/")
	if !assetName.MatchString(name) || name != filepath.Base(name) {
		return ""
	}
	return filepath.Join(imagesDir, name)
}

var mimeByExt = map[string]string{"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif"}

func (d ImageDeps) readAsset(ref string) (string, media.Ref, error) {
	p := AssetPathOf(d.ImagesDir, ref)
	if p == "" {
		return "", media.Ref{}, errors.New(i18n.T("electron.image.edit-source-missing"))
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return "", media.Ref{}, errors.New(i18n.T("electron.image.edit-source-missing"))
	}
	mime := mimeByExt[strings.ToLower(strings.TrimPrefix(filepath.Ext(p), "."))]
	if mime == "" {
		mime = "image/png"
	}
	return filepath.Base(p), media.Ref{Mime: mime, B64: base64.StdEncoding.EncodeToString(b)}, nil
}

// GenerateAsset = generateImageAsset：生成一张图并存进素材库（对话的 image_generate 与「重新生成」共用）。
// EditFrom = 改图；References = 参考图生成（素材库里的图片从本地读出来，只发给图片模型，不进对话上下文）
func (d ImageDeps) GenerateAsset(ctx context.Context, req GenerateReq) (GenerateResult, error) {
	now := d.Now
	if now == nil {
		now = time.Now
	}
	// 指定了模型（重新生成沿用原图的模型）就只用它：不可用时报错，不悄悄换成当前图片模型（#224）
	var t *imageTarget
	if req.ModelRef != "" {
		if t = d.targetFor(req.ModelRef); t == nil {
			return GenerateResult{}, errors.New(i18n.T("electron.image.regenerate-model-unavailable", req.ModelRef))
		}
	} else if t = d.target(); t == nil {
		return GenerateResult{}, errors.New(i18n.T("electron.image.no-image-model"))
	}
	var refs []media.Ref
	refMode, editedFrom := "", ""
	var references []string
	if req.EditFrom != "" {
		f, r, err := d.readAsset(req.EditFrom)
		if err != nil {
			return GenerateResult{}, err
		}
		refs, refMode, editedFrom = []media.Ref{r}, "edit", f
	} else if len(req.References) > 0 {
		list := req.References
		if len(list) > MaxReferences {
			list = list[:MaxReferences]
		}
		for _, x := range list {
			f, r, err := d.readAsset(x)
			if err != nil {
				return GenerateResult{}, err
			}
			refs = append(refs, r)
			references = append(references, f)
		}
		refMode = "reference"
	}
	aspect := req.Aspect
	if aspect == "" {
		aspect = "auto"
	}
	// 失败时自动重试（image_retry.go）：生成失败重新生成；图生成好了只是下载失败就只重试下载
	var img media.Image
	var revised string
	retries, err := d.withImageRetry(ctx, func() (e error) {
		img, revised, e = d.run(ctx, t, req.Prompt, aspect, refs, refMode)
		return e
	})
	if err != nil {
		return GenerateResult{}, err
	}
	var b []byte
	n, err := d.withImageRetry(ctx, func() (e error) {
		b, e = d.bytesOf(ctx, img)
		return e
	})
	retries += n
	if err != nil {
		return GenerateResult{}, err
	}
	if err := os.MkdirAll(d.ImagesDir, 0o700); err != nil {
		return GenerateResult{}, err
	}
	// 前缀 = 来源（素材库按它区分 Nomi / 各编程助手生成的图片）
	file := fmt.Sprintf("nomi-%s-%s.%s", strconv.FormatInt(now().UnixMilli(), 36),
		strconv.FormatUint(rand.Uint64(), 36)[:6], ImageExt(b))
	if err := os.WriteFile(filepath.Join(d.ImagesDir, file), b, 0o600); err != nil {
		return GenerateResult{}, err
	}
	if d.OnGenerated != nil {
		meta := GeneratedMeta{Model: t.access.Info.ID + "/" + t.model, Prompt: req.Prompt, EditedFrom: editedFrom,
			References: references, ConversationID: req.ConversationID}
		if aspect != "auto" {
			meta.Aspect = aspect
		}
		d.OnGenerated(file, meta)
	}
	return GenerateResult{File: file, URL: "chat-asset://images/" + file, Model: t.model, Provider: t.access.Info.ID,
		Adapter: t.endpoint.Adapter.ID, RevisedPrompt: revised, Retries: retries}, nil
}

// ImageTools = createImageTools
func ImageTools(d ImageDeps) []tools.Definition {
	return []tools.Definition{{
		Name:           ImageTool,
		Description:    imageToolDesc,
		Input:          schema(imageSchemaJSON),
		DangerousUnset: true,
		Available:      func() bool { return d.target() != nil },
		Execute: func(ctx context.Context, in any, ec tools.ExecContext) (any, error) {
			o, err := parse(imageIn, in)
			if err != nil {
				return nil, err
			}
			req := GenerateReq{ConversationID: ec.ConversationID}
			req.Prompt, _ = o.Get("prompt").(string)
			req.Aspect, _ = o.Get("aspect_ratio").(string)
			req.EditFrom, _ = o.Get("edit_image").(string)
			if arr, ok := o.Get("reference_images").([]any); ok {
				if len(arr) > MaxReferences {
					return nil, errors.New("reference_images: at most 4")
				}
				for _, x := range arr {
					if s, ok := x.(string); ok && s != "" {
						req.References = append(req.References, s)
					}
				}
			}
			r, err := d.GenerateAsset(ctx, req)
			if err != nil {
				return nil, err
			}
			out := u.NewObj("ok", true, "image", r.URL, "model", r.Model, "provider", r.Provider)
			if d.ImageAuto != nil && d.ImageAuto() {
				out.Set("auto", true)
			}
			out.Set("adapter", r.Adapter)
			if req.EditFrom != "" {
				out.Set("mode", "edit")
			} else if len(req.References) > 0 {
				out.Set("mode", "reference")
			}
			if r.RevisedPrompt != "" {
				out.Set("revisedPrompt", r.RevisedPrompt)
			}
			if r.Retries > 0 {
				out.Set("retries", float64(r.Retries))
			}
			return out, nil
		},
	}}
}

func sortedKeys(m map[string]string) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}
