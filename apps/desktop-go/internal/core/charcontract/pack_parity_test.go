package charcontract

import (
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

type packEntry struct {
	B64  *string `json:"b64"`
	Size *int    `json:"size"`
}

type packCase struct {
	Base    *string              `json:"base"`
	Del     []string             `json:"del"`
	Set     map[string]packEntry `json:"set"`
	Strict  string               `json:"strict"`
	Lenient string               `json:"lenient"`
	Load    string               `json:"load"`
}

func normGolden(t *testing.T, s string) string {
	v, err := ParseJSON(s)
	if err != nil {
		t.Fatal(err)
	}
	return Stringify(v)
}

func runValidate(dir string, lenient bool) (out string) {
	defer func() {
		if e := recover(); e != nil {
			o := NewObj()
			o.Set("thrown", e.(JSThrow).Message)
			out = Stringify(o)
		}
	}()
	return Stringify(ValidatePackDirSync(dir, ValidateOptions{Lenient: lenient}).JS())
}

func TestPackParity(t *testing.T) {
	f, err := os.Open("testdata/packs.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Bases map[string]map[string]packEntry `json:"bases"`
		Cases []packCase                      `json:"cases"`
	}
	if err := json.NewDecoder(zr).Decode(&data); err != nil {
		t.Fatal(err)
	}
	tmp := t.TempDir()
	fails := 0
	for i, c := range data.Cases {
		dir := filepath.Join(tmp, strconv.Itoa(i))
		if c.Base != nil {
			files := map[string]packEntry{}
			for k, v := range data.Bases[*c.Base] {
				files[k] = v
			}
			for _, p := range c.Del {
				delete(files, p)
			}
			for k, v := range c.Set {
				files[k] = v
			}
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
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
				if err := os.WriteFile(abs, b, 0o644); err != nil {
					t.Fatal(err)
				}
			}
		}
		fix := func(s string) string { return strings.ReplaceAll(s, dir, "<DIR>") }
		check := func(what, got, want string) {
			want = normGolden(t, want)
			if got != want && fails < 8 {
				fails++
				t.Errorf("case %d %s:\n got  %s\n want %s", i, what, got, want)
			} else if got != want {
				fails++
			}
		}
		check("strict", fix(runValidate(dir, false)), c.Strict)
		check("lenient", fix(runValidate(dir, true)), c.Lenient)
		lr := LoadPackAt(dir, true)
		lo := NewObj()
		if strings.HasPrefix(lr.Reason, "Cannot read") {
			lo.Set("thrown", lr.Reason)
		} else {
			lo.Set("ok", lr.OK)
			if lr.OK {
				lo.Set("reason", nil)
				dg := []any{}
				for _, d := range lr.Downgraded {
					dg = append(dg, d)
				}
				lo.Set("downgraded", dg)
			} else {
				lo.Set("reason", lr.Reason)
				lo.Set("downgraded", nil)
			}
		}
		check("load", fix(Stringify(lo)), c.Load)
	}
	if fails > 0 {
		t.Fatalf("%d/%d mismatches", fails, len(data.Cases)*3)
	}
}
