package clisdk

import (
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const CliAPIVersion = 1

var (
	transports = []string{"acp", "stream-json", "app-server", "exec"}
	ingresses  = []string{"messages", "responses", "chat", "gemini"}
	switches   = []string{"gateway", "inplace", "restart"}
	permModes  = []string{"plan", "manual", "acceptEdits", "auto", "bypass"}
	imageKinds = []string{"native", "path", "none"}
	boolCaps   = []string{"officialAccount", "thirdParty", "subagents", "slashCommands", "resume", "fork", "usageQuota", "progressMonitor", "terminalCommand"}
	manifestID = mustRe(`^[a-z0-9][a-z0-9-]{0,40}$`)
)

func in(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func isStrArr(v any) bool {
	a, ok := v.([]any)
	if !ok {
		return false
	}
	for _, x := range a {
		if _, ok := x.(string); !ok {
			return false
		}
	}
	return true
}

func checkCaps(c any, where string, errs *[]string) {
	o, ok := isPlainObj(c)
	if !ok {
		*errs = append(*errs, where+" must be an object")
		return
	}
	for _, k := range boolCaps {
		if v := o.Get(k); o.Has(k) {
			if _, ok := v.(bool); !ok {
				*errs = append(*errs, where+"."+k+" must be boolean")
			}
		}
	}
	if o.Has("images") && !in(imageKinds, util.JSString(o.Get("images"))) {
		*errs = append(*errs, where+".images must be one of "+strings.Join(imageKinds, ", "))
	}
	if o.Has("permissionModes") {
		pm, ok := o.Get("permissionModes").([]any)
		if !ok {
			*errs = append(*errs, where+".permissionModes must be an array")
			return
		}
		for i, m := range pm {
			mo, ok := isPlainObj(m)
			p := where + ".permissionModes[" + itoa(i) + "]"
			if !ok || !in(permModes, util.JSString(mo.Get("mode"))) {
				*errs = append(*errs, p+".mode is invalid")
				continue
			}
			if mo.Has("args") && !isStrArr(mo.Get("args")) {
				*errs = append(*errs, p+".args must be string[]")
			}
			if mo.Has("modeId") {
				if _, ok := mo.Get("modeId").(string); !ok {
					*errs = append(*errs, p+".modeId must be a string")
				}
			}
		}
	}
}

// ValidateManifest mirrors validateManifest（versionPattern 用 ECMAScript 正则校验）。
func ValidateManifest(raw any) []string {
	errs := []string{}
	m, ok := isPlainObj(raw)
	if !ok {
		return []string{"manifest must be an object"}
	}
	if id, ok := m.Get("id").(string); !ok || !manifestID.MatchString(id) {
		errs = append(errs, "id must match [a-z0-9-] (1–41 chars, not starting with -)")
	}
	if v, ok := m.Get("apiVersion").(float64); !ok || v != CliAPIVersion {
		errs = append(errs, "apiVersion must be 1")
	}
	if dn, ok := m.Get("displayName").(string); !ok || JSTrim(dn) == "" {
		errs = append(errs, "displayName is required")
	}
	if _, ok := m.Get("icon").(string); !ok {
		errs = append(errs, "icon must be a string")
	}
	if b, ok := isPlainObj(m.Get("binary")); !ok {
		errs = append(errs, "binary must be an object")
	} else {
		if names, _ := b.Get("names").([]any); !isStrArr(b.Get("names")) || len(names) == 0 {
			errs = append(errs, "binary.names must be a non-empty string[]")
		}
		if !isStrArr(b.Get("versionArgs")) {
			errs = append(errs, "binary.versionArgs must be string[]")
		}
		if vp, ok := b.Get("versionPattern").(string); !ok {
			errs = append(errs, "binary.versionPattern must be a string")
		} else if _, err := NewJSRegExp(vp, ""); err != nil {
			errs = append(errs, "binary.versionPattern is not a valid regular expression")
		}
		if b.Has("minVersion") {
			if _, ok := b.Get("minVersion").(string); !ok {
				errs = append(errs, "binary.minVersion must be a string")
			}
		}
	}
	if !in(transports, jsStringOrUndef(m, "transport")) {
		errs = append(errs, "transport must be one of "+strings.Join(transports, ", "))
	}
	if m.Has("fallbackTransport") && m.Get("fallbackTransport") != "exec" {
		errs = append(errs, "fallbackTransport must be exec")
	}
	if !in(ingresses, jsStringOrUndef(m, "ingress")) {
		errs = append(errs, "ingress must be one of "+strings.Join(ingresses, ", "))
	}
	checkCaps(m.Get("capabilities"), "capabilities", &errs)
	if !in(switches, jsStringOrUndef(m, "modelSwitch")) {
		errs = append(errs, "modelSwitch must be one of "+strings.Join(switches, ", "))
	}
	if m.Has("versionGates") {
		g, ok := m.Get("versionGates").([]any)
		if !ok {
			errs = append(errs, "versionGates must be an array")
		} else {
			for i, x := range g {
				o, ok := isPlainObj(x)
				if _, s := o.Get("range").(string); !ok || !s {
					errs = append(errs, "versionGates["+itoa(i)+"].range is required")
				} else {
					checkCaps(o.Get("capabilities"), "versionGates["+itoa(i)+"].capabilities", &errs)
				}
			}
		}
	}
	if _, ok := isPlainObj(m.Get("clientSpec")); !ok {
		errs = append(errs, "clientSpec must be an object")
	}
	return errs
}

// String(undefined) = "undefined"。
func jsStringOrUndef(o *util.Obj, k string) string {
	if !o.Has(k) {
		return "undefined"
	}
	return util.JSString(o.Get(k))
}

// EffectiveCapabilities mirrors effectiveCapabilities。
func EffectiveCapabilities(m *util.Obj, version *string, inRange func(v, r string) bool, handshake *util.Obj) *util.Obj {
	caps := O()
	if c, ok := m.Get("capabilities").(*util.Obj); ok {
		caps.Assign(c)
	}
	if version != nil && *version != "" && inRange != nil {
		gates, _ := m.Get("versionGates").([]any)
		for _, g := range gates {
			go_, _ := g.(*util.Obj)
			if r, ok := go_.Get("range").(string); ok && inRange(*version, r) {
				if c, ok := go_.Get("capabilities").(*util.Obj); ok {
					caps.Assign(c)
				}
			}
		}
	}
	if handshake != nil {
		for _, k := range handshake.Keys() {
			if handshake.Get(k) == false && caps.Has(k) {
				if k == "images" {
					caps.Set(k, "none")
				} else {
					caps.Set(k, false)
				}
			}
		}
	}
	return caps
}
