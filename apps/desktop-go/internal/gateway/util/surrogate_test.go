package util

import "testing"

// Expectations recorded from Node: JSON.stringify(s.slice(n)) / s.slice(0,n), .length
func TestLoneSurrogateSlices(t *testing.T) {
	cases := []struct {
		s    string
		n    int
		out  string
		ulen int
	}{
		{"a😀b", -2, `"\ude00b"`, 2},
		{"a😀b", -3, `"😀b"`, 3},
		{"😀😀", -1, `"\ude00"`, 1},
		{"x😀", 1, `"x"`, 1},
		{"x😀", 2, `"x\ud83d"`, 2},
		{"x😀", 3, `"x😀"`, 3},
		{"é😀", -1, `"\ude00"`, 1},
	}
	for _, c := range cases {
		var got string
		if c.n < 0 {
			got = UTF16Tail(c.s, -c.n)
		} else {
			got = UTF16Slice0(c.s, c.n)
		}
		if o := Stringify(got); o != c.out || UTF16Len(got) != c.ulen {
			t.Errorf("%q %d: got %s len %d want %s len %d", c.s, c.n, o, UTF16Len(got), c.out, c.ulen)
		}
	}
	// a lone surrogate followed by more text keeps the tail semantics
	if g := UTF16Tail(UTF16Tail("😀", 1)+"ab", 3); Stringify(g) != `"\ude00ab"` {
		t.Errorf("re-tail: %s", Stringify(g))
	}
}

// JSON.parse keeps lone-surrogate escapes; JSON.stringify writes them back.
func TestLoneSurrogateRoundTrip(t *testing.T) {
	for in, want := range map[string]string{
		`["\ud83d"]`:                   `["\ud83d"]`,
		`{"a\uDE00":"x\ud83d\ude00y"}`: `{"a\ude00":"x😀y"}`,
		`["\ud83dz\\ud83d"]`:           `["\ud83dz\\ud83d"]`,
		`["\u00e9\n"]`:                 `["é\n"]`,
	} {
		v, err := ParseString(in)
		if err != nil || Stringify(v) != want {
			t.Errorf("%s: got %s %v want %s", in, Stringify(v), err, want)
		}
	}
}
