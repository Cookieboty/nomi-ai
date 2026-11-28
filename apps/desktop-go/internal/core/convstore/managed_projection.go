package convstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

func projectManaged(d ManagedDocument, limit int) ([]json.RawMessage, error) {
	latest := map[string]int{}
	for i, e := range d.State.History {
		latest[e.ID] = i
	}
	indexes := []int{}
	for _, i := range latest {
		if !d.State.History[i].Tombstone {
			indexes = append(indexes, i)
		}
	}
	sort.Slice(indexes, func(i, j int) bool { return d.State.History[indexes[i]].Order < d.State.History[indexes[j]].Order })
	if limit > 0 && len(indexes) > limit {
		indexes = indexes[len(indexes)-limit:]
	}
	out := make([]json.RawMessage, 0, len(indexes))
	for _, i := range indexes {
		e := d.State.History[i]
		obj := map[string]json.RawMessage{}
		if len(e.Raw) > 0 {
			if err := json.Unmarshal(e.Raw, &obj); err != nil {
				return nil, ErrManagedCorrupt
			}
		}
		obj["id"], _ = json.Marshal(e.ID)
		obj["role"], _ = json.Marshal(e.Role)
		obj["content"], _ = json.Marshal(e.Text)
		if e.Timestamp != 0 {
			obj["timestamp"], _ = json.Marshal(e.Timestamp)
		}
		if e.Role == "assistant" && len(e.Raw) == 0 {
			if e.Origin != "" {
				if _, has := obj["runtimeBackend"]; !has {
					obj["runtimeBackend"], _ = json.Marshal(e.Origin)
				}
			}
			if e.Model != "" && e.Model != "cli-default" && e.Model != "chat-route" {
				if _, has := obj["modelId"]; !has {
					obj["modelId"], _ = json.Marshal(e.Model)
				}
			}
			if e.ResponseModel != "" {
				if _, has := obj["responseModel"]; !has {
					obj["responseModel"], _ = json.Marshal(e.ResponseModel)
				}
			}
			if e.DurationMs > 0 {
				if _, has := obj["durationMs"]; !has {
					obj["durationMs"], _ = json.Marshal(e.DurationMs)
				}
			}
			if e.Usage != nil {
				if _, has := obj["usage"]; !has {
					obj["usage"], _ = json.Marshal(e.Usage)
				}
			}
			if trace := projectTrace(e.Trace); len(trace) > 0 {
				if _, has := obj["trace"]; !has {
					obj["trace"], _ = json.Marshal(trace)
				}
			}
		}
		b, err := json.Marshal(obj)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, nil
}

func projectTrace(entries []cr.TraceEntry) []map[string]any {
	if len(entries) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(entries))
	for _, tr := range entries {
		switch tr.Kind {
		case "thinking":
			text := tr.Detail
			if text == "" {
				text = tr.Summary
			}
			if text == "" {
				continue
			}
			item := map[string]any{
				"type": "thinking",
				"text": text,
			}
			if tr.At != 0 {
				item["at"] = tr.At
			}
			if tr.EndedAt > 0 {
				item["endedAt"] = tr.EndedAt
			}
			if tr.TextAt != nil {
				item["textAt"] = *tr.TextAt
			}
			out = append(out, item)
		case "plan":
			var payload struct {
				PlanID   string           `json:"planId"`
				Entries  []map[string]any `json:"entries"`
				Markdown string           `json:"markdown"`
				URI      string           `json:"uri"`
			}
			if tr.Detail == "" || json.Unmarshal([]byte(tr.Detail), &payload) != nil {
				continue
			}
			if len(payload.Entries) == 0 && strings.TrimSpace(payload.Markdown) == "" && strings.TrimSpace(payload.URI) == "" {
				continue
			}
			entries := payload.Entries
			if entries == nil {
				entries = []map[string]any{}
			}
			item := map[string]any{
				"type":    "plan",
				"entries": entries,
			}
			if payload.PlanID != "" {
				item["planId"] = payload.PlanID
			}
			if payload.Markdown != "" {
				item["markdown"] = payload.Markdown
			}
			if payload.URI != "" {
				item["uri"] = payload.URI
			}
			if tr.At != 0 {
				item["at"] = tr.At
			}
			if tr.TextAt != nil {
				item["textAt"] = *tr.TextAt
			}
			out = append(out, item)
		case "plan-removed", "agent":
			continue
		default:
			name := tr.Tool
			if name == "" {
				name = tr.Summary
			}
			if name == "" {
				name = "tool"
			}
			status := "start"
			switch tr.Status {
			case "completed", "done":
				status = "done"
			case "error", "failed", "denied":
				status = "error"
			}
			item := map[string]any{
				"type":   "tool",
				"name":   name,
				"status": status,
			}
			if tr.ID != "" {
				item["id"] = tr.ID
			}
			if tr.Summary != "" && tr.Summary != name {
				item["title"] = tr.Summary
			}
			if tr.Detail != "" {
				item["input"] = tr.Detail
				if tr.ID == "" {
					item["detail"] = tr.Detail
				}
			}
			if tr.Output != "" {
				item["output"] = tr.Output
			}
			if tr.At != 0 {
				item["at"] = tr.At
			}
			if tr.EndedAt > 0 {
				item["endedAt"] = tr.EndedAt
			}
			if tr.TextAt != nil {
				item["textAt"] = *tr.TextAt
			}
			out = append(out, item)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
func (s *Store) overlayManaged(st *State) error {
	entries, err := os.ReadDir(filepath.Join(s.dir, "managed-v2"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	pos := map[string]int{}
	for i, meta := range st.Conversations {
		pos[metaID(meta)] = i
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		d, err := readManaged(filepath.Join(s.dir, "managed-v2", entry.Name()))
		if err != nil {
			return err
		}
		id := d.State.ConversationID
		if d.Deleted {
			kept := st.Conversations[:0]
			for _, m := range st.Conversations {
				if metaID(m) != id {
					kept = append(kept, m)
				}
			}
			st.Conversations = kept
			pos = map[string]int{}
			for i, m := range kept {
				pos[metaID(m)] = i
			}
			delete(st.Counts, id)
			delete(st.Previews, id)
			if st.Current == id {
				st.Current = ""
			}
			if st.LastNomi == id {
				st.LastNomi = ""
			}
			continue
		}
		st.Managed = append(st.Managed, id)
		messages, err := projectManaged(d, 0)
		if err != nil {
			return err
		}
		meta := json.RawMessage(append([]byte(nil), d.Meta...))
		if i, ok := pos[id]; ok {
			st.Conversations[i] = meta
		} else {
			st.Conversations = append(st.Conversations, meta)
		}
		st.Counts[id] = len(messages)
		delete(st.Previews, id)
		for _, message := range messages {
			var e struct {
				Role string `json:"role"`
				Text string `json:"content"`
			}
			if json.Unmarshal(message, &e) != nil {
				return ErrManagedCorrupt
			}
			if e.Role == "user" {
				r := []rune(e.Text)
				if len(r) > 300 {
					r = r[:300]
				}
				st.Previews[id] = string(r)
				break
			}
		}
	}
	return nil
}
