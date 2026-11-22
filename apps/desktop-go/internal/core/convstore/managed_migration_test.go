package convstore

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

func TestManagedMigrationIsDeterministicLosslessIdempotentWithAttachments(t *testing.T) {
	requireManagedDurability(t)
	var ids []string
	for copyIndex := 0; copyIndex < 2; copyIndex++ {
		dir := t.TempDir()
		s := New(dir)
		legacy := []json.RawMessage{
			raw(`{"id":"keep","role":"user","content":"first","images":[{"id":"asset","data":"unchanged"}],"unknown":{"n":9007199254740993}}`),
			raw(`{"id":"keep","role":"assistant","content":"duplicate id, distinct body","trace":{"preserve":"but do not hand off"}}`),
			raw(`{"role":"user","content":"missing id","attachments":["file:kept"]}`),
		}
		mustPut(t, s, `{"id":"c","name":"original","extra":{"provider":"api","foreign":true}}`, legacy)
		source, err := os.ReadFile(s.msgPath("c"))
		if err != nil {
			t.Fatal(err)
		}
		report, err := s.AdoptManaged("c")
		if err != nil {
			t.Fatal(err)
		}
		if len(report.Mappings) != 2 || !bytes.Equal(report.Archive.Messages, source) {
			t.Fatal("mapping or exact source archive lost")
		}
		d, err := s.ReadManaged("c")
		if err != nil {
			t.Fatal(err)
		}
		if len(d.State.History) != 3 || len(d.State.History[0].Attachments) == 0 || len(d.State.History[2].Attachments) == 0 {
			t.Fatal("attachments silently discarded")
		}
		current := []string{}
		for _, e := range d.State.History {
			current = append(current, e.ID)
		}
		if copyIndex == 0 {
			ids = current
		} else if !reflect.DeepEqual(ids, current) {
			t.Fatal("migration IDs depend on machine/time/path")
		}
		projected, err := s.Messages("c", 0)
		if err != nil {
			t.Fatal(err)
		}
		for i, payload := range projected {
			var a, b map[string]json.RawMessage
			_ = json.Unmarshal(payload, &a)
			_ = json.Unmarshal(legacy[i], &b)
			delete(a, "id")
			delete(b, "id")
			if !reflect.DeepEqual(a, b) {
				t.Fatal("old API fields lost or numeric precision changed")
			}
		}
		again, err := s.AdoptManaged("c")
		if err != nil || !again.Already || !reflect.DeepEqual(report.Mappings, again.Mappings) {
			t.Fatal("migration retry changed IDs/report")
		}
		last, _ := s.ReadManaged("c")
		if last.Checksum != d.Checksum || last.Sequence != 1 {
			t.Fatal("idempotent adoption rewrote committed authority")
		}
		untouched, _ := os.ReadFile(s.msgPath("c"))
		if !bytes.Equal(source, untouched) {
			t.Fatal("migration modified original source")
		}
	}
}

