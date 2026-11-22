package convstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
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
		b, err := json.Marshal(obj)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, nil
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
