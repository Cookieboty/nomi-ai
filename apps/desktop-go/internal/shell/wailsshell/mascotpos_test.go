package wailsshell

import "testing"

func TestMascotInitialPos204(t *testing.T) {
	saved := func(x, y int) func() (int, int) { return func() (int, int) { return x, y } }
	for _, c := range []struct {
		saved        func() (int, int)
		wantX, wantY int
	}{
		{nil, 1024 - 330, 720 - 355},
		{saved(0, 0), 1024 - 330, 720 - 355},
		{saved(5000, 100), 1024 - 330, 720 - 355},
		{saved(200, 150), 200, 150},
	} {
		p := mascotInitialPos(c.saved, 1024, 720, 330, 355)
		if p[0] != c.wantX || p[1] != c.wantY {
			t.Fatalf("got %v want %d,%d", *p, c.wantX, c.wantY)
		}
	}
}
