package theme

// 自定义主题与主题包：基底（light / dark）+ 种子色 + 覆盖令牌，可选另一套明暗（跟随系统）与背景图。
// 令牌推导在视图（packages/ui 的 customTheme.ts）；这里负责存储与导入校验：
//   - 定义：userData/themes/<id>.json，一个主题一个文件；
//   - 背景图：userData/chat/themes/<id>-<随机>.<ext>，经 chat-asset://themes/ 给视图（换图换文件名，不吃缓存）；
//     编辑器里选的图先落成 tmp-<随机>.<ext>，保存时才归到主题名下，启动时清掉没归属的文件；
//   - 主题包：没有背景图是一个 JSON（.nomitheme.json），有背景图是 zip（.nomitheme：theme.json + background.<ext>）。
// 令牌名只认白名单（tokens.go），取值只认颜色写法，杜绝往页面里注 CSS；图片按文件头认类型。

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg" // DecodeConfig
	_ "image/png"  // DecodeConfig
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/chatbg"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

const (
	// CustomPrefix：自定义主题的选择值 custom:<id>
	CustomPrefix = "custom:"
	// PackFormat：当前主题包格式版本（2 = 加了 variants / background；只用到 1 的字段时按 1 导出）
	PackFormat = 2
	// PackExt / ZipPackExt：导出文件名后缀（无背景图 / 有背景图）
	PackExt    = ".nomitheme.json"
	ZipPackExt = ".nomitheme"
	// MaxPackBytes：theme.json 上限
	MaxPackBytes = 64 << 10
	// MaxImageBytes：背景图上限（与图片主题一致）
	MaxImageBytes = chatbg.MaxBytes
	// MaxZipBytes：zip 主题包文件上限
	MaxZipBytes = MaxImageBytes + 1<<20
	// MaxCustomThemes：最多保存多少个自定义主题
	MaxCustomThemes = 100
	// BackgroundURLPrefix：背景图地址
	BackgroundURLPrefix = "chat-asset://themes/"
	maxNameRunes        = 40
	maxAuthorRunes      = 60
	tmpPrefix           = "tmp-"
)

// SeedKeys：种子色（与 customTheme.ts 的 SEED_KEYS 一致）
var SeedKeys = []string{"accent", "background", "surface", "text"}

// Variant：另一套明暗
type Variant struct {
	Seeds  map[string]string `json:"seeds"`
	Tokens map[string]string `json:"tokens,omitempty"`
}

// Background：背景图与蒙版（Image 在存储里是 chat-asset 地址，在 zip 主题包里是包内文件名）
type Background struct {
	Image   string  `json:"image"`
	Blur    float64 `json:"blur"`
	Opacity float64 `json:"opacity"`
}

// Custom：自定义主题；导出的主题包是它去掉 id
type Custom struct {
	ID         string             `json:"id"`
	Format     int                `json:"format"`
	Name       map[string]string  `json:"name"`
	Author     string             `json:"author,omitempty"`
	Base       string             `json:"base"`
	Seeds      map[string]string  `json:"seeds"`
	Tokens     map[string]string  `json:"tokens,omitempty"`
	Variants   map[string]Variant `json:"variants,omitempty"`
	Background *Background        `json:"background,omitempty"`
}

// Pack：主题包 / 保存入参（name 可以是字符串，也可以是 { zh, en }）
type Pack struct {
	Format     int                `json:"format"`
	Name       json.RawMessage    `json:"name"`
	Author     string             `json:"author,omitempty"`
	Base       string             `json:"base"`
	Seeds      map[string]string  `json:"seeds"`
	Tokens     map[string]string  `json:"tokens,omitempty"`
	Variants   map[string]Variant `json:"variants,omitempty"`
	Background *Background        `json:"background,omitempty"`
}

// ErrInvalid：主题包 / 自定义主题不合法（Unwrap 后的原因写日志，给用户看统一文案）
var ErrInvalid = errors.New("invalid theme")

// ErrNotFound：没有这个自定义主题
var ErrNotFound = errors.New("custom theme not found")

// ErrTooMany：自定义主题数量到上限
var ErrTooMany = errors.New("too many custom themes")

