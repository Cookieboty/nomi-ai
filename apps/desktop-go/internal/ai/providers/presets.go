package providers

import (
	_ "embed"
	"strings"
	"sync"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// presets_gen.json 由 scripts/parity/airuntime.mjs --gen 从 apps/desktop-electron/internal/ai-runtime/src/providers/presets.ts
// 的 PROVIDER_PRESETS 原样导出（含 GATEWAY_EXT 合并后的结果，键序不变）；改预设请改 TS 后重新生成。
//
//go:embed presets_gen.json
var presetsJSON []byte

const (
	PresetsCheckedAt        = "2026-10-11"
	GatewayPresetsCheckedAt = "2026-10-21"
)

var (
	presetsOnce sync.Once
	presets     []*u.Obj
)

// ProviderPresets：PROVIDER_PRESETS（只读：调用方不要修改返回的对象）
func ProviderPresets() []*u.Obj {
	presetsOnce.Do(func() {
		v, err := u.Parse(presetsJSON)
		if err != nil {
			panic("providers: presets_gen.json: " + err.Error())
		}
		for _, p := range v.([]any) {
			presets = append(presets, p.(*u.Obj))
		}
	})
	return presets
}

// PresetCategoryLabels：PRESET_CATEGORY_LABELS
func PresetCategoryLabels() *u.Obj {
	return u.NewObj(
		"custom", "ai-runtime.providers.preset-custom",
		"vendor", "ai-runtime.providers.category-vendor",
		"platform", "ai-runtime.providers.category-platform",
	)
}

// FindPreset：findPreset(id)；id 为 nil（undefined）时没有匹配
func FindPreset(id any) *u.Obj {
	for _, p := range ProviderPresets() {
		if p.Get("id") == id {
			return p
		}
	}
	return nil
}

// SearchPresets：名称 / 官网 / 请求地址 / 关键字，大小写不敏感
func SearchPresets(q string, list []*u.Obj) []*u.Obj {
	if list == nil {
		list = ProviderPresets()
	}
	s := u.JSLower(u.JSTrim(q))
	if s == "" {
		return append([]*u.Obj{}, list...)
	}
	out := []*u.Obj{}
	for _, p := range list {
		vals := []any{p.Get("name"), p.Get("websiteUrl"), p.Get("baseURL")}
		if kw, ok := p.Get("keywords").([]any); ok {
			vals = append(vals, kw...)
		}
		for _, v := range vals {
			if !u.Truthy(v) {
				continue
			}
			if strings.Contains(u.JSLower(u.Str(v)), s) {
				out = append(out, p)
				break
			}
		}
	}
	return out
}