func TestManagedMalformedAndPartialImportsBlockRatherThanTruncate(t *testing.T) {
	requireManagedDurability(t)
	for _, mode := range []string{"malformed", "unknown-role", "nontext", "invalid-utf8", "partial-import"} {
		t.Run(mode, func(t *testing.T) {
			s := New(t.TempDir())
			mustPut(t, s, `{"id":"c"}`, msgs(`{"id":"m","role":"user","content":"valid"}`))
			original, _ := os.ReadFile(s.msgPath("c"))
			switch mode {
			case "malformed":
				original = append(original, []byte(`{"torn":`)...)
			case "unknown-role":
				original = append(original, []byte("{\"id\":\"tool\",\"role\":\"tool\",\"content\":\"retain\"}\n")...)
			case "nontext":
				original = append(original, []byte("{\"id\":\"x\",\"role\":\"user\",\"content\":[{\"image\":\"kept\"}]}\n")...)
			case "invalid-utf8":
				original = append(original, []byte{'{', '"', 'r', 'o', 'l', 'e', '"', ':', '"', 0xff, '"', '}'}...)
			case "partial-import":
				if err := os.WriteFile(s.msgPath("c")+importSuffix, []byte("pending exact bytes"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(s.msgPath("c"), original, 0600); err != nil {
				t.Fatal(err)
			}
			report, err := s.AdoptManaged("c")
			if !errors.Is(err, ErrMigrationBlocked) || len(report.Issues) == 0 {
				t.Fatalf("bad input silently adopted: %v", err)
			}
			if !bytes.Equal(report.Archive.Messages, original) {
				t.Fatal("malformed original bytes not recoverable")
			}
			actual, _ := os.ReadFile(s.msgPath("c"))
			if !bytes.Equal(original, actual) {
				t.Fatal("blocked migration damaged source")
			}
			if _, err = os.Stat(s.managedPath("c")); !os.IsNotExist(err) {
				t.Fatal("partial authority published")
			}
		})
	}
}

func TestManagedUnfinishedTempIsIgnoredAndSafeMigrationCanRetry(t *testing.T) {
	requireManagedDurability(t)
	s := New(t.TempDir())
	mustPut(t, s, `{"id":"c"}`, msgs(`{"id":"m","role":"user","content":"valid"}`))
	dir := filepath.Join(s.dir, "managed-v2")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".managed-tmp-crashed"), []byte(`{"torn"`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AdoptManaged("c"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadManaged("c"); err != nil {
		t.Fatal(err)
	}
	// Not ours to remove: startup ignores and preserves orphan evidence.
	if _, err := os.Stat(filepath.Join(dir, ".managed-tmp-crashed")); err != nil {
		t.Fatal("startup deleted unrelated crash evidence")
	}
}

func TestManagedEditedRevisionsAndInterruptedSwitchAreRecoverable(t *testing.T) {
	dir, s, lease, c, f := diskFixture(t)
	startDisk(t, c)
	completeDisk(t, c, f.call(t, 0))
	if err := c.Edit("old", "edited authoritative text"); err != nil {
		t.Fatal(err)
	}
	d, err := s.ReadManaged("c")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.State.History) != 4 || d.State.Bindings[0].Status != cr.StatusStale {
		t.Fatal("edit did not atomically stale old native coverage")
	}
	d.State.PendingSwitch = &cr.SwitchState{Phase: "preparing-target", From: d.State.Selected, To: d.State.Selected}
	if err = lease.Commit(d.State); err != nil {
		t.Fatal(err)
	}
	_ = lease.Close()
	l2, err := New(dir).OpenManaged("c")
	if err != nil {
		t.Fatal(err)
	}
	defer l2.Close()
	recovered, err := l2.Session()
	if err != nil {
		t.Fatal(err)
	}
	if recovered.State().Phase != cr.PhaseUncertain || recovered.Checkpoint().PendingSwitch == nil {
		t.Fatal("interrupted switch silently completed")
	}
	if err = recovered.Select(diskTarget(f)); !errors.Is(err, cr.ErrBusy) {
		t.Fatal("unresolved switch admitted more work")
	}
	if recovered.Messages()[0].Revision != 2 || recovered.Messages()[0].Text != "edited authoritative text" {
		t.Fatal("restore reset revisions/order")
	}
	final, err := s.ReadManaged("c")
	if err != nil || len(final.State.History) != 4 {
		t.Fatal("old audit revisions lost during restart")
	}
}

func TestManagedLargeLegacyHistoryNeverUsesHandoffClippingAsMigrationLimit(t *testing.T) {
	requireManagedDurability(t)
	s := New(t.TempDir())
	history := []json.RawMessage{}
	for i := 0; i < 320; i++ {
		history = append(history, raw(fmt.Sprintf(`{"id":"m%d","role":"user","content":"line %d 文本😀","timestamp":%d}`, i, i, i)))
	}
	mustPut(t, s, `{"id":"large","name":"retained"}`, history)
	if _, err := s.AdoptManaged("large"); err != nil {
		t.Fatal(err)
	}
	d, err := s.ReadManaged("large")
	if err != nil || len(d.State.History) != 320 {
		t.Fatal("migration clipped old messages")
	}
	all, err := s.Messages("large", 0)
	if err != nil || len(all) != 320 {
		t.Fatal("API projection clipped authoritative history")
	}
	tail, err := s.Messages("large", 3)
	if err != nil || len(tail) != 3 || !bytes.Contains(tail[0], []byte(`"m317"`)) {
		t.Fatal("API tail limit changed order")
	}
}
