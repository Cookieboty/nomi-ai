package wailsshell

import (
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
)

func TestProfileInstanceAndWebview(t *testing.T) {
	t.Setenv("NOMI_POC_CTL", "")
	wantID, wantWebview := "com.cookieboty.nomi", ""
	if hostports.Development {
		root := t.TempDir()
		t.Setenv("NOMI_DEV_USER_DATA", root)
		wantID, wantWebview = "com.cookieboty.nomi.dev", filepath.Join(root, "webview")
	}
	if got := singleInstanceID(); got != wantID {
		t.Fatalf("instance = %q", got)
	}
	if got := windowsOptions().WebviewUserDataPath; got != wantWebview {
		t.Fatalf("webview = %q", got)
	}
	t.Setenv("NOMI_POC_CTL", "127.0.0.1:12345")
	if got := singleInstanceID(); got != wantID+".ctl" {
		t.Fatalf("control instance = %q", got)
	}
}
