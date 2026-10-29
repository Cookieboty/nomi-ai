package charcontract

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// 与 migrations.ts 逐项对应（纯函数，不改入参）。

// isPlainObj = migrations.ts isObject（非 null、非数组的对象）。
func isPlainObj(v any) bool { return isObject(v) }

// strOf = migrations.ts str()：非空白字符串取 trim 后的值。
func strOf(v any) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	t := jsTrim(s)
	return t, t != ""
}

// objectProtoKeys：`k in {}` 为真的键（Object.prototype 上的属性）。
var objectProtoKeys = map[string]bool{
	"constructor": true, "__defineGetter__": true, "__defineSetter__": true, "hasOwnProperty": true,
	"__lookupGetter__": true, "__lookupSetter__": true, "isPrototypeOf": true, "propertyIsEnumerable": true,
	"toString": true, "valueOf": true, "__proto__": true, "toLocaleString": true,
}

// jsIn = `k in o`（o 为普通对象）。
func jsIn(o *Obj, k string) bool { return o.Has(k) || objectProtoKeys[k] }

func migrateHitboxIDs(regions any) any {
	o, ok := regions.(*Obj)
	if !ok {
		return regions
	}
	out := o.Spread()
	if jsIn(out, "skirt") {
		if !jsIn(out, "hem") {
			out.Set("hem", out.Get("skirt"))
		}
		out.Delete("skirt")
	}
	return out
}

func migrateLegacyHitboxesFile(raw any) *Obj {
	o, ok := raw.(*Obj)
	if !ok || !isPlainObj(o.Get("regions")) {
		return nil
	}
	out := NewObj()
	out.Set("hitboxes", migrateHitboxIDs(o.Get("regions")))
	if ba := o.Get("bubbleAnchor"); ba != Undef {
		out.Set("bubbleAnchor", ba)
	}
	return out
}

var digitsRe = regexp.MustCompile(`(\d+)`)

func contractVersionFromEngines(engines any) float64 {
	o, ok := engines.(*Obj)
	if !ok {
		return 1
	}
	r, ok := strOf(o.Get("nomiPack"))
	if !ok {
		return 1
	}
	m := digitsRe.FindString(r)
	if m == "" {
		return 1
	}
	n, _ := strconv.ParseFloat(m, 64) // Number("…")：全是数字，有限时必为整数；溢出为 Infinity
	if math.IsInf(n, 0) || !(n > 0) {
		return 1
	}
	return n
}

// MigrateManifest = migrateManifest(raw, { legacyHitboxes })；legacy 为 Undef 时表示未传。
func MigrateManifest(raw any, legacyHitboxes any) any {
	src, ok := raw.(*Obj)
	if !ok {
		return raw
	}
	m := src.Spread()
	if m.Get("contractVersion") == Undef {
		m.Set("contractVersion", contractVersionFromEngines(m.Get("engines")))
	}
	assets := NewObj()
	if a, ok := m.Get("assets").(*Obj); ok {
		assets = a.Spread()
	}
	if mode, ok := m.Get("mode").(string); ok && assets.Get("mode") == Undef {
		assets.Set("mode", mode)
	}
	m.Delete("mode")
	m.Set("assets", assets)

	if caps, ok := m.Get("capabilities").(*Obj); ok {
		if ids, ok := caps.Get("voiceClipIds").([]any); ok {
			seen := map[string]bool{}
			out := []any{}
			for _, x := range ids {
				s, ok := x.(string)
				if !ok {
					continue
				}
				id := ResolveVoiceClipID(s)
				if !seen[id] {
					seen[id] = true
					out = append(out, id)
				}
			}
			c := caps.Spread()
			c.Set("voiceClipIds", out)
			m.Set("capabilities", c)
		}
	}

	layout := NewObj()
	if l, ok := m.Get("layout").(*Obj); ok {
		layout = l.Spread()
	}
	if isPlainObj(layout.Get("hitboxes")) {
		layout.Set("hitboxes", migrateHitboxIDs(layout.Get("hitboxes")))
	}
	if legacy := migrateLegacyHitboxesFile(legacyHitboxes); legacy != nil {
		if layout.Get("hitboxes") == Undef {
			layout.Set("hitboxes", legacy.Get("hitboxes"))
		}
		if layout.Get("bubbleAnchor") == Undef && legacy.Get("bubbleAnchor") != Undef {
			layout.Set("bubbleAnchor", legacy.Get("bubbleAnchor"))
		}
	}
	if layout.Len() > 0 {
		m.Set("layout", layout)
	} else {
		m.Delete("layout")
	}
	return m
}

