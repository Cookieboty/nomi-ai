package gwstore

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 录制脚本里的确定性假 safeStorage：base64("ss:"+明文)
type fakeCipher struct{}

func (fakeCipher) Kind() string { return "safeStorage" }
func (fakeCipher) Encrypt(p string) (string, error) {
	return base64.StdEncoding.EncodeToString([]byte("ss:" + p)), nil
}
func (fakeCipher) Decrypt(s string) (string, error) {
	t := providers.NodeBase64Decode(s)
	if !strings.HasPrefix(t, "ss:") {
		return "", errors.New("bad")
	}
	return t[3:], nil
}

type golden struct {
	Scenarios []struct {
		Name  string                       `json:"name"`
		Seed  map[string]string            `json:"seed"`
		Steps []map[string]json.RawMessage `json:"steps"`
		Files map[string]string            `json:"files"`
	} `json:"scenarios"`
}

var clock float64

func fixRandom(t *testing.T) {
	oldNow, oldUUID, oldRB := Now, RandomUUID, RandomBytes
	t.Cleanup(func() { Now, RandomUUID, RandomBytes = oldNow, oldUUID, oldRB })
	clock = 1793500000000
	uuid, rb := 0, 0
	Now = func() float64 { return clock }
	RandomUUID = func() string { uuid++; return fmt.Sprintf("%08x-0000-4000-8000-000000000000", uuid) }
	RandomBytes = func(n int) []byte {
		rb++
		b := make([]byte, n)
		for i := range b {
			b[i] = byte(rb)
		}
		return b
	}
	_ = hex.EncodeToString
}

func tree(t *testing.T, dir string) map[string]string {
	out := map[string]string{}
	esc := strings.ReplaceAll(dir, `\`, `\\`)
	_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		b, _ := os.ReadFile(p)
		s := strings.ReplaceAll(strings.ReplaceAll(string(b), esc, "<UD>"), dir, "<UD>")
		if runtime.GOOS == "windows" {
			s = strings.ReplaceAll(s, `<UD>\\`, "<UD>/")
		}
		out[filepath.ToSlash(rel)] = s
		return nil
	})
	return out
}

func diffTrees(t *testing.T, label string, want, got map[string]string) {
	t.Helper()
	keys := map[string]bool{}
	for k := range want {
		keys[k] = true
	}
	for k := range got {
		keys[k] = true
	}
	ks := []string{}
	for k := range keys {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	for _, k := range ks {
		w, wok := want[k]
		g, gok := got[k]
		if !wok || !gok {
			t.Errorf("%s: file %s present node=%v go=%v", label, k, wok, gok)
			continue
		}
		if w != g {
			t.Errorf("%s: %s differs\n--- node\n%s\n--- go\n%s", label, k, w, g)
		}
	}
}

func service(ud string) *Service {
	c := fakeCipher{}
	return NewService(filepath.Join(ud, "gateway"), c, nil, &Legacy{
		NomiFile: filepath.Join(ud, "ai-providers.json"), CliRoot: filepath.Join(ud, "cli-providers"),
		CliDecrypt: LegacyCliKeyDecryptor(c),
	})
}

func TestGatewayStoreParity(t *testing.T) {
	raw, err := os.ReadFile("testdata/gwstore.json")
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Scenarios) != 8 {
		t.Fatalf("scenarios=%d", len(g.Scenarios))
	}
	for _, sc := range g.Scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			fixRandom(t)
			ud := t.TempDir()
			for rel, content := range sc.Seed {
				p := filepath.Join(ud, filepath.FromSlash(rel))
				_ = os.MkdirAll(filepath.Dir(p), 0o755)
				if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if err := service(ud).Init(); err != nil {
				t.Fatal(err)
			}
			if len(sc.Steps) > 0 {
				runRestart(t, ud, sc.Steps)
			}
			diffTrees(t, "final", sc.Files, tree(t, ud))
		})
	}
}

func runRestart(t *testing.T, ud string, steps []map[string]json.RawMessage) {
	files := func(i int) map[string]string {
		var m map[string]string
		_ = json.Unmarshal(steps[i]["files"], &m)
		return m
	}
	clock += 1000
	s2 := service(ud)
	if err := s2.Init(); err != nil {
		t.Fatal(err)
	}
	diffTrees(t, "second init", files(0), tree(t, ud))
	st := s2.Store
	clock += 1000
	st.UpsertProvider(u.NewObj("id", st.UniqueProviderID("DeepSeek"), "name", "DeepSeek 2", "enabled", true,
		"urls", u.NewObj("chat", "https://x.example.com"),
		"keys", []any{st.MakeKey("sk-new-key-1234567", KeyOpts{Name: "n", Wire: "chat"}), st.MakeKey("short", KeyOpts{})},
		"models", []any{u.NewObj("id", "m", "enabled", true)}, "modelsSource", "manual", "source", "user",
		"createdAt", clock, "updatedAt", 0.0))
	must(t, st.SetClient("nomi", ClientPatch{Models: u.NewObj("main", "deepseek-2/m", "tools", nil, "summary", ""), AccountSet: true}))
	must(t, st.SetClient("claude", ClientPatch{Models: u.NewObj("main", "x/y"), NewTabSource: "thirdParty", AccountSet: true, AccountID: "acc-1"}))
	st.ResetToken("codex")
	st.RemoveProvider("deepseek")
	st.SetLearned("openai-proxy", u.NewObj("chat", u.NewObj("ok", true)))
	tokens := u.NewObj()
	for _, c := range []string{"nomi", "claude", "codex", "gemini", "grok", "dsh"} {
		if v, ok := st.ClientToken(c); ok {
			tokens.Set(c, v)
		} else {
			tokens.Set(c, nil)
		}
	}
	got := u.Stringify(u.NewObj("tokens", tokens, "privacyKey", st.PrivacyKey(), "port", st.Port(), "unique", st.UniqueProviderID("Open AI Proxy!")))
	want := map[string]json.RawMessage{}
	for k, v := range steps[1] {
		want[k] = v
	}
	wantObj, _ := u.Parse(mustJSON(want, []string{"tokens", "privacyKey", "port", "unique"}))
	if w := u.Stringify(wantObj); w != got {
		t.Errorf("mutation results\nnode %s\ngo   %s", w, got)
	}
	must(t, st.Save())
	clock += 1000
	s3 := service(ud)
	must(t, s3.Init())
	diffTrees(t, "third init", files(2), tree(t, ud))
	var wantIDs []string
	_ = json.Unmarshal(steps[2]["providers"], &wantIDs)
	gotIDs := []string{}
	for _, p := range s3.Store.Providers() {
		gotIDs = append(gotIDs, u.JSString(p.(*u.Obj).Get("id")))
	}
	if strings.Join(wantIDs, ",") != strings.Join(gotIDs, ",") {
		t.Errorf("providers node=%v go=%v", wantIDs, gotIDs)
	}
}

func mustJSON(m map[string]json.RawMessage, order []string) []byte {
	var b strings.Builder
	b.WriteString("{")
	for i, k := range order {
		if i > 0 {
			b.WriteString(",")
		}
		kb, _ := json.Marshal(k)
		b.Write(kb)
		b.WriteString(":")
		b.Write(m[k])
	}
	b.WriteString("}")
	return []byte(b.String())
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
