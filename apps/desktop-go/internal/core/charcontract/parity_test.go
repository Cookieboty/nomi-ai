package charcontract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func loadGolden(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

// norm：Node 录下的 JSON 文本经同一套解析 / 序列化，消掉转义写法上的差异。
func norm(t *testing.T, s string) string {
	t.Helper()
	v, err := ParseJSON(s)
	if err != nil {
		t.Fatalf("golden not JSON: %v", err)
	}
	return Stringify(v)
}

func TestJSONParseParity(t *testing.T) {
	var cases []struct {
		Src   string  `json:"src"`
		OK    bool    `json:"ok"`
		Value *string `json:"value"`
		Error string  `json:"error"`
	}
	loadGolden(t, "json.json", &cases)
	fails := 0
	for _, c := range cases {
		v, err := ParseJSON(c.Src)
		var got, want string
		if err != nil {
			got = "ERR " + err.Error()
		} else {
			got = "OK " + Stringify(v)
		}
		if c.OK {
			want = "OK " + norm(t, *c.Value)
		} else {
			want = "ERR " + c.Error
		}
		if got != want {
			fails++
			if fails <= 15 {
				t.Errorf("src %q\n got  %s\n want %s", c.Src, got, want)
			}
		}
	}
	if fails > 0 {
		t.Errorf("%d/%d mismatches", fails, len(cases))
	}
}

type goldIssue struct {
	Code    string   `json:"code"`
	Path    []any    `json:"path"`
	Message string   `json:"message"`
	Keys    []string `json:"keys"`
}

func issuesString(iss []Issue) string {
	var b []byte
	for _, is := range iss {
		path := make([]any, len(is.Path))
		for i, p := range is.Path {
			if n, ok := p.(int); ok {
				path[i] = float64(n)
			} else {
				path[i] = p
			}
		}
		o := NewObj()
		o.Set("code", is.Code)
		o.Set("path", path)
		o.Set("message", is.Message)
		if is.Keys != nil {
			ks := make([]any, len(is.Keys))
			for i, k := range is.Keys {
				ks[i] = k
			}
			o.Set("keys", ks)
		} else {
			o.Set("keys", nil)
		}
		b = append(b, Stringify(o)...)
		b = append(b, '\n')
	}
	return string(b)
}

func TestSchemaParity(t *testing.T) {
	var cases []struct {
		Schema string      `json:"schema"`
		Input  string      `json:"input"`
		OK     bool        `json:"ok"`
		Data   *string     `json:"data"`
		Issues []goldIssue `json:"issues"`
	}
	loadGolden(t, "schemas.json", &cases)
	fails := 0
	for _, c := range cases {
		in, err := ParseJSON(c.Input)
		if err != nil {
			t.Fatal(err)
		}
		ok, data, iss := SafeParse(Schemas[c.Schema], in)
		var want []Issue
		for _, g := range c.Issues {
			is := Issue{Code: g.Code, Message: g.Message, Keys: g.Keys}
			for _, p := range g.Path {
				if f, isNum := p.(float64); isNum {
					is.Path = append(is.Path, int(f))
				} else {
					is.Path = append(is.Path, p)
				}
			}
			want = append(want, is)
		}
		got, exp := issuesString(iss), issuesString(want)
		if ok {
			got = "OK " + Stringify(data)
		}
		if c.OK {
			exp = "OK " + norm(t, *c.Data)
		}
		if got != exp {
			fails++
			if fails <= 12 {
				t.Errorf("%s %s\n got  %s\n want %s", c.Schema, c.Input, got, exp)
			}
		}
	}
	if fails > 0 {
		t.Errorf("%d/%d mismatches", fails, len(cases))
	}
}
