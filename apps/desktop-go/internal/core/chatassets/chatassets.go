// Package chatassets：素材库（全部生成的图片）。
// 图片在 userData/chat/images，来源写在文件名前缀里（nomi- / 早期 gen- 算 Nomi、grok- / codex- …、
// user- = 用户在对话里发送的原图，经 chatAssets.import 存进来）；
// 对话背景（<stem>.<uuid>.ext、panel-bg.jpg）不列。模型 / 提示词 / 会话另存 userData/chat/assets.json。
// 删除移到系统废纸篓；「在文件夹中显示」经宿主。
package chatassets

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/rand/v2"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

var assetFile = regexp.MustCompile(`(?i)^([a-z][a-z0-9]*)-[A-Za-z0-9._-]+\.(png|jpe?g|webp|gif)$`)

var legacySource = map[string]string{"gen": "nomi"}

// Sources = ASSET_SOURCES
var Sources = []string{"nomi", "grok", "codex", "claude", "gemini", "dsh", "qwen", "kimi", "opencode", "copilot", "user"}

type Meta struct {
	Model          string   `json:"model,omitempty"`
	Prompt         string   `json:"prompt,omitempty"`
	Aspect         string   `json:"aspect,omitempty"`
	EditedFrom     string   `json:"editedFrom,omitempty"`
	References     []string `json:"references,omitempty"`
	ConversationID string   `json:"conversationId,omitempty"`
}

type Item struct {
	File           string   `json:"file"`
	URL            string   `json:"url"`
	Source         string   `json:"source"`
	CreatedAt      int64    `json:"createdAt"`
	Bytes          int64    `json:"bytes"`
	Model          string   `json:"model,omitempty"`
	Prompt         string   `json:"prompt,omitempty"`
	Aspect         string   `json:"aspect,omitempty"`
	EditedFrom     string   `json:"editedFrom,omitempty"`
	References     []string `json:"references,omitempty"`
	ConversationID string   `json:"conversationId,omitempty"`
}

// GenerateReq：重新生成要的参数（沿用原图的提示词 / 模型 / 画幅 / 改图来源 / 参考图）
type GenerateReq struct {
	Prompt, Aspect, ModelRef, EditFrom string
	References                         []string
}

type Deps struct {
	ChatRoot         string
	ShowItemInFolder func(p string)
	TrashItem        func(p string) error
	OnChanged        func()
	// SaveFile：另存为的系统保存框；取消返回 ""
	SaveFile func(defaultName string) string
	// Generate：重新生成（主程序注入 igtools.ImageDeps.GenerateAsset），返回新图的文件名
	Generate func(req GenerateReq) (string, error)
}

type Library struct {
	d  Deps
	mu sync.Mutex
}

func New(d Deps) *Library { return &Library{d: d} }

// SourceOf = assetSourceOf：不是生成的图片返回 ""
func SourceOf(file string) string {
	m := assetFile.FindStringSubmatch(file)
	if m == nil {
		return ""
	}
	p := strings.ToLower(m[1])
	if s, ok := legacySource[p]; ok {
		p = s
	}
	if slices.Contains(Sources, p) {
		return p
	}
	return ""
}

func (l *Library) imagesDir() string { return filepath.Join(l.d.ChatRoot, "images") }
func (l *Library) metaFile() string  { return filepath.Join(l.d.ChatRoot, "assets.json") }

func (l *Library) readMeta() map[string]Meta {
	m := map[string]Meta{}
	if b, err := os.ReadFile(l.metaFile()); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	return m
}

func (l *Library) writeMeta(m map[string]Meta) {
	_ = os.MkdirAll(l.d.ChatRoot, 0o700)
	b, _ := json.Marshal(m)
	tmp := l.metaFile() + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, l.metaFile())
	}
}

// AssetPromptMax = ASSET_PROMPT_MAX：与 image_generate 的 prompt 上限（4000）一致，合法提示词原样保存，
// 重新生成发的就是首次生成时的全文（#225）
const AssetPromptMax = 4000

