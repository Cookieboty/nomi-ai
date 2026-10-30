package gateway_test

import (
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var parityConv = stream.ConvertOptions{Model: "fallback", CustomTools: map[string]bool{"apply_patch": true}}

func cmpChunks(t *testing.T, name, what string, want, got []string) bool {
	if len(want) != len(got) {
		t.Errorf("%s %s: chunk count node=%d go=%d\n%s", name, what, len(want), len(got),
			firstDiff(normalize(strings.Join(want, "")), normalize(strings.Join(got, ""))))
		return false
	}
	for i := range want {
		if a, b := normalize(want[i]), normalize(got[i]); a != b {
			t.Errorf("%s %s chunk %d: %s", name, what, i, firstDiff(a, b))
			return false
		}
	}
	return true
}

func TestParityStream(t *testing.T) {
	var fx struct {
		Cases []struct {
			Name, From, To, Input, Half string
			InChunks                    []string `json:"inChunks"`
			Whole, Split7, FailHalf     []string
		}
	}
	loadFixture(t, "stream", &fx)
	tl := tally{}
	for _, c := range fx.Cases {
		w := stream.CreateStreamConverter(c.From, c.To, parityConv)
		whole := []string{w.Push(c.Input), w.End()}
		s := stream.CreateStreamConverter(c.From, c.To, parityConv)
		var split []string
		for _, p := range c.InChunks {
			split = append(split, s.Push(p))
		}
		split = append(split, s.End())
		f := stream.CreateStreamConverter(c.From, c.To, parityConv)
		failed := []string{f.Push(c.Half), f.Fail("socket hang up")}
		ok := cmpChunks(t, c.Name, "whole", c.Whole, whole)
		ok = cmpChunks(t, c.Name, "split7", c.Split7, split) && ok
		ok = cmpChunks(t, c.Name, "failHalf", c.FailHalf, failed) && ok
		tl.add(c.From+"→"+c.To, ok)
	}
	tl.report(t, "stream")
}

func TestParityJson(t *testing.T) {
	var fx struct {
		Cases []struct {
			Name, From, To, Input, Sse string
			Json                       struct {
				Ok     bool
				Status float64
				Body   string
			}
		}
	}
	loadFixture(t, "json", &fx)
	tl := tally{}
	for _, c := range fx.Cases {
		b1, _ := u.ParseString(c.Input)
		b2, _ := u.ParseString(c.Input)
		ok := true
		if a, g := normalize(c.Sse), normalize(stream.JsonToSse(c.From, c.To, b1, parityConv)); a != g {
			t.Errorf("%s sse: %s", c.Name, firstDiff(a, g))
			ok = false
		}
		r := stream.JsonToJson(c.From, c.To, b2, parityConv)
		if r.OK != c.Json.Ok || r.Status != c.Json.Status {
			t.Errorf("%s json: ok/status node=%v/%v go=%v/%v", c.Name, c.Json.Ok, c.Json.Status, r.OK, r.Status)
			ok = false
		}
		if a, g := normalize(c.Json.Body), normalize(u.Stringify(r.Body)); a != g {
			t.Errorf("%s json body: %s", c.Name, firstDiff(a, g))
			ok = false
		}
		tl.add(c.From+"→"+c.To, ok)
	}
	tl.report(t, "json")
}
