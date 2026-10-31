package updates

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

// ReleaseNotesURL：某个版本自己的 latest-go.json（update-manifest.py 把 docs/releases/vX.Y.Z.md 写进 releaseNotes）
const ReleaseNotesURL = "https://github.com/Cookieboty/nomi-ai/releases/download/v%s/latest-go.json"

// 缓存最近几个版本的说明：升级后「更新日志」离线也能打开
const notesCacheMax = 5

var semverRe = regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`)

// NotesResult = updates.releaseNotes 的返回
type NotesResult struct {
	Version     string  `json:"version"`
	Notes       *string `json:"notes"`
	ReleaseDate *string `json:"releaseDate,omitempty"`
}

type notesEntry struct {
	Notes       string `json:"notes"`
	ReleaseDate string `json:"releaseDate,omitempty"`
	SavedAt     int64  `json:"savedAt"`
}

type notesCache struct {
	Version int                   `json:"version"`
	Entries map[string]notesEntry `json:"entries"`
}

// Notes：按版本号取更新说明——先读 <userData>/release-notes.json，没有再取该版本的 latest-go.json 并缓存。
// 与 Node 版 services/ReleaseNotes.ts 同一份缓存格式。
type Notes struct {
	Version func() string
	// UserData：缓存目录；"" = 不缓存
	UserData string
	// URL：nil = ReleaseNotesURL
	URL    func(version string) string
	Client *http.Client
	Log    Logger
	Now    func() time.Time

	mu sync.Mutex
}

func (n *Notes) file() string {
	if n.UserData == "" {
		return ""
	}
	return filepath.Join(n.UserData, "release-notes.json")
}

func (n *Notes) load() notesCache {
	c := notesCache{Version: 1, Entries: map[string]notesEntry{}}
	f := n.file()
	if f == "" {
		return c
	}
	b, err := os.ReadFile(f)
	if err != nil {
		return c
	}
	var got notesCache
	if json.Unmarshal(b, &got) == nil && got.Entries != nil {
		c.Entries = got.Entries
	}
	return c
}

func (n *Notes) save(c notesCache) {
	f := n.file()
	if f == "" {
		return
	}
	// 只留最近保存的几个版本
	if len(c.Entries) > notesCacheMax {
		keys := make([]string, 0, len(c.Entries))
		for k := range c.Entries {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return c.Entries[keys[i]].SavedAt > c.Entries[keys[j]].SavedAt })
		for _, k := range keys[notesCacheMax:] {
			delete(c.Entries, k)
		}
	}
	b, err := json.Marshal(c)
	if err == nil {
		err = os.MkdirAll(filepath.Dir(f), 0o755)
	}
	if err == nil {
		err = utils.WritePrivateFileAtomic(f, b)
	}
	if err != nil && n.Log != nil {
		n.Log.Warn("[updater] release notes cache write failed", "error", err.Error())
	}
}

func (n *Notes) fetch(version string) (*notesEntry, error) {
	url := fmt.Sprintf(ReleaseNotesURL, version)
	if n.URL != nil {
		url = n.URL(version)
	}
	client := n.Client
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	res, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HttpError: %d %s", res.StatusCode, http.StatusText(res.StatusCode))
	}
	var m struct {
		Version      string `json:"version"`
		ReleaseDate  string `json:"releaseDate"`
		ReleaseNotes string `json:"releaseNotes"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&m); err != nil {
		return nil, fmt.Errorf("invalid latest-go.json: %w", err)
	}
	if m.ReleaseNotes == "" || m.Version != version {
		return nil, nil
	}
	return &notesEntry{Notes: m.ReleaseNotes, ReleaseDate: m.ReleaseDate}, nil
}

// Get：version 为空取当前版本；取不到（开发版、旧版本清单没有说明、离线）时 Notes 为 nil
func (n *Notes) Get(version string) NotesResult {
	if version == "" && n.Version != nil {
		version = n.Version()
	}
	out := NotesResult{Version: version}
	if !semverRe.MatchString(version) {
		return out
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	c := n.load()
	if e, ok := c.Entries[version]; ok && e.Notes != "" {
		return withEntry(out, e)
	}
	e, err := n.fetch(version)
	if err != nil {
		if n.Log != nil {
			n.Log.Warn("[updater] release notes fetch failed", "version", version, "error", err.Error())
		}
		return out
	}
	if e == nil {
		return out
	}
	now := time.Now
	if n.Now != nil {
		now = n.Now
	}
	e.SavedAt = now().UnixMilli()
	c.Entries[version] = *e
	n.save(c)
	return withEntry(out, *e)
}

func withEntry(out NotesResult, e notesEntry) NotesResult {
	notes := e.Notes
	out.Notes = &notes
	if e.ReleaseDate != "" {
		d := e.ReleaseDate
		out.ReleaseDate = &d
	}
	return out
}