var lineSplitRe = regexp.MustCompile(`\r?\n`)

// MigrateLegacyPersona = migrateLegacyPersona；systemPrompt 为 nil 表示未提供。返回 nil 即 null。
func MigrateLegacyPersona(manifest, copy any, systemPrompt *string, locale string) *Obj {
	mo, _ := manifest.(*Obj)
	co, _ := copy.(*Obj)
	var manifestName string
	var hasMN bool
	if dn, ok := mo.Get("displayName").(*Obj); ok {
		if manifestName, hasMN = strOf(dn.Get(locale)); !hasMN {
			if manifestName, hasMN = strOf(dn.Get("zh")); !hasMN {
				manifestName, hasMN = strOf(dn.Get("en"))
			}
		}
	} else {
		manifestName, hasMN = strOf(mo.Get("displayName"))
	}
	displayName, ok := strOf(co.Get("displayName"))
	if !ok {
		displayName, ok = manifestName, hasMN
		if !ok {
			displayName, ok = strOf(mo.Get("id"))
		}
	}
	identity, iok := strOf(co.Get("systemPromptIdentity"))
	if !iok && systemPrompt != nil {
		for _, l := range lineSplitRe.Split(*systemPrompt, -1) {
			if jsTrim(l) != "" {
				identity, iok = strOf(l)
				break
			}
		}
	}
	if !ok || !iok {
		return nil
	}
	out := NewObj()
	out.Set("displayName", displayName)
	out.Set("systemPromptIdentity", identity)
	out.Set("greetings", []any{})
	return out
}

// MigrateLegacyCopy = migrateLegacyCopy。
func MigrateLegacyCopy(copy any) *Obj {
	c, ok := copy.(*Obj)
	if !ok {
		return NewObj()
	}
	persona := NewObj()
	if v, ok := strOf(c.Get("displayName")); ok {
		persona.Set("displayName", v)
	}
	if v, ok := strOf(c.Get("systemPromptIdentity")); ok {
		persona.Set("systemPromptIdentity", v)
	}
	out := NewObj()
	if persona.Len() > 0 {
		out.Set("persona", persona)
	}
	if v, ok := strOf(c.Get("wakePhrase")); ok {
		out.Set("wakePhrase", v)
	}
	if isPlainObj(c.Get("lines")) {
		out.Set("lines", c.Get("lines"))
	}
	return out
}

var legacyMappingEmotions = map[string]string{
	"happy": "nod", "sad": "tears", "surprised": "surprise", "confused": "puzzled", "sleepy": "yawn",
}

// IsLegacyMapping = isLegacyMapping。
func IsLegacyMapping(raw any, expressions []string) bool {
	o, ok := raw.(*Obj)
	if !ok {
		return false
	}
	em, ok := o.Get("emotions").(*Obj)
	if !ok {
		return false
	}
	for _, key := range em.Keys() {
		legacy, ok := legacyMappingEmotions[key]
		if !ok || contains(expressions, legacy) {
			continue
		}
		switch t := em.Get(key).(type) {
		case string:
			if t == legacy {
				return true
			}
		case []any:
			for _, x := range t {
				if x == legacy {
					return true
				}
			}
		}
	}
	return false
}

// IsContractVersionSupported = isContractVersionSupported。
func IsContractVersionSupported(v float64) bool {
	return v == float64(int64(v)) && v >= 1 && v <= ContractVersion
}

var _ = strings.TrimSpace