// ErrImage：背景图不支持或太大
var ErrImage = errors.New("unsupported background image")

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, a...))
}

var (
	customID  = regexp.MustCompile(`^[a-z0-9]{1,32}$`)
	seedHex   = regexp.MustCompile(`^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`)
	anyHex    = regexp.MustCompile(`^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$`)
	colorFunc = regexp.MustCompile(`^(?i:rgba?|hsla?|oklch)\(\s*[0-9.,%\s/+-]+\)$`)
	bgName    = regexp.MustCompile(`^[a-z0-9-]{1,48}\.(?:png|jpg|webp)$`)
)

// IsCustomPref：custom:<id>（只看格式，不看是否存在）
func IsCustomPref(v string) bool {
	return strings.HasPrefix(v, CustomPrefix) && customID.MatchString(strings.TrimPrefix(v, CustomPrefix))
}

// SafeColor：覆盖令牌的取值只认 hex 与 rgb() / hsl() / oklch()（不允许 url( / var( / 分号 / 花括号）
func SafeColor(v string) bool {
	return len(v) <= 64 && (anyHex.MatchString(v) || colorFunc.MatchString(v))
}

// Adaptive：带了另一套明暗，跟随系统
func (c Custom) Adaptive() bool {
	_, ok := c.Variants[otherBase(c.Base)]
	return ok
}

func otherBase(b string) string {
	if b == "dark" {
		return "light"
	}
	return "dark"
}

func cleanText(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > max {
		s = string([]rune(s)[:max])
	}
	return s
}

func parseName(raw json.RawMessage) (map[string]string, error) {
	out := map[string]string{}
	var one string
	if json.Unmarshal(raw, &one) == nil {
		if n := cleanText(one, maxNameRunes); n != "" {
			out["zh"], out["en"] = n, n
		}
	} else {
		var m map[string]string
		if err := json.Unmarshal(raw, &m); err != nil {
			return nil, invalid("name must be a string or {zh, en}")
		}
		for _, k := range []string{"zh", "en"} {
			if n := cleanText(m[k], maxNameRunes); n != "" {
				out[k] = n
			}
		}
	}
	if len(out) == 0 {
		return nil, invalid("name is empty")
	}
	return out, nil
}

func validSeeds(in map[string]string) (map[string]string, error) {
	seeds := map[string]string{}
	for k, v := range in {
		if !contains(SeedKeys, k) {
			return nil, invalid("unknown seed %q", k)
		}
		if !seedHex.MatchString(v) {
			return nil, invalid("seed %s must be #rgb or #rrggbb", k)
		}
		seeds[k] = strings.ToLower(v)
	}
	return seeds, nil
}

func validTokens(in map[string]string) (map[string]string, error) {
	if len(in) == 0 {
		return nil, nil
	}
	if len(in) > len(ThemeableTokens) {
		return nil, invalid("too many tokens")
	}
	out := map[string]string{}
	for k, v := range in {
		if !contains(ThemeableTokens, k) {
			return nil, invalid("token %q is not themeable", k)
		}
		if !SafeColor(v) {
			return nil, invalid("token %s has an unsupported value", k)
		}
		out[k] = v
	}
	return out, nil
}

func clampBg(b Background) Background {
	fix := func(v, lo, hi, dflt float64) float64 {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return dflt
		}
		return math.Min(hi, math.Max(lo, v))
	}
	b.Blur = fix(b.Blur, 0, 40, chatbg.Default.Blur)
	b.Opacity = fix(b.Opacity, 0.05, 1, chatbg.Default.Opacity)
	return b
}

