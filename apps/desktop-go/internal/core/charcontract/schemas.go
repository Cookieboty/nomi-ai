package charcontract

import (
	"regexp"
	"strings"
)

// 与 packages/character-contract/src/schemas.ts 逐项对应。

var (
	PackModes = []string{"rive", "sprite", "static"}
	// RemoteAssetKinds：可以声明为远程（manifest assets.remote，按需下载）的素材
	RemoteAssetKinds = []string{"rive"}
	HitboxIDs        = []string{"head", "face", "body", "hand", "hem"}
)

var driveRe = regexp.MustCompile(`^[a-zA-Z]:`)

// NormalizePackPath = paths.ts normalizePackPath；ok=false 即 null。
func NormalizePackPath(input string) (string, bool) {
	raw := strings.ReplaceAll(jsTrim(input), `\`, "/")
	if raw == "" || strings.HasPrefix(raw, "/") || driveRe.MatchString(raw) || strings.Contains(raw, "\x00") {
		return "", false
	}
	var out []string
	for _, seg := range strings.Split(raw, "/") {
		if seg == "" || seg == "." {
			continue
		}
		if seg == ".." {
			return "", false
		}
		out = append(out, seg)
	}
	if len(out) == 0 {
		return "", false
	}
	return strings.Join(out, "/"), true
}

// JoinPackPath = paths.ts joinPackPath（空段被 filter(Boolean) 去掉）。
func JoinPackPath(parts ...string) (string, bool) {
	var keep []string
	for _, p := range parts {
		if p != "" {
			keep = append(keep, p)
		}
	}
	return NormalizePackPath(strings.Join(keep, "/"))
}

var (
	packPath = zstring{checks: []check{refine(func(v any) bool {
		_, ok := NormalizePackPath(v.(string))
		return ok
	}, "must be a relative path inside the pack")}}
	ratio = znumber{checks: []check{gte(0), lte(1)}}

	hitboxRegionSchema = zobject{
		shape: []field{{"top", ratio}, {"bottom", ratio}, {"left", ratio}, {"right", ratio}},
		checks: []check{refine(func(v any) bool {
			o := v.(*Obj)
			return jsLess(o.Get("top"), o.Get("bottom")) && jsLess(o.Get("left"), o.Get("right"))
		}, "top must be < bottom and left must be < right")},
	}
	hitboxIDSchema = zenum{values: HitboxIDs}
	bubbleAnchor   = zobject{shape: []field{{"x", ratio}, {"y", ratio}}}
	dim            = znumber{checks: []check{intCheck, gt(0), lte(4096)}}
	windowSize     = zobject{shape: []field{{"width", dim}, {"height", dim}}}
	layoutSchema   = zobject{shape: []field{
		{"window", opt(windowSize)},
		{"hitboxes", opt(zrecord{val: hitboxRegionSchema, enum: &hitboxIDSchema})},
		{"bubbleAnchor", opt(bubbleAnchor)},
	}}
	packModeSchema = zenum{values: PackModes}
	assetsSchema   = zobject{loose: true, shape: []field{
		{"mode", zdefault{packModeSchema, "rive"}},
		{"rive", opt(packPath)}, {"sprite", opt(packPath)}, {"static", opt(packPath)},
		{"voice", opt(packPath)}, {"onboarding", opt(packPath)}, {"layout", opt(packPath)}, {"copy", opt(packPath)},
		{"remote", opt(zarray{elem: zenum{values: RemoteAssetKinds}})},
	}}
	nonEmptyArr  = zarray{elem: nonEmpty}
	capabilities = zobject{loose: true, shape: []field{
		{"riveMotions", opt(nonEmptyArr)}, {"spriteActions", opt(nonEmptyArr)},
		{"expressions", opt(nonEmptyArr)}, {"voiceClipIds", opt(nonEmptyArr)},
		{"lipSync", opt(zbool{})}, {"blink", opt(zbool{})},
	}}
	localizedName = zunion{options: []schema{nonEmpty, zobject{shape: []field{{"zh", opt(nonEmpty)}, {"en", opt(nonEmpty)}}}}}
	packIDRe      = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	packIDSchema  = zstring{checks: []check{regexCheck(packIDRe, "id must be lowercase letters, digits, - or _ (max 64 chars)")}}
	catalogSchema = zobject{shape: []field{
		{"displayName", opt(nonEmpty)}, {"description", opt(nonEmpty)}, {"author", opt(nonEmpty)},
		{"tags", opt(nonEmptyArr)}, {"version", opt(nonEmpty)}, {"lastUpdated", opt(nonEmpty)},
	}}
	plainString    = zstring{}
	manifestSchema = zobject{loose: true, shape: []field{
		{"schema", zlit1{}},
		{"id", packIDSchema},
		{"contractVersion", znumber{checks: []check{intCheck, gt(0)}}},
		{"version", opt(plainString)},
		{"displayName", opt(localizedName)},
		{"engines", opt(zrecord{key: plainString, val: plainString})},
		{"assets", assetsSchema},
		{"rive", opt(zobject{shape: []field{{"artboard", opt(nonEmpty)}, {"stateMachine", opt(nonEmpty)}}})},
		{"defaults", opt(zrecord{key: plainString, val: zunknown{}})},
		{"capabilities", opt(capabilities)},
		{"layout", opt(layoutSchema)},
		{"catalog", opt(catalogSchema)},
	}}
	personaSchema = zobject{shape: []field{
		{"displayName", nonEmpty},
		{"shortName", opt(nonEmpty)},
		{"systemPromptIdentity", nonEmpty},
		{"pronoun", opt(nonEmpty)},
		{"addressUser", opt(nonEmpty)},
		{"greetings", nonEmptyArr},
		{"tips", opt(nonEmptyArr)},
	}}
	resourceRef   = zunion{options: []schema{nonEmpty, zarray{elem: nonEmpty, min1: true}}}
	semanticMap   = zrecord{key: nonEmpty, val: resourceRef}
	mappingSchema = zobject{shape: []field{
		{"emotions", opt(semanticMap)}, {"activities", opt(semanticMap)}, {"gestures", opt(semanticMap)},
	}}
	characterLocaleSchema = zobject{shape: []field{
		{"persona", opt(personaSchema.partial())},
		{"wakePhrase", opt(nonEmpty)},
		{"lines", opt(zrecord{key: nonEmpty, val: plainString})},
	}}
)

// jsLess：refine 里的 `<`（通过 refine 时两边都已是数字）。
func jsLess(a, b any) bool {
	x, ok1 := a.(float64)
	y, ok2 := b.(float64)
	return ok1 && ok2 && x < y
}

// Schemas 供 parity 测试按名字取。
var Schemas = map[string]schema{
	"manifest":     manifestSchema,
	"persona":      personaSchema,
	"mapping":      mappingSchema,
	"locale":       characterLocaleSchema,
	"hitboxRegion": hitboxRegionSchema,
	"packId":       packIDSchema,
	"layout":       layoutSchema,
}

// SafeParse 返回 (ok, data, issues)。
func SafeParse(s schema, v any) (bool, any, []Issue) {
	r := s.run(v)
	if len(r.issues) > 0 {
		return false, nil, r.issues
	}
	return true, r.val, nil
}

// ParsePersona = personaSchema.safeParse(v)：成功返回解析后的对象。
func ParsePersona(v any) (*Obj, bool) {
	ok, data, _ := SafeParse(personaSchema, v)
	o, _ := data.(*Obj)
	return o, ok && o != nil
}

// ParseCharacterLocale = characterLocaleSchema.safeParse(v)。
func ParseCharacterLocale(v any) (*Obj, bool) {
	ok, data, _ := SafeParse(characterLocaleSchema, v)
	o, _ := data.(*Obj)
	return o, ok && o != nil
}
