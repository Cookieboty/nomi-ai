package deps

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

// OrderedObject：保留键插入顺序的 JSON 对象（JS 普通对象的非整数键顺序）
type OrderedObject struct {
	Keys   []string
	Values map[string]any
}

func NewOrderedObject() *OrderedObject { return &OrderedObject{Values: map[string]any{}} }

func (o *OrderedObject) Get(k string) (any, bool) {
	if o == nil {
		return nil, false
	}
	v, ok := o.Values[k]
	return v, ok
}

func (o *OrderedObject) Set(k string, v any) {
	if _, ok := o.Values[k]; !ok {
		o.Keys = append(o.Keys, k)
	}
	o.Values[k] = v
}

func (o *OrderedObject) Delete(k string) {
	if _, ok := o.Values[k]; !ok {
		return
	}
	delete(o.Values, k)
	for i, x := range o.Keys {
		if x == k {
			o.Keys = append(o.Keys[:i:i], o.Keys[i+1:]...)
			break
		}
	}
}

func (o *OrderedObject) Clone() *OrderedObject {
	c := NewOrderedObject()
	for _, k := range o.Keys {
		c.Set(k, o.Values[k])
	}
	return c
}

// Map：深度转换为 map[string]any / []any（丢失顺序，供按键读取）
func (o *OrderedObject) Map() map[string]any {
	if o == nil {
		return nil
	}
	m := make(map[string]any, len(o.Keys))
	for _, k := range o.Keys {
		m[k] = Plain(o.Values[k])
	}
	return m
}

func Plain(v any) any {
	switch x := v.(type) {
	case *OrderedObject:
		return x.Map()
	case []any:
		r := make([]any, len(x))
		for i, e := range x {
			r[i] = Plain(e)
		}
		return r
	}
	return v
}

func (o *OrderedObject) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range o.Keys {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, _ := Stringify(k, "")
		b.Write(kb)
		b.WriteByte(':')
		vb, err := Stringify(o.Values[k], "")
		if err != nil {
			return nil, err
		}
		b.Write(vb)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// ParseJSONOrdered：JSON.parse，对象解析为 *OrderedObject
func ParseJSONOrdered(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	v, err := decodeOrdered(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("unexpected trailing data")
	}
	return v, nil
}

func decodeOrdered(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			o := NewOrderedObject()
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				v, err := decodeOrdered(dec)
				if err != nil {
					return nil, err
				}
				o.Set(kt.(string), v)
			}
			_, err := dec.Token()
			return o, err
		case '[':
			a := []any{}
			for dec.More() {
				v, err := decodeOrdered(dec)
				if err != nil {
					return nil, err
				}
				a = append(a, v)
			}
			_, err := dec.Token()
			return a, err
		}
		return nil, errors.New("bad delim")
	}
	return tok, nil
}

// O：按书写顺序构造有序对象（键值交替），对应 JS 对象字面量的键序
func O(kv ...any) *OrderedObject {
	o := NewOrderedObject()
	for i := 0; i+1 < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

// OverlayKnown 复现“Node 直接改 JSON.parse 出来的对象再写回”：raw 是从磁盘读到的原对象，
// loaded / cur 分别是加载时和现在的已知字段（Go struct 的 JSON）。
// 已知字段没变 → 原值原位保留；变了 → 原位改写（新键追加在末尾）；被清掉 → 删除；未知字段原样保留。
func OverlayKnown(raw *OrderedObject, loaded, cur []byte) ([]byte, error) {
	lv, err := ParseJSONOrdered(loaded)
	if err != nil {
		return nil, err
	}
	cv, err := ParseJSONOrdered(cur)
	if err != nil {
		return nil, err
	}
	l, _ := lv.(*OrderedObject)
	c, _ := cv.(*OrderedObject)
	if l == nil || c == nil {
		return cur, nil
	}
	o := raw.Clone()
	for _, k := range c.Keys {
		nb, _ := Stringify(c.Values[k], "")
		if old, ok := l.Values[k]; ok {
			ob, _ := Stringify(old, "")
			if bytes.Equal(ob, nb) {
				continue
			}
		}
		o.Set(k, c.Values[k])
	}
	for _, k := range l.Keys {
		if _, ok := c.Values[k]; !ok {
			o.Delete(k)
		}
	}
	return Stringify(o, "")
}
