package route

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/providers"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func at(o *u.Obj, keys ...string) any {
	var v any = o
	for _, k := range keys {
		x := obj(v)
		if x == nil {
			return nil
		}
		v = x.Get(k)
	}
	return v
}

// RankWire is rankWire (nil = null).
func RankWire(p *config.RuntimeProvider, m *u.Obj, ingress string, usable []string) (string, []string, bool) {
	if len(usable) == 0 {
		return "", nil, false
	}
	if pref, ok := at(m, "wires", "prefer").([]any); ok {
		for _, x := range pref {
			w, _ := x.(string)
			if has(usable, w) {
				why := "model-native:" + w
				if r := at(m, "wires", "reason"); u.Truthy(r) {
					why += "（" + u.JSString(r) + "）"
				}
				return w, []string{why}, true
			}
		}
	}
	if ingress != "" && has(usable, ingress) {
		return ingress, []string{"passthrough"}, true
	}
	q := providers.QuirksOf(p, "")
	if q.ResponsesTellsCache != nil && *q.ResponsesTellsCache && has(usable, "responses") {
		return "responses", []string{"cache-visible"}, true
	}
	if q.PreferWire != "" && has(usable, q.PreferWire) {
		return q.PreferWire, []string{"provider-prefer"}, true
	}
	for _, w := range DefaultOrder {
		if has(usable, w) {
			return w, []string{"default-order"}, true
		}
	}
	return "", nil, false
}

// LossesOf is lossesOf.
func LossesOf(ingress, upstream string, m *u.Obj) []string {
	out := []string{}
	if ingress == "" || ingress == upstream {
		return out
	}
	if ingress == "messages" {
		out = append(out, "signature", "cache-control")
	}
	if ingress == "responses" {
		out = append(out, "sealed-reasoning")
		if at(m, "tools", "freeform") == false || upstream != "responses" {
			out = append(out, "freeform-tools")
		}
	}
	if ingress == "gemini" {
		out = append(out, "thought-signature")
	}
	if at(m, "input", "images") == false {
		out = append(out, "images")
	}
	if at(m, "reasoning", "control") == "none" {
		out = append(out, "reasoning-control")
	}
	return out
}

// QualityOf is qualityOf.
func QualityOf(losses []string) string {
	if len(losses) == 0 {
		return "lossless"
	}
	for _, l := range losses {
		if l != "cache-control" && l != "signature" && l != "passthrough" {
			return "degraded"
		}
	}
	return "good"
}

// MakePlan is makePlan (nil = null).
func MakePlan(p *config.RuntimeProvider, m *u.Obj, ingress string, usable []string) *cand.RoutePlan {
	w, why, ok := RankWire(p, m, ingress, usable)
	if !ok {
		return nil
	}
	losses := LossesOf(ingress, w, m)
	return &cand.RoutePlan{Ingress: ingress, Upstream: w, Why: why, Losses: losses, Quality: QualityOf(losses)}
}

// obj is `isObj(v) ? v : null` (u.AsObj never returns nil).
func obj(v any) *u.Obj {
	if u.IsObj(v) {
		return v.(*u.Obj)
	}
	return nil
}
