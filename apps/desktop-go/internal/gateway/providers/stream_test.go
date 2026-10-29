package providers

import (
	"io"
	"net/http"
	"strings"
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type chunks struct{ c [][]byte }

func (c *chunks) Read(p []byte) (int, error) {
	if len(c.c) == 0 {
		return 0, io.EOF
	}
	n := copy(p, c.c[0])
	c.c = c.c[1:]
	return n, nil
}
func (c *chunks) Close() error { return nil }

func TestTextDecoderWHATWG(t *testing.T) {
	var d u.TextDecoder
	got := d.Decode([]byte{0xEF, 0xBB, 0xBF, 'a', 0xE2, 0x82}) + d.Decode([]byte{0xAC, 0xE2, 0x82, 'b', 0xFF}) + d.Decode([]byte{0xF0, 0x9F}) + d.Flush()
	if want := "a€\uFFFDb\uFFFD\uFFFD"; got != want {
		t.Fatalf("%q != %q", got, want)
	}
}

func TestStagedPassThrough(t *testing.T) {
	sp := &Spec{}
	up := &http.Response{StatusCode: 200, Body: &chunks{[][]byte{[]byte("data: 1\n\n"), []byte("data: 2\n\n")}}}
	var raw strings.Builder
	r := StagedResponse(up, NewStage(sp, "chat"), func(s string) { raw.WriteString(s) })
	b, _ := io.ReadAll(r.Body)
	if string(b) != "data: 1\n\ndata: 2\n\n" || raw.String() != string(b) {
		t.Fatalf("%q %q", b, raw.String())
	}
}
