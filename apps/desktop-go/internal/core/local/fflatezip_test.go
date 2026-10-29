package local

import (
	"archive/zip"
	"bytes"
	"io"
	"testing"
	"time"
)

func TestFflateZipLayout(t *testing.T) {
	now := func() time.Time { return time.Date(2026, 10, 29, 14, 30, 42, 0, time.Local) }
	in := []zipEntry{{"z.json", []byte("{}")}, {"a/记忆.md", bytes.Repeat([]byte("hi "), 100)}, {"README.txt", []byte("x")}}
	b, err := fflateZipSync(in, now)
	if err != nil {
		t.Fatal(err)
	}
	r, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	for i, f := range r.File {
		if f.Name != in[i].name || f.CreatorVersion != 20 || f.ReaderVersion != 20 || f.ExternalAttrs != 0 || len(f.Extra) != 0 || f.Flags&8 != 0 {
			t.Fatalf("entry %d header %+v", i, f.FileHeader)
		}
		if (f.Flags&0x800 != 0) != (i == 1) {
			t.Fatalf("utf8 flag %d", i)
		}
		if f.ModifiedTime != uint16(14<<11|30<<5|21) {
			t.Fatalf("dos time %x", f.ModifiedTime)
		}
		rc, _ := f.Open()
		got, _ := io.ReadAll(rc)
		if !bytes.Equal(got, in[i].data) {
			t.Fatal("content")
		}
	}
}