// Record：生成了一张图（Nomi 的 image_generate）
func (l *Library) Record(file string, meta Meta) {
	if SourceOf(file) == "" {
		return
	}
	if r := []rune(meta.Prompt); len(r) > AssetPromptMax {
		meta.Prompt = string(r[:AssetPromptMax])
	}
	if len(meta.References) > 8 {
		meta.References = meta.References[:8]
	}
	l.mu.Lock()
	m := l.readMeta()
	m[file] = meta
	l.writeMeta(m)
	l.mu.Unlock()
	if l.d.OnChanged != nil {
		l.d.OnChanged()
	}
}

// List：全部生成的图片，新的在前
func (l *Library) List() []Item {
	ents, err := os.ReadDir(l.imagesDir())
	if err != nil {
		return []Item{}
	}
	l.mu.Lock()
	meta := l.readMeta()
	l.mu.Unlock()
	out := []Item{}
	for _, e := range ents {
		src := SourceOf(e.Name())
		if src == "" || e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		mt := meta[e.Name()]
		out = append(out, Item{File: e.Name(), URL: "chat-asset://images/" + e.Name(), Source: src,
			CreatedAt: createdAt(info), Bytes: info.Size(), Model: mt.Model, Prompt: mt.Prompt, Aspect: mt.Aspect,
			EditedFrom: mt.EditedFrom, References: mt.References, ConversationID: mt.ConversationID})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].CreatedAt != out[j].CreatedAt {
			return out[i].CreatedAt > out[j].CreatedAt
		}
		return out[i].File < out[j].File
	})
	return out
}

func (l *Library) pathOf(file string) string {
	if SourceOf(file) == "" || file != filepath.Base(file) {
		return ""
	}
	return filepath.Join(l.imagesDir(), file)
}

// Remove：移到系统废纸篓（没有废纸篓能力时直接删）；返回实际删掉的文件名
func (l *Library) Remove(files []string) []string {
	done := []string{}
	for _, f := range files {
		p := l.pathOf(f)
		if p == "" {
			continue
		}
		if _, err := os.Stat(p); err != nil {
			continue
		}
		var err error
		if l.d.TrashItem != nil {
			err = l.d.TrashItem(p)
		} else {
			err = os.Remove(p)
		}
		if err == nil {
			done = append(done, f)
		}
	}
	if len(done) > 0 {
		l.mu.Lock()
		m := l.readMeta()
		for _, f := range done {
			delete(m, f)
		}
		l.writeMeta(m)
		l.mu.Unlock()
		if l.d.OnChanged != nil {
			l.d.OnChanged()
		}
	}
	return done
}

// SetGenerate：主程序在生图依赖就绪后注入「重新生成」（素材库先于工具注册创建）
func (l *Library) SetGenerate(f func(req GenerateReq) (string, error)) { l.d.Generate = f }

// Regenerate：沿用原图记下的提示词 / 模型 / 画幅 / 改图来源 / 参考图再生成一张；返回新图
func (l *Library) Regenerate(file string) (Item, error) {
	noPrompt := errors.New(i18n.T("electron.image.no-prompt-to-regenerate"))
	if l.pathOf(file) == "" || l.d.Generate == nil {
		return Item{}, noPrompt
	}
	l.mu.Lock()
	m := l.readMeta()[file]
	l.mu.Unlock()
	if m.Prompt == "" {
		return Item{}, noPrompt
	}
	next, err := l.d.Generate(GenerateReq{Prompt: m.Prompt, Aspect: m.Aspect, ModelRef: m.Model, EditFrom: m.EditedFrom, References: m.References})
	if err != nil {
		return Item{}, err
	}
	for _, it := range l.List() {
		if it.File == next {
			return it, nil
		}
	}
	return Item{}, errors.New(i18n.T("electron.image.no-image-in-response", ""))
}

// ImportMaxBytes = ASSET_IMPORT_MAX_BYTES：用户发送的原图上限（解码后）
const ImportMaxBytes = 20 * 1024 * 1024

var importExt = map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}