// Validate：校验并规范化颜色部分（id 与背景图文件由调用方处理；Background 只留蒙版参数）
func Validate(p Pack) (Custom, error) {
	if p.Format == 0 {
		p.Format = 1
	}
	if p.Format > PackFormat {
		return Custom{}, invalid("unsupported format %d", p.Format)
	}
	name, err := parseName(p.Name)
	if err != nil {
		return Custom{}, err
	}
	if p.Base != "light" && p.Base != "dark" {
		return Custom{}, invalid("base must be light or dark")
	}
	seeds, err := validSeeds(p.Seeds)
	if err != nil {
		return Custom{}, err
	}
	tokens, err := validTokens(p.Tokens)
	if err != nil {
		return Custom{}, err
	}
	var variants map[string]Variant
	for k, v := range p.Variants {
		if k != otherBase(p.Base) {
			return Custom{}, invalid("variants may only hold %q (the base is %q)", otherBase(p.Base), p.Base)
		}
		vs, err := validSeeds(v.Seeds)
		if err != nil {
			return Custom{}, err
		}
		vt, err := validTokens(v.Tokens)
		if err != nil {
			return Custom{}, err
		}
		variants = map[string]Variant{k: {Seeds: vs, Tokens: vt}}
	}
	var bg *Background
	if p.Background != nil {
		b := clampBg(*p.Background)
		bg = &b
	}
	return Custom{
		Format:     PackFormat,
		Name:       name,
		Author:     cleanText(p.Author, maxAuthorRunes),
		Base:       p.Base,
		Seeds:      seeds,
		Tokens:     tokens,
		Variants:   variants,
		Background: bg,
	}, nil
}

// ParsePack：读 JSON 主题包（背景图要从 zip 里来，JSON 包里的 background 丢掉）
func ParsePack(raw []byte) (Custom, error) {
	c, err := parseJSON(raw)
	if err != nil {
		return Custom{}, err
	}
	c.Background = nil
	return c, nil
}

func parseJSON(raw []byte) (Custom, error) {
	if len(raw) > MaxPackBytes {
		return Custom{}, invalid("theme.json is larger than %d bytes", MaxPackBytes)
	}
	var p Pack
	if err := json.Unmarshal(raw, &p); err != nil {
		return Custom{}, invalid("not JSON: %v", err)
	}
	return Validate(p)
}

// imageKind：按文件头认图片类型，返回扩展名（.png / .jpg / .webp）
func imageKind(data []byte) (string, error) {
	switch {
	case bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")):
		if _, _, err := image.DecodeConfig(bytes.NewReader(data)); err != nil {
			return "", fmt.Errorf("%w: bad png: %v", ErrImage, err)
		}
		return ".png", nil
	case bytes.HasPrefix(data, []byte{0xff, 0xd8, 0xff}):
		if _, _, err := image.DecodeConfig(bytes.NewReader(data)); err != nil {
			return "", fmt.Errorf("%w: bad jpeg: %v", ErrImage, err)
		}
		return ".jpg", nil
	case len(data) > 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return ".webp", nil
	}
	return "", fmt.Errorf("%w: only PNG, JPEG and WebP are supported", ErrImage)
}

// prepareImage：认类型、超大的按图片主题的规则缩小；返回要写的字节与扩展名
func prepareImage(data []byte) ([]byte, string, error) {
	if len(data) > MaxImageBytes {
		return nil, "", fmt.Errorf("%w: larger than %d bytes", ErrImage, MaxImageBytes)
	}
	ext, err := imageKind(data)
	if err != nil {
		return nil, "", err
	}
	if ext == ".webp" {
		return data, ext, nil
	}
	out, outExt, err := chatbg.Process(ext, data)
	if err != nil {
		return nil, "", fmt.Errorf("%w: %v", ErrImage, err)
	}
	if out == nil {
		return data, ext, nil
	}
	return out, outExt, nil
}

