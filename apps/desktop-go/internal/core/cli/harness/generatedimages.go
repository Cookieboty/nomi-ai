package harness

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var chatImageExts = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".gif": true}

const (
	maxGeneratedImageBytes = 20 * 1024 * 1024
	imageAliasFile         = "image-aliases.json"
)

// ImageAliases = Map<string,string>（保持插入序）。
type ImageAliases = *util.Obj

// MaterializeGeneratedImages = materializeGeneratedImages。
func MaterializeGeneratedImages(rawOutput, home, chatRoot string, aliases ImageAliases) {
	value, err := util.ParseString(rawOutput)
	if err != nil {
		return
	}
	paths := util.NewObj() // Set 插入序
	var visit func(v any, depth int)
	visit = func(v any, depth int) {
		if depth > 6 || v == nil {
			return
		}
		if a, ok := v.([]any); ok {
			for _, x := range a {
				visit(x, depth+1)
			}
			return
		}
		o, ok := v.(*util.Obj)
		if !ok {
			return
		}
		if p, ok := o.Get("path").(string); ok {
			paths.Set(p, true)
		}
		for _, k := range []string{"content", "rawOutput", "output", "result", "data"} {
			visit(o.Get(k), depth+1)
		}
	}
	visit(value, 0)
	if len(paths.Keys()) == 0 {
		return
	}
	cand := []string{filepath.Join(home, ".grok", "sessions")}
	if g := os.Getenv("GROK_HOME"); g != "" {
		cand = append(cand, filepath.Join(g, "sessions"))
	}
	roots := []string{}
	for _, x := range cand {
		if x == "" {
			continue
		}
		r, _ := filepath.Abs(x)
		if rr, err := realpath(r); err == nil {
			r = rr
		}
		roots = append(roots, r)
	}
	destDir := filepath.Join(chatRoot, "images")
	changed := false
	for _, raw := range paths.Keys() {
		ext := util.JSLower(nodeExtname(raw))
		if !chatImageExts[ext] {
			continue
		}
		normalized := strings.TrimPrefix(strings.ReplaceAll(raw, `\`, "/"), "./")
		shortAlias := normalized
		if m := strings.LastIndex(normalized, "/images/"); m >= 0 {
			shortAlias = normalized[m+1:]
		}
		existing, _ := aliases.Get(normalized).(string)
		if existing == "" {
			existing, _ = aliases.Get(raw).(string)
		}
		if existing != "" && materializedImageExists(chatRoot, existing) {
			aliases.Set(normalized, existing)
			aliases.Set(raw, existing)
			aliases.Set(shortAlias, existing)
			continue
		}
		var candidate string
		if filepath.IsAbs(raw) {
			candidate = filepath.Clean(raw)
		} else {
			candidate, _ = filepath.Abs(filepath.Join(roots[0], raw))
		}
		real, err := realpath(candidate)
		if err != nil {
			continue
		}
		st, err := os.Stat(real)
		if err != nil || !st.Mode().IsRegular() || st.Size() > maxGeneratedImageBytes {
			continue
		}
		inRoot := false
		for _, r := range roots {
			if real == r || strings.HasPrefix(real, r+string(filepath.Separator)) {
				inRoot = true
				break
			}
		}
		if !inRoot {
			continue
		}
		file := "grok-" + clisdk.RandomUUID() + ext
		dest := filepath.Join(destDir, file)
		if os.MkdirAll(destDir, 0o777) != nil || copyFile(real, dest) != nil {
			continue
		}
		url := "chat-asset://images/" + file
		aliases.Set(normalized, url)
		aliases.Set(raw, url)
		aliases.Set(shortAlias, url)
		changed = true
	}
	if changed {
		persistImageAliases(chatRoot, aliases)
	}
}

func realpath(p string) (string, error) {
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", err
	}
	return filepath.Abs(r)
}

func copyFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, b, 0o666)
}

// nodeExtname = path.extname（只用于匹配图片扩展名：取 basename 最后一个非首位的点）。
func nodeExtname(p string) string {
	base := filepath.Base(p)
	i := strings.LastIndex(base, ".")
	if i <= 0 {
		return ""
	}
	return base[i:]
}

var chatAssetFile = regexp.MustCompile(`^chat-asset://images/([^/]+)$`)
var chatAssetOK = regexp.MustCompile(`^chat-asset://images/[A-Za-z0-9._-]+$`)

func materializedImageExists(chatRoot, url string) bool {
	m := chatAssetFile.FindStringSubmatch(url)
	if m == nil {
		return false
	}
	dir, _ := filepath.Abs(filepath.Join(chatRoot, "images"))
	file, _ := filepath.Abs(filepath.Join(dir, m[1]))
	if !strings.HasPrefix(file, dir+string(filepath.Separator)) {
		return false
	}
	_, err := os.Stat(file)
	return err == nil
}

// LoadImageAliases = loadImageAliases。
func LoadImageAliases(chatRoot string) ImageAliases {
	out := util.NewObj()
	b, err := os.ReadFile(filepath.Join(chatRoot, imageAliasFile))
	if err != nil {
		return out
	}
	v, err := util.ParseString(string(b))
	o, ok := v.(*util.Obj)
	if err != nil || !ok {
		return out
	}
	for _, k := range o.Keys() {
		if s, ok := o.Get(k).(string); ok && chatAssetOK.MatchString(s) {
			out.Set(k, s)
		}
	}
	return out
}

func persistImageAliases(chatRoot string, aliases ImageAliases) {
	if os.MkdirAll(chatRoot, 0o777) != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(chatRoot, imageAliasFile), []byte(util.Stringify(aliases)), 0o666)
}

var imgLink = regexp.MustCompile(`(!\[[^\]]*\]\()([^)]+)(\))`)

// RewriteGeneratedImageLinks = rewriteGeneratedImageLinks。
func RewriteGeneratedImageLinks(text string, aliases ImageAliases) string {
	if len(aliases.Keys()) == 0 || !strings.Contains(text, "![") {
		return text
	}
	return imgLink.ReplaceAllStringFunc(text, func(full string) string {
		m := imgLink.FindStringSubmatch(full)
		key := util.JSTrim(m[2])
		decoded := key
		if d, err := util.DecodeURIComponent(key); err == nil {
			decoded = d
		}
		url, _ := aliases.Get(key).(string)
		if url == "" {
			url, _ = aliases.Get(decoded).(string)
		}
		if url == "" {
			return full
		}
		return m[1] + url + m[3]
	})
}
