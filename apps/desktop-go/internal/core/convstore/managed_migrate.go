package convstore

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"unicode/utf8"

	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

var ErrMigrationBlocked = errors.New("legacy migration needs review; source bytes preserved, no authority published")

type MigrationIssue struct {
	Line   int
	Reason string
}
type IDMapping struct {
	Line     int
	Old, New string
}
type MigrationReport struct {
	Already  bool
	Issues   []MigrationIssue
	Mappings []IDMapping
	Archive  LegacyArchive
}

// AdoptManaged is an explicit opt-in, NOT called by application wiring. All
// current callers are fixtures. It never deletes/rewrites legacy source files.
// Bad/unknown rows or partial imports BLOCK adoption rather than disappearing.
func (s *Store) AdoptManaged(id string) (MigrationReport, error) {
	report := MigrationReport{}
	if !ValidID(id) {
		return report, ErrBadID
	}
	unlock, err := lockPath(filepath.Join(s.dir, "managed-v2", id+".lock"))
	if err != nil {
		return report, err
	}
	defer unlock()
	done, err := s.lockStore()
	if err != nil {
		return report, err
	}
	defer done()
	if d, err := readManaged(s.managedPath(id)); err == nil {
		if d.Deleted {
			return report, ErrNotFound
		}
		report.Already = true
		report.Archive = d.Legacy
		report.Mappings = append([]IDMapping(nil), d.Mappings...)
		return report, nil
	} else if !os.IsNotExist(err) {
		return report, err
	}
	report.Archive.Index, err = readLegacySource(filepath.Join(s.dir, indexFile))
	if err != nil {
		return report, err
	}
	report.Archive.Messages, err = readLegacySource(s.msgPath(id))
	if err != nil {
		return report, err
	}
	report.Archive.Staging, err = readLegacySource(s.msgPath(id) + importSuffix)
	if err != nil {
		return report, err
	}
	if len(report.Archive.Staging) > 0 {
		report.Issues = append(report.Issues, MigrationIssue{Reason: "unfinished legacy import; never promote a partial file"})
	}
	if err = s.load(); err != nil {
		return report, err
	}
	i, ok := s.pos[id]
	if !ok {
		return report, ErrNotFound
	}
	report.Archive.Meta = append([]byte(nil), s.doc.Conversations[i].Meta...)
	sum := sha256.Sum256(append(append([]byte(nil), report.Archive.Meta...), report.Archive.Messages...))
	report.Archive.SourceDigest = hex.EncodeToString(sum[:])
	rows := bytes.Split(report.Archive.Messages, []byte{'\n'})
	entries := []cr.Entry{}
	seen := map[string]bool{}
	for index, line := range rows {
		row := bytes.TrimSpace(line)
		if len(row) == 0 {
			continue
		}
		if len(line) > maxLineBytes || !utf8.Valid(row) || !json.Valid(row) || row[0] != '{' {
			report.Issues = append(report.Issues, MigrationIssue{index + 1, "malformed/oversized/non-UTF8 row (not skipped)"})
			continue
		}
		var obj map[string]json.RawMessage
		_ = json.Unmarshal(row, &obj)
		var mid, role, text, turn string
		_ = json.Unmarshal(obj["id"], &mid)
		_ = json.Unmarshal(obj["role"], &role)
		_ = json.Unmarshal(obj["turnId"], &turn)
		if (role != "user" && role != "assistant") || json.Unmarshal(obj["content"], &text) != nil {
			report.Issues = append(report.Issues, MigrationIssue{index + 1, "unsupported role/content; raw bytes retained"})
			continue
		}
		old := mid
		if mid == "" || seen[mid] {
			hash := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%s", id, index, row)))
			mid = "legacy_" + hex.EncodeToString(hash[:16])
			for seen[mid] {
				mid += "_"
			}
			report.Mappings = append(report.Mappings, IDMapping{index + 1, old, mid})
		}
		seen[mid] = true
		if turn == "" {
			turn = "legacy_turn_" + mid
		}
		e := cr.Entry{ID: mid, TurnID: turn, Role: role, Text: text, Origin: "legacy-api", Raw: append([]byte(nil), line...)}
		for _, key := range []string{"attachments", "images", "files", "imageIds"} {
			v := bytes.TrimSpace(obj[key])
			if len(v) > 0 && !bytes.Equal(v, []byte("null")) && !bytes.Equal(v, []byte("[]")) && !bytes.Equal(v, []byte("{}")) {
				e.Attachments = append(e.Attachments, "legacy:"+key)
			}
		}
		entries = append(entries, e)
	}
	if len(entries) < s.doc.Conversations[i].Count {
		report.Issues = append(report.Issues, MigrationIssue{Reason: "source shorter than indexed history; missing rows require explicit review"})
	}
	if len(report.Issues) > 0 {
		return report, ErrMigrationBlocked
	}
	session, err := cr.NewSession(id, entries)
	if err != nil {
		return report, err
	}
	d := ManagedDocument{Version: managedVersion, Sequence: 1, Meta: report.Archive.Meta, State: session.Checkpoint(), Legacy: report.Archive, Mappings: report.Mappings}
	d.Checksum = documentSum(d)
	payload, err := json.Marshal(d)
	if err != nil {
		return report, err
	}
	return report, atomicManaged(s.managedPath(id), payload, defaultManagedIO())
}
func readLegacySource(path string) ([]byte, error) {
	b, err := readRegularBounded(path, 64<<20)
	if os.IsNotExist(err) {
		return nil, nil
	}
	return b, err
}

// A bounded read never silently truncates: reject symlinks/devices/oversize
// sources before allocation; retain the original file for explicit review.
func readRegularBounded(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, fmt.Errorf("%w: nonregular/oversize source %s", ErrMigrationBlocked, filepath.Base(path))
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	actual, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(info, actual) {
		return nil, fmt.Errorf("%w: source changed", ErrMigrationBlocked)
	}
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("%w: source grew beyond bound", ErrMigrationBlocked)
	}
	return b, nil
}
