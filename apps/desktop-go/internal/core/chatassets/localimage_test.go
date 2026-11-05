package chatassets

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 1×1 PNG
var pngBytes = []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 0x0d, 'I', 'H', 'D', 'R', 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89}

func TestLocalImage(t *testing.T) {
	ws := t.TempDir()
	real, _ := filepath.EvalSymlinks(ws)
	_ = os.MkdirAll(filepath.Join(ws, "sub"), 0o755)
	qr := filepath.Join(ws, "sub", "auth-qr.png")
	if err := os.WriteFile(qr, pngBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	fake := filepath.Join(ws, "secret.png")
	_ = os.WriteFile(fake, []byte("-----BEGIN OPENSSH PRIVATE KEY-----"), 0o600)
	only := func(dir string) bool { return dir == real }
	none := func(string) bool { return false }

	got, err := LocalImage(qr, only)
	if err != nil || !strings.HasPrefix(got, "data:image/png;base64,") {
		t.Fatalf("workspace image: %q %v", got, err)
	}
	// file URL：unix 是 file:///Users/…，Windows 是 file:///C:/…
	fileURL := filepath.ToSlash(qr)
	if !strings.HasPrefix(fileURL, "/") {
		fileURL = "/" + fileURL
	}
	if _, err := LocalImage("file://"+fileURL, only); err != nil {
		t.Fatalf("file:// url: %v", err)
	}
	if _, err := LocalImage(fake, only); err == nil {
		t.Fatal("non-image content with .png extension must be refused")
	}
	if _, err := LocalImage("sub/auth-qr.png", only); err == nil {
		t.Fatal("relative path must be refused")
	}
	if _, err := LocalImage(filepath.Join(ws, "sub", "x.txt"), only); err == nil {
		t.Fatal("non-image extension must be refused")
	}
	// 临时目录总是允许（t.TempDir 在系统临时目录里）
	if _, err := LocalImage(qr, none); err != nil {
		t.Fatalf("temp dir image should be allowed: %v", err)
	}
	if !localImageAllowed(real, only) || localImageAllowed("/etc", none) {
		t.Fatal("allowed roots")
	}
}

func TestLocalImagePathWindowsFileURL(t *testing.T) {
	if p, ok := LocalImagePath("file:///C:/Users/me/qr.png"); filepath.Separator == '\\' {
		if !ok || p != `C:\Users\me\qr.png` {
			t.Fatalf("got %q %v", p, ok)
		}
	} else if ok {
		// 非 Windows：C:/… 不是绝对路径
		t.Fatalf("unexpected %q", p)
	}
	if _, ok := LocalImagePath("file://evil.example/x.png"); ok {
		t.Fatal("remote host must be refused")
	}
}
