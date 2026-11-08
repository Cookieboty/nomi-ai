package outcap

import (
	"strings"
	"testing"
)

func TestBufKeepsHeadAndTail(t *testing.T) {
	b := New(100)
	b.Add("BEGIN")
	for i := 0; i < 50; i++ {
		b.Add(strings.Repeat("x", 20))
	}
	b.Add("FAILED: TestFoo")
	s := b.String()
	if !b.Truncated || !strings.HasPrefix(s, "BEGIN") || !strings.HasSuffix(s, "FAILED: TestFoo") || !strings.Contains(s, "中间省略") {
		t.Fatal(s)
	}
	// 没超：原样
	c := New(100)
	c.Add("hello ")
	c.Add("世界")
	if c.Truncated || c.String() != "hello 世界" {
		t.Fatal(c.String())
	}
}
