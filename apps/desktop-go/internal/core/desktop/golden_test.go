package desktop

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/parse"
)

// 金样回放：scripts/parity/desktop-record.mjs 录制的 Node 输出 vs Go 输出（JSON 规范化：键排序）

type goldenCase map[string]json.RawMessage

func norm(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

func unb64(s json.RawMessage) []byte {
	var str string
	_ = json.Unmarshal(s, &str)
	b, _ := base64.StdEncoding.DecodeString(str)
	return b
}

func str(s json.RawMessage) string {
	var v string
	_ = json.Unmarshal(s, &v)
	return v
}

func catchParse(f func() any) (out any) {
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(*parse.Error); ok {
				out = map[string]any{"error": e.Code}
				return
			}
			out = map[string]any{"error": fmt.Sprint(r)}
		}
	}()
	return f()
}

func TestGoldenParity(t *testing.T) {
	raw, err := os.ReadFile("testdata/golden/desktop.json")
	if err != nil {
		t.Fatal(err)
	}
	var g map[string][]goldenCase
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	total, fail := 0, 0
	check := func(sec string, i int, want json.RawMessage, got any) {
		total++
		var w any
		_ = json.Unmarshal(want, &w)
		if gn := norm(t, got); !reflect.DeepEqual(w, gn) {
			fail++
			if fail <= 15 {
				gb, _ := json.Marshal(gn)
				t.Errorf("%s[%d]\n want %s\n  got %s", sec, i, want, gb)
			}
		}
	}
	for i, c := range g["decide"] {
		var in struct {
			Danger         Danger `json:"danger"`
			Policy         any    `json:"policy"`
			SessionAllowed bool   `json:"sessionAllowed"`
			Tainted        bool   `json:"tainted"`
			Mode           string `json:"mode"`
			ExplicitPolicy bool   `json:"explicitPolicy"`
		}
		_ = json.Unmarshal(c["input"], &in)
		check("decide", i, c["out"], Decide(ConsentInput{Danger: in.Danger, Policy: in.Policy, SessionAllowed: in.SessionAllowed, Tainted: in.Tainted, Mode: PermMode(in.Mode), ExplicitPolicy: in.ExplicitPolicy}))
	}
	for i, c := range g["sanitize"] {
		var got any = SanitizePolicy(Danger(str(c["danger"])), jsAny(c["p"]))
		if got == Policy("") {
			got = nil // Node: undefined
		}
		check("sanitize", i, c["out"], got)
	}
	for i, c := range g["local"] {
		check("local", i, c["out"], IsLocalBaseURL(str(c["u"])))
	}
	for i, c := range g["redact"] {
		check("redact", i, c["out"], RedactArgs(jsAny(c["a"])))
	}
	for i, c := range g["decode"] {
		b := unb64(c["b"])
		check("decode", i, c["out"], catchParse(func() any { return parse.DecodeText(b) }))
	}
	for i, c := range g["docxXml"] {
		check("docxXml", i, c["out"], parse.DocxXMLToText(str(c["x"])))
	}
	for i, c := range g["odtXml"] {
		check("odtXml", i, c["out"], parse.OdtXMLToText(str(c["x"])))
	}
	for i, c := range g["rtf"] {
		check("rtf", i, c["out"], parse.RtfToText(unb64(c["r"])))
	}
	for i, c := range g["extract"] {
		b, name := unb64(c["b"]), str(c["name"])
		check("extract", i, c["out"], catchParse(func() any { return parse.Extract(b, name) }))
	}
	for i, c := range g["chunk"] {
		var size, max int
		_ = json.Unmarshal(c["size"], &size)
		_ = json.Unmarshal(c["max"], &max)
		check("chunk", i, c["out"], ChunkText(str(c["t"]), size, max))
	}
	samples := []string{"a.txt", "A.TXT", "dir/a.txt", "a.md", ".txt", "ab", "a.b.c", "x?y", "notes (1).txt", "a+b.txt", "abc"}
	for i, c := range g["glob"] {
		re, err := GlobToRegExp(str(c["glob"]))
		if err != nil {
			t.Fatal(err)
		}
		got := []bool{}
		for _, s := range samples {
			got = append(got, re.MatchString(s))
		}
		check("glob", i, c["out"], got)
	}
	for i, c := range g["wrap"] {
		check("wrap", i, c["out"], WrapUntrusted(str(c["p"]), str(c["t"])))
	}
	t.Logf("golden parity: %d/%d match", total-fail, total)
	if total < 100 {
		t.Fatalf("too few golden cases: %d", total)
	}
}
