package i18n

import "testing"

func TestSpaceAround(t *testing.T) {
	cases := [][3]string{
		{"打开Ab", "Ab", "打开 Ab"},
		{"Ab已就绪", "Ab", "Ab 已就绪"},
		{"打开小纸", "小纸", "打开小纸"},
		{"，Ab和", "Ab", "，Ab 和"},
		{"打开 Ab（", "Ab", "打开 Ab（"},
		{"Ab motions", "Ab", "Ab motions"},
		{"Ab和Ab", "Ab", "Ab 和 Ab"},
		{"no word", "Ab", "no word"},
	}
	for _, c := range cases {
		if got := SpaceAround(c[0], c[1]); got != c[2] {
			t.Errorf("SpaceAround(%q,%q) = %q, want %q", c[0], c[1], got, c[2])
		}
	}
}
