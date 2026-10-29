package persona

import (
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	cc "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
)

type entry struct {
	B64  *string `json:"b64"`
	Size *int    `json:"size"`
}

// TestPersonaParity：Node 录制（scripts/parity/record-character-contract.mjs）的 packPersonaSource + resolvePersona
func TestPersonaParity(t *testing.T) {
	f, err := os.Open("../charcontract/testdata/packs.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zr, _ := gzip.NewReader(f)
	var data struct {
		Bases map[string]map[string]entry `json:"bases"`
		Cases []struct {
			Base    *string          `json:"base"`
			Del     []string         `json:"del"`
			Set     map[string]entry `json:"set"`
			Persona *string          `json:"persona"`
		} `json:"cases"`
	}
	if err := json.NewDecoder(zr).Decode(&data); err != nil {
		t.Fatal(err)
	}
	tmp := t.TempDir()
	n, fails := 0, 0
	for i, c := range data.Cases {
		if c.Persona == nil || c.Base == nil {
			continue
		}
		n++
		dir := filepath.Join(tmp, strconv.Itoa(i))
		files := map[string]entry{}
		for k, v := range data.Bases[*c.Base] {
			files[k] = v
		}
		for _, p := range c.Del {
			delete(files, p)
		}
		for k, v := range c.Set {
			files[k] = v
		}
		for p, e := range files {
			abs := filepath.Join(dir, filepath.FromSlash(p))
			_ = os.MkdirAll(filepath.Dir(abs), 0o755)
			var b []byte
			if e.B64 != nil {
				b, _ = base64.StdEncoding.DecodeString(*e.B64)
			} else {
				b = make([]byte, *e.Size)
			}
			_ = os.WriteFile(abs, b, 0o644)
		}
		lr := cc.LoadPackAt(dir, true)
		if !lr.OK {
			t.Fatalf("case %d: load not ok: %s", i, lr.Reason)
		}
		src := PackSource("", func() *ActivePack { return &ActivePack{Root: dir, Manifest: lr.Pack.Get("manifest")} }, nil)
		b, err := src.Load()
		var got string
		switch {
		case err != nil:
			got = `{"thrown":` + strconv.Quote(err.Error()) + `}`
		case b == nil:
			got = "null"
		default:
			parts := []string{}
			for _, l := range []string{"zh-CN", "en-US", "ja", "ZH_tw", ""} {
				j, _ := json.Marshal(Resolve(b, l))
				k, _ := json.Marshal(l)
				parts = append(parts, string(k)+":"+string(j))
			}
			got = "{" + strings.Join(parts, ",") + "}"
		}
		want := strings.ReplaceAll(*c.Persona, "<DIR>", dir)
		if got != want {
			fails++
			if fails < 6 {
				t.Errorf("case %d:\n got  %s\n want %s", i, got, want)
			}
		}
	}
	if n < 300 {
		t.Fatalf("too few persona cases: %d", n)
	}
	t.Logf("persona cases: %d, fails: %d", n, fails)
}

func TestDefaultSystemPrompt(t *testing.T) {
	tr := func(string) string { return "  guide \n" }
	if g := DefaultSystemPrompt(&Persona{SystemPromptIdentity: " id "}, tr); g != "id\nguide" {
		t.Fatal(g)
	}
	if g := DefaultSystemPrompt(nil, tr); g != "guide" {
		t.Fatal(g)
	}
}
