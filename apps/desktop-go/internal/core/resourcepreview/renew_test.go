package resourcepreview

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func withClock(s *Service) *time.Time {
	now := time.Now()
	s.clock = func() time.Time { return now }
	return &now
}

func TestRenewAfterExpiryIssuesNewCapabilityWithoutExtendingTheOldOne(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "note.md")
	original := "hello\n"
	if err := os.WriteFile(path, []byte(original), 0o640); err != nil {
		t.Fatal(err)
	}
	s := New()
	now := withClock(s)
	opened := s.Open(root, path, "/nonexistent-home", false)
	if !opened.Editable || opened.URL == "" {
		t.Fatalf("open %+v", opened)
	}
	*now = now.Add(ttl + time.Second)
	if saved := s.Save(opened.URL, opened.Revision, "draft"); saved.Code != "expired" {
		t.Fatalf("expired save %+v", saved)
	}
	if b, _ := os.ReadFile(path); string(b) != original {
		t.Fatalf("expired save wrote %q", b)
	}
	renewed := s.Renew(opened.URL)
	if !renewed.OK || !renewed.Editable || renewed.URL == "" || renewed.URL == opened.URL {
		t.Fatalf("renew %+v", renewed)
	}
	if renewed.Content != original || renewed.Revision != opened.Revision || renewed.Path != opened.Path {
		t.Fatalf("renewed identity %+v", renewed)
	}
	draft := "hello draft\n"
	saved := s.Save(renewed.URL, renewed.Revision, draft)
	if !saved.OK || saved.Revision != revisionOf(draft) {
		t.Fatalf("save via new capability %+v", saved)
	}
	if b, _ := os.ReadFile(path); string(b) != draft {
		t.Fatalf("disk %q", b)
	}
	// The expired grant was swept when the new one was issued. Retrying it must not write.
	if again := s.Save(opened.URL, opened.Revision, "nope"); again.OK || again.Code == "" {
		t.Fatalf("old capability still writable %+v", again)
	}
	if b, _ := os.ReadFile(path); string(b) != draft {
		t.Fatalf("old capability clobbered %q", b)
	}
}

func expiredEditable(t *testing.T, body string) (*Service, string, Result) {
	t.Helper()
	root := t.TempDir()
	path := filepath.Join(root, "note.md")
	if err := os.WriteFile(path, []byte(body), 0o640); err != nil {
		t.Fatal(err)
	}
	s := New()
	now := withClock(s)
	opened := s.Open(root, path, "/nonexistent-home", false)
	if !opened.Editable {
		t.Fatalf("open %+v", opened)
	}
	*now = now.Add(ttl + time.Second)
	return s, path, opened
}

func TestRenewRefusesExternalEditReplacementAndRevokedAccess(t *testing.T) {
	const original = "hello\n"

	t.Run("external edit", func(t *testing.T) {
		s, path, opened := expiredEditable(t, original)
		if err := os.WriteFile(path, []byte("external\n"), 0o640); err != nil {
			t.Fatal(err)
		}
		if renewed := s.Renew(opened.URL); renewed.OK || renewed.Code != "conflict" || renewed.URL != "" {
			t.Fatalf("renew %+v", renewed)
		}
		if b, _ := os.ReadFile(path); string(b) != "external\n" {
			t.Fatalf("disk %q", b)
		}
	})

	t.Run("replaced inode", func(t *testing.T) {
		s, path, opened := expiredEditable(t, original)
		// Keep the original inode allocated so the replacement cannot reuse it.
		held, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = held.Close() })
		if err = os.Remove(path); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, []byte(original), 0o640); err != nil {
			t.Fatal(err)
		}
		if renewed := s.Renew(opened.URL); renewed.OK || renewed.Code != "conflict" || renewed.URL != "" {
			t.Fatalf("renew %+v", renewed)
		}
		if b, _ := os.ReadFile(path); string(b) != original {
			t.Fatalf("disk %q", b)
		}
	})

	t.Run("symlink", func(t *testing.T) {
		s, path, opened := expiredEditable(t, original)
		other := filepath.Join(t.TempDir(), "other.md")
		if err := os.WriteFile(other, []byte(original), 0o640); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(other, path); err != nil {
			t.Skip(err)
		}
		if renewed := s.Renew(opened.URL); renewed.OK || renewed.Code != "denied" || renewed.URL != "" {
			t.Fatalf("renew %+v", renewed)
		}
		if b, _ := os.ReadFile(other); string(b) != original {
			t.Fatalf("symlink target %q", b)
		}
	})

	t.Run("protected", func(t *testing.T) {
		s, path, opened := expiredEditable(t, original)
		root := filepath.Dir(path)
		s.ProtectedPaths = func() []string { return []string{root} }
		if renewed := s.Renew(opened.URL); renewed.OK || renewed.Code != "denied" {
			t.Fatalf("renew %+v", renewed)
		}
		if saved := s.Save(opened.URL, opened.Revision, "overwrite"); saved.OK || (saved.Code != "expired" && saved.Code != "denied") {
			t.Fatalf("save %+v", saved)
		}
		if b, _ := os.ReadFile(path); string(b) != original {
			t.Fatalf("disk %q", b)
		}
	})

	if runtime.GOOS == "windows" {
		return
	}
	t.Run("readonly", func(t *testing.T) {
		s, path, opened := expiredEditable(t, original)
		if err := os.Chmod(path, 0o444); err != nil {
			t.Fatal(err)
		}
		if renewed := s.Renew(opened.URL); renewed.OK || renewed.Code != "readonly" || renewed.URL != "" {
			t.Fatalf("renew %+v", renewed)
		}
		if b, _ := os.ReadFile(path); string(b) != original {
			t.Fatalf("disk %q", b)
		}
	})
}

func TestRenewMissingGrantDoesNotInventACapability(t *testing.T) {
	s := New()
	if renewed := s.Renew(Prefix + "gone"); renewed.OK || renewed.Code != "expired" || renewed.URL != "" {
		t.Fatalf("renew %+v", renewed)
	}
	root := t.TempDir()
	path := filepath.Join(root, "note.md")
	if err := os.WriteFile(path, []byte("x"), 0o640); err != nil {
		t.Fatal(err)
	}
	opened := s.Open(root, path, "/nonexistent-home", false)
	s.Close(opened.URL)
	if renewed := s.Renew(opened.URL); renewed.Code != "expired" {
		t.Fatalf("closed %+v", renewed)
	}
}