// ImageMagicMatches = imageMagicMatches：文件头与声明的类型一致（不信视图给的 mime）
func ImageMagicMatches(mime string, b []byte) bool {
	at := func(i int, v ...byte) bool { return len(b) >= i+len(v) && bytes.Equal(b[i:i+len(v)], v) }
	switch mime {
	case "image/png":
		return at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
	case "image/jpeg":
		return at(0, 0xff, 0xd8, 0xff)
	case "image/webp":
		return at(0, 'R', 'I', 'F', 'F') && at(8, 'W', 'E', 'B', 'P')
	case "image/gif":
		return at(0, 'G', 'I', 'F', '8') && (at(4, '7', 'a') || at(4, '9', 'a'))
	}
	return false
}

// ImportReq = chatAssets.import 的入参
type ImportReq struct {
	Mime           string `json:"mime"`
	Data           string `json:"data"`
	ConversationID string `json:"conversationId,omitempty"`
}

// ImportImage = importImage：用户在对话里发送的图片，原图存进素材库（来源 user），返回素材项。
// 解码后超过 20 MB、或文件头与 mime 不符的拒绝；对话 id 记进说明。
func (l *Library) ImportImage(req ImportReq) (Item, error) {
	maxMb := ImportMaxBytes / 1024 / 1024
	tooLarge := errors.New(i18n.T("electron.image.import-too-large", maxMb))
	badFormat := errors.New(i18n.T("electron.image.import-bad-format"))
	ext := importExt[req.Mime]
	// base64 解码前先按长度估一下，避免超大字符串整块解码
	if len(req.Data) > (ImportMaxBytes+2)/3*4+4 {
		return Item{}, tooLarge
	}
	b, err := decodeBase64Loose(req.Data)
	if err != nil {
		return Item{}, badFormat
	}
	if len(b) > ImportMaxBytes {
		return Item{}, tooLarge
	}
	if ext == "" || !ImageMagicMatches(req.Mime, b) {
		return Item{}, badFormat
	}
	if err := os.MkdirAll(l.imagesDir(), 0o700); err != nil {
		return Item{}, err
	}
	_ = os.Chmod(l.imagesDir(), 0o700)
	file := "user-" + strconv.FormatInt(time.Now().UnixMilli(), 36) + "-" +
		strconv.FormatUint(rand.Uint64(), 36)[:6] + "." + ext
	f, err := os.OpenFile(filepath.Join(l.imagesDir(), file), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return Item{}, err
	}
	if _, err := f.Write(b); err != nil {
		_ = f.Close()
		_ = os.Remove(f.Name())
		return Item{}, err
	}
	if err := f.Close(); err != nil {
		return Item{}, err
	}
	// Record 会通知视图（chatAssets.changed）
	l.Record(file, Meta{ConversationID: req.ConversationID})
	for _, it := range l.List() {
		if it.File == file {
			return it, nil
		}
	}
	return Item{}, badFormat
}

// decodeBase64Loose = Buffer.from(s, 'base64')：标准 / URL 字母表，补齐与否都认
func decodeBase64Loose(s string) ([]byte, error) {
	s = strings.TrimRight(strings.TrimSpace(s), "=")
	if strings.ContainsAny(s, "-_") {
		return base64.RawURLEncoding.DecodeString(s)
	}
	return base64.RawStdEncoding.DecodeString(s)
}

// SaveAs：另存为（用户选位置后复制一份）；取消返回 false
func (l *Library) SaveAs(file string) (bool, error) {
	p := l.pathOf(file)
	if p == "" || l.d.SaveFile == nil {
		return false, nil
	}
	if _, err := os.Stat(p); err != nil {
		return false, nil
	}
	dest := l.d.SaveFile(file)
	if dest == "" {
		return false, nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return false, err
	}
	return true, os.WriteFile(dest, b, 0o644)
}

// Reveal：在文件管理器中定位
func (l *Library) Reveal(file string) bool {
	p := l.pathOf(file)
	if p == "" || l.d.ShowItemInFolder == nil {
		return false
	}
	if _, err := os.Stat(p); err != nil {
		return false
	}
	l.d.ShowItemInFolder(p)
	return true
}
