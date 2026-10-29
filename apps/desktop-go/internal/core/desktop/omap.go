package desktop

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
)

// OMap 保留插入顺序的 JSON 对象（JS 对象键序；整数键的 JS 排序不在此处理）
type OMap struct {
	Keys []string
	Vals map[string]json.RawMessage
}

func NewOMap() *OMap { return &OMap{Vals: map[string]json.RawMessage{}} }

func (m *OMap) Set(k string, v any) {
	raw, ok := v.(json.RawMessage)
	if !ok {
		raw = json.RawMessage(compactJSON(v))
	}
	if _, has := m.Vals[k]; !has {
		m.Keys = append(m.Keys, k)
	}
	m.Vals[k] = raw
}

func (m *OMap) Get(k string) (json.RawMessage, bool) {
	if m == nil {
		return nil, false
	}
	v, ok := m.Vals[k]
	return v, ok
}

func (m *OMap) Delete(k string) {
	if _, ok := m.Vals[k]; !ok {
		return
	}
	delete(m.Vals, k)
	for i, x := range m.Keys {
		if x == k {
			m.Keys = append(m.Keys[:i:i], m.Keys[i+1:]...)
			break
		}
	}
}

func (m *OMap) Len() int {
	if m == nil {
		return 0
	}
	return len(m.Keys)
}

func (m OMap) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range m.Keys {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(compactJSON(k))
		b.WriteByte(':')
		b.Write(m.Vals[k])
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func (m *OMap) UnmarshalJSON(data []byte) error {
	o, err := ParseOMap(data)
	if err != nil {
		return err
	}
	*m = *o
	return nil
}

// ParseOMap 按出现顺序解码 JSON 对象（重复键取最后一个值、保留首次位置，同 JSON.parse）
func ParseOMap(data []byte) (*OMap, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, fmt.Errorf("not an object")
	}
	m := NewOMap()
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil, err
		}
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, err
		}
		m.Set(kt.(string), v)
	}
	return m, nil
}

func randomUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
