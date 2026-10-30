// Package chatbg = apps/desktop-electron/internal/core/src/chat/ChatBackgroundService.ts + @nomi-ai/types chatBackground：
// 图片主题背景的图片、模糊与透明度（userData/chat-background.json + userData/chat/images）。
package chatbg

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

const (
	PresetURL      = "chat-asset://presets/background.jpg"
	ImageURLPrefix = "chat-asset://images/"
	MaxBytes       = 15 * 1024 * 1024
	MaxEdge        = 2560
	ErrTooLarge    = "CHAT_BG_TOO_LARGE"
	ErrUnsupported = "CHAT_BG_UNSUPPORTED"
	File           = "chat-background.json"
	ImageStem      = "panel-bg"
)

var imgExt = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".gif": true}

// State = ChatBackgroundState（字段顺序同 sanitizeChatBg 的返回）
type State struct {
	ImageURL *string `json:"imageUrl"`
	Blur     float64 `json:"blur"`
	Opacity  float64 `json:"opacity"`
}

var Default = State{ImageURL: nil, Blur: 8, Opacity: 0.4}

func clamp(n, lo, hi float64) float64 { return math.Min(hi, math.Max(lo, n)) }

func finite(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok && !math.IsInf(f, 0) && !math.IsNaN(f)
}

// Sanitize = sanitizeChatBg（raw 为 encoding/json 解出的任意值）
func Sanitize(raw any) State {
	o, _ := raw.(map[string]any)
	s := Default
	if u, ok := o["imageUrl"].(string); ok && (strings.HasPrefix(u, ImageURLPrefix) || u == PresetURL) {
		s.ImageURL = &u
	}
	if f, ok := finite(o["blur"]); ok {
		s.Blur = clamp(f, 0, 40)
	}
	if f, ok := finite(o["opacity"]); ok {
		s.Opacity = clamp(f, 0.05, 1)
	}
	return s
}

func (s State) toMap() map[string]any {
	m := map[string]any{"blur": s.Blur, "opacity": s.Opacity, "imageUrl": nil}
	if s.ImageURL != nil {
		m["imageUrl"] = *s.ImageURL
	}
	return m
}

func (s State) clone() State {
	if s.ImageURL != nil {
		u := *s.ImageURL
		s.ImageURL = &u
	}
	return s
}

// Filter = Electron FileFilter
type Filter struct {
	Name       string
	Extensions []string
}

// Ports：dialogs.pickFiles（取消 → nil）
type Ports struct {
	PickFiles func(title string, filters []Filter) ([]string, error)
}

type Service struct {
	ops                         sync.Mutex // 串行队列（= this.ops）
	mu                          sync.Mutex
	state                       State
	file, imagesDir, presetFile string
	ports                       Ports
	emit                        func(State)
	t                           func(string) string
}

// New：file = userData/chat-background.json，imagesDir = userData/chat/images
func New(file, imagesDir, presetFile string, ports Ports, t func(string) string, emit func(State)) *Service {
	s := &Service{file: file, imagesDir: imagesDir, presetFile: presetFile, ports: ports, emit: emit, t: t}
	var saved any
	if b, err := os.ReadFile(file); err == nil {
		_ = json.Unmarshal(b, &saved)
	}
	s.state = s.withValidImage(Sanitize(saved))
	s.ops.Lock()
	_ = s.persist()
	s.ops.Unlock()
	return s
}

func (s *Service) Get() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state.clone()
}

func (s *Service) set(st State) {
	s.mu.Lock()
	s.state = st
	s.mu.Unlock()
}

// Set：合并补丁并重新校验图片（补丁非对象时等同空补丁）
func (s *Service) Set(patch json.RawMessage) (State, error) {
	s.ops.Lock()
	defer s.ops.Unlock()
	var p any
	_ = json.Unmarshal(patch, &p)
	return s.apply(p)
}

func (s *Service) Reset() (State, error) {
	s.ops.Lock()
	defer s.ops.Unlock()
	d := Default.toMap()
	if u := s.presetURL(); u != nil {
		d["imageUrl"] = *u
	}
	next, err := s.apply(d)
	if err != nil {
		return next, err
	}
	s.removeImageFiles("")
	return next, nil
}

func (s *Service) apply(patch any) (State, error) {
	m := s.Get().toMap()
	if pm, ok := patch.(map[string]any); ok {
		for k, v := range pm {
			m[k] = v
		}
	}
	next := s.withValidImage(Sanitize(m))
	prev := s.Get()
	s.set(next)
	if err := s.persist(); err != nil {
		s.set(prev)
		return State{}, err
	}
	s.broadcast()
	return s.Get(), nil
}