// ParseZipPack：读 zip 主题包（theme.json + 可选 background.<ext>），返回定义与背景图字节
func ParseZipPack(raw []byte) (Custom, []byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return Custom{}, nil, invalid("not a zip: %v", err)
	}
	var meta, img []byte
	read := func(f *zip.File, max int) ([]byte, error) {
		if f.UncompressedSize64 > uint64(max) {
			return nil, invalid("%s is too large", f.Name)
		}
		rc, err := f.Open()
		if err != nil {
			return nil, invalid("%s: %v", f.Name, err)
		}
		defer rc.Close()
		b, err := io.ReadAll(io.LimitReader(rc, int64(max)+1))
		if err != nil || len(b) > max {
			return nil, invalid("%s is too large or unreadable", f.Name)
		}
		return b, nil
	}
	for _, f := range zr.File {
		name := f.Name
		switch {
		case strings.HasPrefix(name, "__MACOSX/") || filepath.Base(name) == ".DS_Store" || f.FileInfo().IsDir():
			continue
		case name == "theme.json":
			if meta, err = read(f, MaxPackBytes); err != nil {
				return Custom{}, nil, err
			}
		case strings.HasPrefix(name, "background.") && !strings.Contains(name, "/"):
			if img, err = read(f, MaxImageBytes); err != nil {
				return Custom{}, nil, err
			}
		default:
			return Custom{}, nil, invalid("unexpected file %q in the pack", name)
		}
	}
	if meta == nil {
		return Custom{}, nil, invalid("theme.json is missing")
	}
	c, err := parseJSON(meta)
	if err != nil {
		return Custom{}, nil, err
	}
	if img == nil {
		c.Background = nil
	} else if c.Background == nil {
		b := clampBg(Background{Blur: chatbg.Default.Blur, Opacity: chatbg.Default.Opacity})
		c.Background = &b
	}
	return c, img, nil
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func newID() string { return randHex(6) }

func (s *Service) customFile(id string) string { return filepath.Join(s.dir, id+".json") }

func bgURL(name string) string { return BackgroundURLPrefix + name }

// bgFile：背景图地址 → 文件路径（不是本目录下合法文件名返回 ""）
func (s *Service) bgFile(url string) string {
	name, ok := strings.CutPrefix(url, BackgroundURLPrefix)
	if !ok || !bgName.MatchString(name) {
		return ""
	}
	return filepath.Join(s.assetDir, name)
}

// loadCustoms：读 themes/ 目录（不合法的文件跳过），再清掉没有归属的背景图
func (s *Service) loadCustoms() {
	s.customs = map[string]Custom{}
	ents, _ := os.ReadDir(s.dir)
	for _, e := range ents {
		id := strings.TrimSuffix(e.Name(), ".json")
		if e.IsDir() || id == e.Name() || !customID.MatchString(id) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(s.dir, e.Name()))
		if err != nil {
			continue
		}
		c, err := parseJSON(raw)
		if err != nil {
			continue
		}
		c.ID = id
		if c.Background != nil {
			if f := s.bgFile(c.Background.Image); f == "" || !fileExists(f) {
				c.Background = nil
			}
		}
		s.customs[id] = c
	}
	s.pruneImages()
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}

// pruneImages：删掉没被任何主题引用的背景图（含编辑器里选了没保存的 tmp-*）
func (s *Service) pruneImages() {
	used := map[string]bool{}
	for _, c := range s.customs {
		if c.Background != nil {
			used[filepath.Base(s.bgFile(c.Background.Image))] = true
		}
	}
	ents, _ := os.ReadDir(s.assetDir)
	for _, e := range ents {
		if !e.IsDir() && bgName.MatchString(e.Name()) && !used[e.Name()] {
			_ = os.Remove(filepath.Join(s.assetDir, e.Name()))
		}
	}
}

func (s *Service) writeCustom(c Custom) error {
	b, _ := json.MarshalIndent(c, "", "  ")
	return utils.WritePrivateFileAtomic(s.customFile(c.ID), append(b, '\n'))
}

// writeImage：把图片写成 <stem>-<随机>.<ext>，返回地址
func (s *Service) writeImage(stem string, data []byte, ext string) (string, error) {
	if err := os.MkdirAll(s.assetDir, 0o755); err != nil {
		return "", err
	}
	name := stem + "-" + randHex(4) + ext
	if err := os.WriteFile(filepath.Join(s.assetDir, name), data, 0o644); err != nil {
		return "", err
	}
	return bgURL(name), nil
}

// StageBackground：编辑器里选的图先落成临时文件，保存主题时才归位；返回地址
func (s *Service) StageBackground(path string) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if st.Size() > MaxImageBytes {
		return "", fmt.Errorf("%w: larger than %d bytes", ErrImage, MaxImageBytes)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	data, ext, err := prepareImage(raw)
	if err != nil {
		return "", err
	}
	return s.writeImage("tmp", data, ext)
}

