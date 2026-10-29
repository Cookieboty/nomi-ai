package assetproto

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const (
	ChatAssetScheme     = "chat-asset"
	CharacterPackScheme = "character-pack"
	// ChatBgPresetURL 与 @nomi-ai/types CHAT_BG_PRESET_URL 一致
	ChatBgPresetURL = "chat-asset://presets/background.jpg"
)

var imgMime = map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}

var packMime = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".json": "application/json", ".riv": "application/octet-stream",
	".md": "text/markdown; charset=utf-8",
}

var areas = map[string]bool{"images": true, "presets": true}
var sepRe = regexp.MustCompile(`[\\/]`)

// extname：Node path.extname（以点开头的纯文件名无扩展名）
func extname(p string) string {
	base := p
	if i := strings.LastIndexAny(p, `/`+string(filepath.Separator)); i >= 0 {
		base = p[i+1:]
	}
	d := strings.LastIndexByte(base, '.')
	if d <= 0 {
		return ""
	}
	return base[d:]
}

func ChatAssetMimeFor(file string) string {
	if m, ok := imgMime[strings.ToLower(extname(file))]; ok {
		return m
	}
	return "application/octet-stream"
}

func CharacterPackMimeFor(file string) string {
	if m, ok := packMime[strings.ToLower(extname(file))]; ok {
		return m
	}
	return "application/octet-stream"
}

func decodeRel(pathname string) (string, bool) {
	rel, ok := decodeURIComponent(pathname)
	if !ok {
		return "", false
	}
	return strings.TrimLeft(rel, "/"), true
}

func realpath(p string) (string, bool) {
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", false
	}
	r, err = filepath.Abs(r)
	if err != nil {
		return "", false
	}
	// fsp.realpath = libuv uv_fs_realpath → realpath(3)/GetFinalPathNameByHandle：返回磁盘上的真实大小写，
	// EvalSymlinks 在 mac 上保留输入大小写，这里补齐（Windows 的 EvalSymlinks 已是磁盘大小写）
	return diskCase(r), true
}

// ResolveChatAssetURL 对应 resolveChatAssetUrl；返回 "" 即 Node 的 null
func ResolveChatAssetURL(root, rawURL, presetFile string) string {
	u, ok := parseURL(rawURL)
	if !ok || u.Protocol != ChatAssetScheme+":" || !areas[u.Hostname] {
		return ""
	}
	if u.Hostname == "presets" && rawURL != ChatBgPresetURL {
		return ""
	}
	rel, ok := decodeRel(u.Pathname)
	if !ok || rel == "" || strings.Contains(rel, "\x00") {
		return ""
	}
	for _, seg := range sepRe.Split(rel, -1) {
		if seg == ".." || seg == "" {
			return ""
		}
	}
	if _, ok := imgMime[strings.ToLower(extname(rel))]; !ok {
		return ""
	}
	isPreset := u.Hostname == "presets"
	var base, file string
	if isPreset {
		base, file = filepath.Dir(presetFile), presetFile
	} else {
		base, _ = filepath.Abs(filepath.Join(root, u.Hostname))
		file, _ = filepath.Abs(filepath.Join(base, rel))
	}
	sep := string(filepath.Separator)
	if !strings.HasPrefix(file, base+sep) {
		return ""
	}
	real, ok1 := realpath(file)
	realBase, ok2 := realpath(base)
	if !ok1 || !ok2 || !strings.HasPrefix(real, realBase+sep) {
		return ""
	}
	return real
}

// ResolveCharacterPackURL 对应 resolveCharacterPackUrl（root 为空即 null）
func ResolveCharacterPackURL(root, rawURL string) string {
	if root == "" {
		return ""
	}
	u, ok := parseURL(rawURL)
	if !ok || u.Protocol != CharacterPackScheme+":" || u.Hostname != "pack" {
		return ""
	}
	rel, ok := decodeRel(u.Pathname)
	if !ok || rel == "" || strings.Contains(rel, "\x00") {
		return ""
	}
	for _, seg := range sepRe.Split(rel, -1) {
		if seg == ".." {
			return ""
		}
	}
	base, _ := filepath.Abs(root)
	file, _ := filepath.Abs(filepath.Join(base, rel))
	sep := string(filepath.Separator)
	if !strings.HasPrefix(file, base+sep) && file != base {
		return ""
	}
	real, ok1 := realpath(file)
	realBase, ok2 := realpath(base)
	if !ok1 || !ok2 || (!strings.HasPrefix(real, realBase+sep) && real != realBase) {
		return ""
	}
	return real
}

// serve：两协议共用的响应体（整读入内存再返回；不支持 Range，与 Electron 实现一致）
func serve(w http.ResponseWriter, file string, mime func(string) string) {
	var body []byte
	var err error
	if file != "" {
		body, err = os.ReadFile(file)
	}
	if file == "" || err != nil {
		w.Header().Set("Content-Type", "text/plain;charset=UTF-8")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("not found"))
		return
	}
	h := w.Header()
	h.Set("Content-Type", mime(file))
	h.Set("Content-Length", strconv.Itoa(len(body)))
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// ServeChatAsset：registerChatAssetProtocol 的处理体；rawURL 为原始 chat-asset:// 地址
func ServeChatAsset(w http.ResponseWriter, root, presetFile, rawURL string) {
	serve(w, ResolveChatAssetURL(root, rawURL, presetFile), ChatAssetMimeFor)
}

// ServeCharacterPack：registerCharacterPackProtocol 的处理体
func ServeCharacterPack(w http.ResponseWriter, root, rawURL string) {
	serve(w, ResolveCharacterPackURL(root, rawURL), CharacterPackMimeFor)
}
