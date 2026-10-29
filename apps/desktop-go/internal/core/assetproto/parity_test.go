package assetproto

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type resp struct {
	Request string            `json:"request"`
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}
type urlCase struct {
	URL      string  `json:"url"`
	Resolved *string `json:"resolved"`
	NoRoot   *string `json:"noRoot"`
	Response resp    `json:"response"`
}
type golden struct {
	Tree struct {
		Files    map[string]string `json:"files"`
		Symlinks map[string]string `json:"symlinks"`
	} `json:"tree"`
	Chat, Pack []urlCase
	NoRootResp resp `json:"noRootResp"`
	Mime       []struct{ File, Pack, Chat string }
}

func latin1(b []byte) string {
	r := make([]rune, len(b))
	for i, c := range b {
		r[i] = rune(c)
	}
	return string(r)
}

// 部分用例依赖 POSIX 语义（Node 在 Windows 上走 path.win32：\ 是分隔符），Windows 上跳过
func posixOnly(c urlCase, g golden) bool {
	if strings.Contains(c.URL, `\`) {
		return true
	}
	for l := range g.Tree.Symlinks {
		if strings.Contains(c.URL, filepath.Base(l)) {
			return true
		}
	}
	return false
}

func TestProtocolParity(t *testing.T) {
	raw, err := os.ReadFile("testdata/protocols.json")
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	R, _ := filepath.EvalSymlinks(t.TempDir())
	for p, c := range g.Tree.Files {
		f := filepath.Join(R, filepath.FromSlash(p))
		_ = os.MkdirAll(filepath.Dir(f), 0o755)
		if err := os.WriteFile(f, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	win := runtime.GOOS == "windows"
	// 大小写不敏感文件系统（APFS/NTFS 默认）上 Node 的 fs.realpath 同样能解析大小写变体，
	// Linux 录的 golden 判 null；这类用例只在大小写敏感 FS 上比对
	_, ciErr := os.Stat(filepath.Join(R, "CHAT", "IMAGES", "A.PNG"))
	caseInsensitive := ciErr == nil
	if !win {
		for p, tg := range g.Tree.Symlinks {
			if err := os.Symlink(tg, filepath.Join(R, p)); err != nil {
				t.Fatal(err)
			}
		}
	}
	norm := func(s string) *string {
		if s == "" {
			return nil
		}
		s = filepath.ToSlash(strings.ReplaceAll(s, R, "<ROOT>"))
		return &s
	}
	eqp := func(a, b *string) bool { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }
	show := func(p *string) string {
		if p == nil {
			return "null"
		}
		return *p
	}
	check := func(i int, kind string, c urlCase, got string, serveFn func(*httptest.ResponseRecorder)) {
		if g := norm(got); !eqp(g, c.Resolved) {
			t.Errorf("%s #%d %q resolved: go=%s node=%s", kind, i, c.URL, show(g), show(c.Resolved))
		}
		if c.Response.Request == "invalid" {
			return // Request 构造即失败（Chromium 不会交给处理器）
		}
		rec := httptest.NewRecorder()
		serveFn(rec)
		hd := map[string]string{}
		for k, v := range rec.Header() {
			hd[strings.ToLower(k)] = v[0]
		}
		gotJ, _ := json.Marshal(resp{Status: rec.Code, Headers: hd, Body: latin1(rec.Body.Bytes())})
		wantJ, _ := json.Marshal(c.Response)
		if string(gotJ) != string(wantJ) {
			t.Errorf("%s #%d %q response:\n go=%s\n node=%s", kind, i, c.URL, gotJ, wantJ)
		}
	}
	chatRoot, preset := filepath.Join(R, "chat"), filepath.Join(R, "res", "backgrounds", "nomi-preset.jpg")
	for i, c := range g.Chat {
		if win && posixOnly(c, g) {
			continue
		}
		if caseInsensitive && (strings.HasSuffix(c.URL, "/b.jpg") || strings.HasSuffix(c.URL, "/A.PNG")) {
			continue
		}
		check(i, "chat", c, ResolveChatAssetURL(chatRoot, c.URL, preset), func(w *httptest.ResponseRecorder) { ServeChatAsset(w, chatRoot, preset, c.URL) })
	}
	packRoot := filepath.Join(R, "pack")
	for i, c := range g.Pack {
		if ResolveCharacterPackURL("", c.URL) != "" || c.NoRoot != nil {
			t.Errorf("pack #%d noRoot", i)
		}
		if win && posixOnly(c, g) {
			continue
		}
		check(i, "pack", c, ResolveCharacterPackURL(packRoot, c.URL), func(w *httptest.ResponseRecorder) { ServeCharacterPack(w, packRoot, c.URL) })
	}
	rec := httptest.NewRecorder()
	ServeCharacterPack(rec, "", "character-pack://pack/manifest.json")
	if rec.Code != g.NoRootResp.Status || rec.Body.String() != g.NoRootResp.Body {
		t.Errorf("noRoot response %d %q", rec.Code, rec.Body.String())
	}
	for _, m := range g.Mime {
		if p, c := CharacterPackMimeFor(m.File), ChatAssetMimeFor(m.File); p != m.Pack || c != m.Chat {
			t.Errorf("mime %q: go=%s/%s node=%s/%s", m.File, p, c, m.Pack, m.Chat)
		}
	}
}
