package util

// JSFunc stands for a JS function value that leaked into a JSON-ish tree
// (e.g. a `$ref` resolving to an inherited Object.prototype method). It is not
// an object, and JSON.stringify drops it from objects / writes null in arrays.
type JSFunc struct{}

// JSUndefined is an own property whose value is undefined (`{ k: undefined }`):
// the key keeps its slot (later assignments do not move it) but JSON.stringify
// skips it and Obj.Get reads it as nil.
type JSUndefined struct{}

// Undefined is the JSUndefined value.
var Undefined = JSUndefined{}

func skipMember(v any) bool {
	switch v.(type) {
	case JSFunc, JSUndefined:
		return true
	}
	return false
}

var objectProtoMethods = map[string]bool{
	"constructor": true, "__defineGetter__": true, "__defineSetter__": true, "hasOwnProperty": true,
	"__lookupGetter__": true, "__lookupSetter__": true, "isPrototypeOf": true, "propertyIsEnumerable": true,
	"toString": true, "valueOf": true, "toLocaleString": true,
}

// PlainGet is `o[k]` on a plain object literal (prototype Object.prototype):
// own property first, then inherited Object.prototype members. `__proto__`
// yields Object.prototype itself, modelled as an empty object (no own keys).
func PlainGet(o *Obj, k string) (any, bool) {
	if o != nil && o.Has(k) {
		return o.Get(k), true
	}
	if k == "__proto__" {
		return NewObj(), true
	}
	if objectProtoMethods[k] {
		return JSFunc{}, true
	}
	return nil, false
}

// Lookup is the raw own-property read: ok=false when the key is absent; an
// own undefined slot comes back as Undefined (Get reads it as nil).
func (o *Obj) Lookup(k string) (any, bool) {
	if o == nil || o.m == nil {
		return nil, false
	}
	v, ok := o.m[k]
	return v, ok
}