// ListCustom：按名称排序
func (s *Service) ListCustom() []Custom {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Custom, 0, len(s.customs))
	for _, c := range s.customs {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := displayName(out[i]), displayName(out[j])
		if a != b {
			return a < b
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func displayName(c Custom) string {
	if c.Name["zh"] != "" {
		return c.Name["zh"]
	}
	return c.Name["en"]
}

// SaveCustom：id 为空 = 新建。p.Background.Image 只能是这个主题现有的图，或 StageBackground 给的临时图；
// 是当前主题时广播新的主题状态
func (s *Service) SaveCustom(id string, p Pack) (Custom, error) {
	c, err := Validate(p)
	if err != nil {
		return Custom{}, err
	}
	s.mu.Lock()
	var prev *Custom
	if id == "" {
		if len(s.customs) >= MaxCustomThemes {
			s.mu.Unlock()
			return Custom{}, ErrTooMany
		}
		id = newID()
	} else if old, ok := s.customs[id]; ok {
		prev = &old
	} else {
		s.mu.Unlock()
		return Custom{}, ErrNotFound
	}
	if c.Background != nil {
		img := p.Background.Image
		switch {
		case prev != nil && prev.Background != nil && img == prev.Background.Image:
			c.Background.Image = img
		case strings.HasPrefix(img, BackgroundURLPrefix+tmpPrefix) && fileExists(s.bgFile(img)):
			name := id + "-" + randHex(4) + filepath.Ext(img)
			if err := os.Rename(s.bgFile(img), filepath.Join(s.assetDir, name)); err != nil {
				s.mu.Unlock()
				return Custom{}, err
			}
			c.Background.Image = bgURL(name)
		default:
			s.mu.Unlock()
			return Custom{}, invalid("background image %q is not available", img)
		}
	}
	return s.commit(id, c, prev)
}

// commit：写定义、删掉换下来的旧图、广播（调用方持锁，返回前解锁）
func (s *Service) commit(id string, c Custom, prev *Custom) (Custom, error) {
	c.ID = id
	if err := s.writeCustom(c); err != nil {
		s.mu.Unlock()
		return Custom{}, err
	}
	s.customs[id] = c
	if prev != nil && prev.Background != nil && (c.Background == nil || c.Background.Image != prev.Background.Image) {
		if f := s.bgFile(prev.Background.Image); f != "" {
			_ = os.Remove(f)
		}
	}
	active := s.pref == CustomPrefix+id
	st := s.stateLocked()
	s.mu.Unlock()
	if active {
		s.syncAppearance()
		if s.emit != nil {
			s.emit(st)
		}
	}
	return c, nil
}

// ImportFile：读主题包文件（JSON 或 zip）存成新的自定义主题
func (s *Service) ImportFile(path string) (Custom, error) {
	f, err := os.Open(path)
	if err != nil {
		return Custom{}, err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, MaxZipBytes+1))
	if err != nil {
		return Custom{}, err
	}
	return s.ImportData(raw)
}

// ImportData：主题包字节（拖进导入框的文件，由视图读出后传来）存成新的自定义主题；按文件头认 zip / JSON
func (s *Service) ImportData(raw []byte) (Custom, error) {
	var err error
	if len(raw) > MaxZipBytes {
		return Custom{}, invalid("file is larger than %d bytes", MaxZipBytes)
	}
	var c Custom
	var img []byte
	if bytes.HasPrefix(raw, []byte("PK\x03\x04")) {
		if c, img, err = ParseZipPack(raw); err != nil {
			return Custom{}, err
		}
	} else if c, err = ParsePack(raw); err != nil {
		return Custom{}, err
	}
	var data []byte
	var ext string
	if img != nil {
		if data, ext, err = prepareImage(img); err != nil {
			return Custom{}, err
		}
	}
	s.mu.Lock()
	if len(s.customs) >= MaxCustomThemes {
		s.mu.Unlock()
		return Custom{}, ErrTooMany
	}
	id := newID()
	if data != nil {
		url, err := s.writeImage(id, data, ext)
		if err != nil {
			s.mu.Unlock()
			return Custom{}, err
		}
		c.Background.Image = url
	}
	return s.commit(id, c, nil)
}

// Template：主题包模板（浅色、深色各一套，种子取默认的浅色 / 深色；作者与令牌留空但写出来，给作者看全字段），
// 可以直接再导入
func Template() []byte {
	type variant struct {
		Seeds  map[string]string `json:"seeds"`
		Tokens map[string]string `json:"tokens"`
	}
	b, _ := json.MarshalIndent(struct {
		Format   int                `json:"format"`
		Name     map[string]string  `json:"name"`
		Author   string             `json:"author"`
		Base     string             `json:"base"`
		Seeds    map[string]string  `json:"seeds"`
		Tokens   map[string]string  `json:"tokens"`
		Variants map[string]variant `json:"variants"`
	}{
		Format: PackFormat,
		Name:   map[string]string{"zh": "我的主题", "en": "My theme"},
		Base:   "light",
		Seeds: map[string]string{
			"accent": "#c45425", "background": "#f7f7f7", "surface": "#ffffff", "text": "#141414",
		},
		Tokens: map[string]string{},
		Variants: map[string]variant{"dark": {
			Seeds: map[string]string{
				"accent": "#f08a5d", "background": "#141414", "surface": "#1f1f1f", "text": "#f2f2f2",
			},
			Tokens: map[string]string{},
		}},
	}, "", "  ")
	return append(b, '\n')
}

// packFormat：只用到第 1 版字段的按 1 导出，旧版本也能导入
func packFormat(c Custom) int {
	if len(c.Variants) > 0 || c.Background != nil {
		return PackFormat
	}
	return 1
}

// ExportFile：把主题包（不含 id）写到 path；有背景图写 zip，否则写 JSON
func (s *Service) ExportFile(id, path string) error {
	s.mu.Lock()
	c, ok := s.customs[id]
	s.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	p := Pack{
		Format:   packFormat(c),
		Name:     mustJSON(c.Name),
		Author:   c.Author,
		Base:     c.Base,
		Seeds:    c.Seeds,
		Tokens:   c.Tokens,
		Variants: c.Variants,
	}
	if c.Background == nil {
		b, _ := json.MarshalIndent(p, "", "  ")
		return os.WriteFile(path, append(b, '\n'), 0o644)
	}
	img, err := os.ReadFile(s.bgFile(c.Background.Image))
	if err != nil {
		return err
	}
	entry := "background" + filepath.Ext(s.bgFile(c.Background.Image))
	p.Background = &Background{Image: entry, Blur: c.Background.Blur, Opacity: c.Background.Opacity}
	meta, _ := json.MarshalIndent(p, "", "  ")
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range []struct {
		name string
		data []byte
	}{{"theme.json", append(meta, '\n')}, {entry, img}} {
		w, err := zw.Create(e.name)
		if err != nil {
			return err
		}
		if _, err := w.Write(e.data); err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

// ExportName：导出的默认文件名（名称里的路径字符换成 -；有背景图用 zip 后缀）
func (s *Service) ExportName(id string) string {
	s.mu.Lock()
	c := s.customs[id]
	s.mu.Unlock()
	name := strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' || r == ' ' {
			return r
		}
		return '-'
	}, displayName(c))
	if name = strings.TrimSpace(name); name == "" {
		name = "theme"
	}
	if c.Background != nil {
		return name + ZipPackExt
	}
	return name + PackExt
}

// HasBackground：导出时选 zip 还是 JSON 的筛选
func (s *Service) HasBackground(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.customs[id]
	return ok && c.Background != nil
}

// DeleteCustom：删的是当前主题时退回默认主题
func (s *Service) DeleteCustom(id string) error {
	s.mu.Lock()
	c, ok := s.customs[id]
	if !ok {
		s.mu.Unlock()
		return ErrNotFound
	}
	if err := os.Remove(s.customFile(id)); err != nil && !os.IsNotExist(err) {
		s.mu.Unlock()
		return err
	}
	if c.Background != nil {
		if f := s.bgFile(c.Background.Image); f != "" {
			_ = os.Remove(f)
		}
	}
	delete(s.customs, id)
	active := s.pref == CustomPrefix+id
	if active {
		s.pref = DefaultTheme
		_ = s.persist()
	}
	st := s.stateLocked()
	s.mu.Unlock()
	if active {
		s.syncAppearance()
		if s.emit != nil {
			s.emit(st)
		}
	}
	return nil
}