// PickImage = pickImage('chat')
func (s *Service) PickImage() (State, error) {
	if s.ports.PickFiles == nil {
		return s.Get(), nil
	}
	picked, err := s.ports.PickFiles(s.t("electron.common.choose-chat-background-image"),
		[]Filter{{Name: "Images", Extensions: []string{"png", "jpg", "jpeg", "webp", "gif"}}})
	if err != nil {
		return State{}, err
	}
	if len(picked) == 0 || picked[0] == "" {
		return s.Get(), nil
	}
	return s.ImportImage(picked[0])
}

func (s *Service) ImportImage(src string) (State, error) {
	s.ops.Lock()
	defer s.ops.Unlock()
	return s.importNow(src)
}

func uuid() string {
	b := make([]byte, 16)
	_, _ = io.ReadFull(rand.Reader, b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func (s *Service) importNow(src string) (State, error) {
	ext := strings.ToLower(filepath.Ext(src))
	if !imgExt[ext] {
		return State{}, fmt.Errorf("%s: unsupported image type: %s", ErrUnsupported, ext)
	}
	st, err := os.Stat(src)
	if err != nil {
		return State{}, err
	}
	if st.Size() > MaxBytes {
		return State{}, fmt.Errorf("%s: image too large: %d bytes (max %d)", ErrTooLarge, st.Size(), MaxBytes)
	}
	if err := os.MkdirAll(s.imagesDir, 0o755); err != nil {
		return State{}, err
	}
	var resized []byte
	if ext != ".gif" {
		data, err := os.ReadFile(src)
		if err != nil {
			return State{}, err
		}
		if resized, ext, err = Process(ext, data); err != nil {
			return State{}, err
		}
	}
	destName := ImageStem + "." + uuid() + ext
	dest := filepath.Join(s.imagesDir, destName)
	if resized != nil {
		err = os.WriteFile(dest, resized, 0o644)
	} else {
		err = copyFile(src, dest)
	}
	if err != nil {
		return State{}, err
	}
	prev := s.Get()
	m := prev.toMap()
	m["imageUrl"] = ImageURLPrefix + destName
	s.set(Sanitize(m))
	if err := s.persist(); err != nil {
		s.set(prev)
		_ = os.Remove(dest)
		return State{}, err
	}
	s.removeImageFiles(destName)
	s.broadcast()
	return s.Get(), nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func (s *Service) persist() error {
	b, err := json.MarshalIndent(s.Get(), "", "  ")
	if err != nil {
		return err
	}
	return utils.WritePrivateFileAtomic(s.file, b)
}

func (s *Service) presetURL() *string { return s.validImageURL(ptr(PresetURL)) }

func ptr(s string) *string { return &s }

func (s *Service) withValidImage(st State) State {
	if u := s.validImageURL(st.ImageURL); u != nil {
		st.ImageURL = u
	} else {
		st.ImageURL = s.presetURL()
	}
	return st
}

func (s *Service) validImageURL(raw *string) *string {
	if raw == nil || *raw == "" {
		return nil
	}
	u, err := url.Parse(*raw)
	if err != nil {
		return nil
	}
	ep := u.EscapedPath()
	if len(ep) > 0 {
		ep = ep[1:]
	}
	name, err := url.PathUnescape(ep)
	if err != nil {
		return nil
	}
	isPreset := *raw == PresetURL
	if !isPreset && (u.Scheme != "chat-asset" || u.Hostname() != "images" || u.User != nil ||
		u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(*raw, "#") ||
		strings.Contains(name, `\`) || path.Base(name) != name || filepath.Base(name) != name ||
		!strings.HasPrefix(name, ImageStem+".") || !imgExt[strings.ToLower(filepath.Ext(name))]) {
		return nil
	}
	file := filepath.Join(s.imagesDir, name)
	dir := s.imagesDir
	if isPreset {
		file, dir = s.presetFile, filepath.Dir(s.presetFile)
	}
	rf, err := filepath.EvalSymlinks(file)
	if err != nil {
		return nil
	}
	rd, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return nil
	}
	if fi, err := os.Stat(rf); err != nil || !fi.Mode().IsRegular() || !strings.HasPrefix(rf, rd+string(filepath.Separator)) {
		return nil
	}
	return ptr(*raw)
}

func (s *Service) broadcast() {
	if s.emit != nil {
		s.emit(s.Get())
	}
}

func (s *Service) removeImageFiles(keep string) {
	ents, err := os.ReadDir(s.imagesDir)
	if err != nil {
		return
	}
	for _, e := range ents {
		if n := e.Name(); n != keep && strings.HasPrefix(n, ImageStem+".") {
			_ = os.Remove(filepath.Join(s.imagesDir, n))
		}
	}
}

// ErrorCode：错误消息开头的 CHAT_BG_* → 契约错误码（withChatBgErrors）
func ErrorCode(err error) string {
	if err == nil {
		return ""
	}
	m := err.Error()
	for _, c := range []string{ErrTooLarge, ErrUnsupported} {
		if strings.HasPrefix(m, c) {
			return c
		}
	}
	return ""
}

var _ = errors.New
