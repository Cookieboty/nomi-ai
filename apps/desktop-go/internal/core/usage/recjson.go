package usage

import (
	"bytes"
	"encoding/json"
	"math"
	"reflect"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// UsageRecord 的 JS 对象语义：自有属性顺序、未知字段、类型不符的字段（JSON.parse 什么都收，JSON.stringify 原样写回）

type recField struct {
	idx  int
	kind byte // 'n' float64, 'N' *float64, 's' string, 'S' *string, 'B' *bool
}

var (
	recFields   = map[string]recField{}
	recAllKeys  []string
	recTypeInfo = reflect.TypeOf(UsageRecord{})
)

func init() {
	for i := 0; i < recTypeInfo.NumField(); i++ {
		f := recTypeInfo.Field(i)
		tag := f.Tag.Get("json")
		if tag == "" {
			continue
		}
		name := tag
		if j := bytes.IndexByte([]byte(tag), ','); j >= 0 {
			name = tag[:j]
		}
		var k byte
		switch f.Type.String() {
		case "float64":
			k = 'n'
		case "*float64":
			k = 'N'
		case "string":
			k = 's'
		case "*string":
			k = 'S'
		case "*bool":
			k = 'B'
		}
		recFields[name] = recField{i, k}
		recAllKeys = append(recAllKeys, name)
	}
}

// 字面量键序（logParsers / UsageService 里的对象字面量）
var (
	keysLogRec    = []string{"key", "ts", "source", "via", "provider", "model", "input", "output", "cacheRead", "cacheWrite", "session", "project"}
	keysLogNoProv = []string{"key", "ts", "source", "via", "model", "input", "output", "cacheRead", "cacheWrite", "session", "project"}
	keysAider     = []string{"key", "ts", "source", "via", "model", "input", "output", "cacheRead", "cacheWrite"}
	keysKimiCop   = []string{"key", "ts", "source", "via", "model", "input", "output", "cacheRead", "cacheWrite", "session"}
)

func (r *UsageRecord) withKeys(k []string) *UsageRecord {
	r.keys = append([]string(nil), k...)
	return r
}

// present：结构体顺序下该字段是否有值（keys==nil 时的自有属性判定）
func (r *UsageRecord) present(name string) bool {
	f, ok := recFields[name]
	if !ok {
		_, has := r.raw[name]
		return has
	}
	if _, has := r.raw[name]; has {
		return true
	}
	v := reflect.ValueOf(r).Elem().Field(f.idx)
	if f.kind == 'n' || f.kind == 's' {
		return true
	}
	return !v.IsNil()
}

func (r *UsageRecord) ownKeys() []string {
	if r.keys != nil {
		return r.keys
	}
	out := []string{}
	for _, k := range recAllKeys {
		if r.present(k) {
			out = append(out, k)
		}
	}
	return out
}

func (r *UsageRecord) hasOwn(k string) bool {
	for _, x := range r.ownKeys() {
		if x == k {
			return true
		}
	}
	return false
}

// addKey：obj[k] 赋值后的键序（已有键位置不变，新键追加）
func (r *UsageRecord) addKey(k string) {
	ks := r.ownKeys()
	for _, x := range ks {
		if x == k {
			r.keys = ks
			return
		}
	}
	r.keys = append(append(make([]string, 0, len(ks)+1), ks...), k)
}

// setOwn：obj[k] = 新值（类型正确），原始值作废
func (r *UsageRecord) setOwn(k string) {
	r.addKey(k)
	if _, ok := r.raw[k]; ok {
		r.raw = cloneRaw(r.raw)
		delete(r.raw, k)
	}
}

// eqProp：a[k] === b[k]
func eqProp(a, b *UsageRecord, k string) bool {
	ra, oa := a.raw[k]
	rb, ob := b.raw[k]
	if oa || ob {
		return oa && ob && bytes.Equal(ra, rb)
	}
	f := recFields[k]
	va := reflect.ValueOf(a).Elem().Field(f.idx)
	vb := reflect.ValueOf(b).Elem().Field(f.idx)
	switch f.kind {
	case 'n':
		return va.Float() == vb.Float()
	case 's':
		return va.String() == vb.String()
	}
	if va.IsNil() || vb.IsNil() {
		return va.IsNil() && vb.IsNil()
	}
	return va.Elem().Interface() == vb.Elem().Interface()
}

// delOwn：delete obj[k]
func (r *UsageRecord) delOwn(k string) {
	ks := r.ownKeys()
	out := make([]string, 0, len(ks))
	for _, x := range ks {
		if x != k {
			out = append(out, x)
		}
	}
	r.keys = out
	if _, ok := r.raw[k]; ok {
		r.raw = cloneRaw(r.raw)
		delete(r.raw, k)
	}
}

func cloneRaw(m map[string]json.RawMessage) map[string]json.RawMessage {
	if m == nil {
		return nil
	}
	c := make(map[string]json.RawMessage, len(m))
	for k, v := range m {
		c[k] = v
	}
	return c
}

// copyProp：dst[k] = src[k]（含 undefined / 原始值）
func copyProp(dst, src *UsageRecord, k string) {
	if f, ok := recFields[k]; ok {
		reflect.ValueOf(dst).Elem().Field(f.idx).Set(reflect.ValueOf(src).Elem().Field(f.idx))
	}
	if v, ok := src.raw[k]; ok {
		if dst.raw == nil {
			dst.raw = map[string]json.RawMessage{}
		}
		dst.raw[k] = v
	} else if _, ok := dst.raw[k]; ok {
		delete(dst.raw, k)
	}
}

// spreadRec = { ...prev, ...r }
func spreadRec(prev, r *UsageRecord) *UsageRecord {
	m := cloneRec(prev)
	m.raw = cloneRaw(prev.raw)
	keys := append([]string(nil), prev.ownKeys()...)
	for _, k := range r.ownKeys() {
		found := false
		for _, x := range keys {
			if x == k {
				found = true
				break
			}
		}
		if !found {
			keys = append(keys, k)
		}
		copyProp(m, r, k)
	}
	m.keys = keys
	return m
}

func (r UsageRecord) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	first := true
	v := reflect.ValueOf(&r).Elem()
	for _, k := range r.ownKeys() {
		var val []byte
		if raw, ok := r.raw[k]; ok {
			val = raw
		} else if f, ok := recFields[k]; ok {
			fv := v.Field(f.idx)
			if (f.kind == 'N' || f.kind == 'S' || f.kind == 'B') && fv.IsNil() {
				continue // undefined：JSON.stringify 跳过
			}
			val = []byte(util.Stringify(reflect.Indirect(fv).Interface()))
		} else {
			continue
		}
		break0(&b, &first, k, val)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func break0(b *bytes.Buffer, first *bool, k string, val []byte) {
	if !*first {
		b.WriteByte(',')
	}
	*first = false
	b.WriteString(util.Stringify(k))
	b.WriteByte(':')
	b.Write(val)
}

// UnmarshalJSON：JSON.parse 的对象语义（重复键取最后的值、保留首次出现的位置）
func (r *UsageRecord) UnmarshalJSON(data []byte) error {
	pv, err := util.Parse(data)
	if err != nil {
		return err
	}
	o, ok := pv.(*util.Obj)
	if !ok {
		return &json.UnmarshalTypeError{Value: "non-object", Type: recTypeInfo}
	}
	*r = r.fromObj(o)
	return nil
}

func (UsageRecord) fromObj(o *util.Obj) UsageRecord {
	var r UsageRecord
	keys := o.Keys()
	r.keys = append([]string{}, keys...)
	v := reflect.ValueOf(&r).Elem()
	own := map[string]bool{}
	for _, k := range keys {
		own[k] = true
		x := o.Get(k)
		f, known := recFields[k]
		if !known {
			r.putRaw(k, x)
			continue
		}
		fv := v.Field(f.idx)
		switch f.kind {
		case 'n', 'N':
			n, ok := x.(float64)
			if !ok {
				r.putRaw(k, x)
				if x == nil && f.kind == 'N' {
					continue
				}
				n = jsToNumber(x)
			}
			if f.kind == 'n' {
				fv.SetFloat(n)
			} else {
				fv.Set(reflect.ValueOf(f64p(n)))
			}
		case 's', 'S':
			s, ok := x.(string)
			if !ok {
				r.putRaw(k, x)
				if x == nil {
					continue
				}
				s = jsToString(x)
			}
			if f.kind == 's' {
				fv.SetString(s)
			} else {
				fv.Set(reflect.ValueOf(strp(s)))
			}
		case 'B':
			bv, ok := x.(bool)
			if !ok {
				r.putRaw(k, x)
				if x == nil {
					continue
				}
				bv = util.Truthy(x)
			}
			fv.Set(reflect.ValueOf(boolp(bv)))
		}
	}
	// 缺失的数字字段 = undefined：参与 Math.max / 加法得 NaN
	for name, f := range recFields {
		if f.kind == 'n' && !own[name] {
			v.Field(f.idx).SetFloat(math.NaN())
		}
	}
	return r
}

func (r *UsageRecord) putRaw(k string, x any) {
	if r.raw == nil {
		r.raw = map[string]json.RawMessage{}
	}
	r.raw[k] = json.RawMessage(util.Stringify(x))
}

// jsToNumber：Number(v)（数组按 String(arr)，对象 NaN）
func jsToNumber(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case string:
		return util.ToNumber(x)
	case []any:
		return util.ToNumber(jsToString(x))
	}
	return math.NaN()
}

// jsToString：String(v)
func jsToString(v any) string {
	switch x := v.(type) {
	case []any:
		var b bytes.Buffer
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if e != nil {
				b.WriteString(jsToString(e))
			}
		}
		return b.String()
	case map[string]any:
		return "[object Object]"
	}
	return util.JSString(v)
}

// jsTruthyProp：if (obj[k]) 的判定（原始值优先）
func (r *UsageRecord) truthy(k string) bool {
	if raw, ok := r.raw[k]; ok {
		x, _ := util.Parse(raw)
		return util.Truthy(x)
	}
	f, ok := recFields[k]
	if !ok {
		return false
	}
	fv := reflect.ValueOf(r).Elem().Field(f.idx)
	switch f.kind {
	case 'n':
		x := fv.Float()
		return x != 0 && !math.IsNaN(x)
	case 's':
		return fv.String() != ""
	}
	if fv.IsNil() {
		return false
	}
	return util.Truthy(fv.Elem().Interface())
}
