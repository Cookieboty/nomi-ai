package local

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/extensions"
)

// HubDeps：LocalHubService 依赖
type HubDeps struct {
	Root     string
	UserData string
	Logger   deps.Logger
	Desktop  deps.Audit
	Ports    deps.Ports
	Events   deps.Events
	Now      func() time.Time
}

type Hub struct {
	d HubDeps
	// LegacyPurged：启动时清理旧剪贴板历史，完成后关闭（测试可等待）
	LegacyPurged chan struct{}
}

func NewHub(d HubDeps) *Hub {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Logger == nil {
		d.Logger = deps.StdLogger{Prefix: "[hub]"}
	}
	h := &Hub{d: d, LegacyPurged: make(chan struct{})}
	go func() {
		defer close(h.LegacyPurged)
		e1 := os.Remove(filepath.Join(d.Root, "clipboard.json"))
		e2 := os.RemoveAll(filepath.Join(d.Root, "clips"))
		for _, e := range []error{e1, e2} {
			if e != nil && !os.IsNotExist(e) {
				d.Logger.Warn("清理旧剪贴板历史失败", e.Error())
				return
			}
		}
	}()
	return h
}

type ExportOpts struct {
	Conversations any      `json:"conversations,omitempty"`
	Include       []string `json:"include,omitempty"`
}

type ExportResult struct {
	File  string `json:"file"`
	Files int    `json:"files"`
	Bytes int    `json:"bytes"`
}

func (h *Hub) ExportAll(ctx context.Context, o ExportOpts) (*ExportResult, error) {
	file, err := h.d.Ports.SaveFile(ctx, T("electron.common.export-all-local-data"),
		"nomi-export-"+h.d.Now().UTC().Format("2006-01-02")+".zip", []deps.FileFilter{{Name: "Zip", Extensions: []string{"zip"}}})
	if err != nil {
		return nil, err
	}
	if file == "" {
		return nil, nil
	}
	r, err := h.ExportTo(file, o)
	return &r, err
}

func zhLocaleString(t time.Time) string {
	t = t.In(time.Local)
	return fmt.Sprintf("%d/%d/%d %02d:%02d:%02d", t.Year(), int(t.Month()), t.Day(), t.Hour(), t.Minute(), t.Second())
}

func (h *Hub) ExportTo(file string, o ExportOpts) (ExportResult, error) {
	var names []string
	files := map[string][]byte{}
	add := func(rel string, b []byte) {
		if _, ok := files[rel]; !ok {
			names = append(names, rel)
		}
		files[rel] = b
	}
	addFile := func(rel, abs string) {
		st, err := os.Stat(abs)
		if err != nil || !st.Mode().IsRegular() || st.Size() >= 50<<20 {
			return
		}
		if b, err := os.ReadFile(abs); err == nil {
			add(rel, b)
		}
	}
	var addDir func(rel, abs string, depth int)
	addDir = func(rel, abs string, depth int) {
		if depth > 4 {
			return
		}
		ents, err := readDirNodeOrder(abs) // 与 libuv scandir 同序
		if err != nil {
			return
		}
		for _, e := range ents {
			if e.Type()&os.ModeSymlink != 0 {
				continue
			}
			r2 := rel + "/" + e.Name()
			if e.IsDir() {
				addDir(r2, filepath.Join(abs, e.Name()), depth+1)
			} else {
				addFile(r2, filepath.Join(abs, e.Name()))
			}
		}
	}
	inc := o.Include
	if inc == nil {
		inc = []string{"conversations", "memory", "schedule", "skills", "settings"}
	}
	want := map[string]bool{}
	for _, s := range inc {
		want[s] = true
	}
	ud := h.d.UserData
	if want["conversations"] && truthy(o.Conversations) {
		add("conversations.json", []byte(deps.MustStringify(o.Conversations, "  ")))
	}
	for _, k := range []string{"memory", "schedule", "skills"} {
		if want[k] {
			addDir(k, filepath.Join(ud, k), 0)
		}
	}
	if want["settings"] {
		for _, f := range []string{"desktop/settings.json", "desktop/reminders.json", "knowledge/settings.json", "voice/settings.json", "local/settings.json"} {
			addFile("settings/"+f, filepath.Join(ud, filepath.FromSlash(f)))
		}
		if b, err := os.ReadFile(filepath.Join(ud, "extensions", "mcp.json")); err == nil {
			if v, err := deps.ParseJSONOrdered(b); err == nil {
				if arr, ok := v.([]any); ok {
					out := make([]any, 0, len(arr))
					okAll := true
					for _, s := range arr {
						oo, ok := s.(*deps.OrderedObject)
						if !ok {
							okAll = false // Node：非对象条目会在 redact 里抛错 → 整体跳过
							break
						}
						out = append(out, extensions.RedactServerForExport(oo, T("electron.common.removed")))
					}
					if okAll {
						add("settings/mcp.json", []byte(deps.MustStringify(out, "  ")))
					}
				}
			}
		}
	}
	add("README.txt", []byte(T("electron.common.nomi-data-export", zhLocaleString(h.d.Now()))+
		T("electron.common.includes-chats-long-term-memory-schedules-reminders-skills")+
		T("electron.common.excludes-api-keys-and-other-secrets-removed-downloaded")))
	ents := make([]zipEntry, 0, len(names))
	for _, n := range names {
		ents = append(ents, zipEntry{n, files[n]})
	}
	zb, err := fflateZipSync(ents, h.d.Now)
	if err != nil {
		return ExportResult{}, err
	}
	buf := bytes.NewBuffer(zb)
	if err := os.WriteFile(file, buf.Bytes(), 0o644); err != nil {
		return ExportResult{}, err
	}
	ms := int64(0)
	if h.d.Desktop != nil {
		h.d.Desktop.Append(deps.AuditEntry{Tool: "data_export", Args: deps.O("files", len(names), "bytes", buf.Len()), Decision: "user", Result: "ok", Ms: &ms, Source: "settings"})
	}
	if h.d.Events != nil {
		deps.AvatarGesture(h.d.Events, "nod")
	}
	return ExportResult{file, len(names), buf.Len()}, nil
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && x == x
	case string:
		return x != ""
	}
	return true
}
