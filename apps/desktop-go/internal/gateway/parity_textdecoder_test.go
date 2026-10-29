package gateway_test

import (
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestParityTextDecoder(t *testing.T) {
	var cases []struct {
		Raw [][]int  `json:"chunks"`
		Out []string `json:"out"`
	}
	loadFixture(t, "textdecoder", &cases)
	tl := tally{}
	for i, c := range cases {
		var d u.TextDecoder
		var got []string
		for _, ch := range c.Raw {
			b := make([]byte, len(ch))
			for j, x := range ch {
				b[j] = byte(x)
			}
			got = append(got, d.Decode(b))
		}
		got = append(got, d.Flush())
		ok := eqStrs(got, c.Out)
		if !ok {
			t.Logf("case %d: %q != %q", i, got, c.Out)
		}
		tl.add("streamed", ok)
	}
	tl.report(t, "textdecoder")
}
