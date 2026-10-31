package charcontract

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// 与 validate.ts 逐项对应。

// PackSource = validate.ts PackSource。ReadJSON：文件不存在返回 (Undef, nil)。
type PackSource struct {
	Files    []string
	ReadJSON func(path string) (any, error)
	ReadText func(path string) (string, bool)
	SizeOf   func(path string) (int64, bool)
}

// JSThrow 表示 Node 实现在此处会抛出的 TypeError（例如 clips 里有 null）。
type JSThrow struct{ Message string }

func (e JSThrow) Error() string { return e.Message }

type PackIssue struct {
	Severity string
	Code     string
	File     string
	Path     []any
	Message  string
}

func (i PackIssue) toJS() *Obj {
	o := NewObj()
	o.Set("severity", i.Severity)
	o.Set("code", i.Code)
	o.Set("file", i.File)
	p := i.Path
	if p == nil {
		p = []any{}
	}
	o.Set("path", p)
	o.Set("message", i.Message)
	return o
}

// ValidateResult = ValidatePackResult；Pack 为 NormalizedPack 的 JS 形状（*Obj），有错误时为 nil。
type ValidateResult struct {
	OK       bool
	Errors   []PackIssue
	Warnings []PackIssue
	Pack     *Obj
}

// JS 返回 JSON.stringify(result) 的形状（金样比对用）。
func (r ValidateResult) JS() *Obj {
	o := NewObj()
	o.Set("ok", r.OK)
	list := func(xs []PackIssue) []any {
		out := []any{}
		for _, x := range xs {
			out = append(out, x.toJS())
		}
		return out
	}
	o.Set("errors", list(r.Errors))
	o.Set("warnings", list(r.Warnings))
	if r.Pack != nil {
		o.Set("pack", r.Pack)
	} else {
		o.Set("pack", nil)
	}
	return o
}

type ValidateOptions struct {
	RequireCompleteVoice bool
	Lenient              bool
}

var NonStructuralIssues = []string{"asset-too-small", "fallback-asset-missing", "voice-manifest-missing", "voice-clips-incomplete"}

// IsLenientDowngrade = isLenientDowngrade。
func IsLenientDowngrade(i PackIssue) bool {
	return i.Severity == "warning" && (contains(NonStructuralIssues, i.Code) ||
		i.Code == "schema-lenient" || i.Code == "schema-invalid" || i.Code == "json-invalid")
}

const minRiveBytes = 1000

type sinkFn func(severity, code, file, message string, path []any)

func zodIssues(sink sinkFn, file string, iss []Issue) {
	for _, is := range iss {
		sink("error", "schema-invalid", file, is.Message, is.Path)
	}
}

func readJSONSafe(src PackSource, file string, sink sinkFn) (bool, any) {
	v, err := src.ReadJSON(file)
	if err != nil {
		sink("error", "json-invalid", file, err.Error(), nil)
		return true, Undef
	}
	return v != Undef, v
}

// dirOf：`(rel && normalizePackPath(rel)) || fallback`。
func dirOf(rel any, fallback string) string {
	if s, ok := rel.(string); ok {
		if n, ok := NormalizePackPath(s); ok {
			return n
		}
	}
	return fallback
}

var staticExtRe = regexp.MustCompile(`(?i)\.(webp|png)$`)

func resolveStatic(files map[string]bool, declared any) (string, bool) {
	var cands []string
	if d, ok := declared.(string); ok && d != "" {
		if n, ok := NormalizePackPath(d); ok {
			if staticExtRe.MatchString(n) {
				cands = append(cands, n)
			} else if j, ok := JoinPackPath(n, "character.webp"); ok {
				cands = append(cands, j)
			}
		}
	}
	cands = append(cands, "static/character.webp", "static/character.png")
	for _, c := range cands {
		if files[c] {
			return c, true
		}
	}
	return "", false
}

func passes205ManifestChecks(m any) bool {
	o, ok := m.(*Obj)
	if !ok {
		return false
	}
	if f, ok := o.Get("schema").(float64); !ok || f != 1 {
		return false
	}
	id, ok := o.Get("id").(string)
	if !ok || jsTrim(id) == "" {
		return false
	}
	mode := jsGet(o.Get("assets"), "mode")
	if mode == Undef || mode == nil {
		mode = "rive"
	}
	s, ok := mode.(string)
	return ok && contains(PackModes, s)
}

var protectedManifestPaths = []string{"schema", "id", "contractVersion", "assets", "assets.mode"}

func pathStrings(path []any) []string {
	out := make([]string, len(path))
	for i, p := range path {
		switch x := p.(type) {
		case int:
			out[i] = strconv.Itoa(x)
		case string:
			out[i] = x
		}
	}
	return out
}

func isObjOrArr(v any) bool {
	switch v.(type) {
	case *Obj, []any:
		return true
	}
	return false
}

// getPath 沿路径取值（`isObj(parent) ? parent[k] : undefined`）。
func getPath(root any, p []string) any {
	cur := root
	for _, k := range p {
		if !isObjOrArr(cur) {
			return Undef
		}
		cur = jsGet(cur, k)
	}
	return cur
}

// dropAt：数组用 splice（需要替换祖先里的切片），对象 delete。
func dropAt(root *Obj, path []any) (string, bool) {
	for n := len(path); n > 0; n-- {
		p := pathStrings(path[:n])
		joined := strings.Join(p, ".")
		if contains(protectedManifestPaths, joined) {
			return "", false
		}
		parent := getPath(root, p[:n-1])
		key := p[n-1]
		if !isObjOrArr(parent) || jsGet(parent, key) == Undef {
			continue
		}
		switch x := parent.(type) {
		case *Obj:
			x.Delete(key)
		case []any:
			idx, _ := strconv.Atoi(key)
			spliced := append(append([]any{}, x[:idx]...), x[idx+1:]...)
			setPath(root, p[:n-1], spliced)
		}
		return joined, true
	}
	return "", false
}

// setPath 把 path 处的值换成 v（path 非空，父级都存在）。
func setPath(root *Obj, p []string, v any) {
	parent := getPath(root, p[:len(p)-1])
	key := p[len(p)-1]
	switch x := parent.(type) {
	case *Obj:
		x.Set(key, v)
	case []any:
		idx, _ := strconv.Atoi(key)
		x[idx] = v
	}
}

func relaxManifest(migrated *Obj, warn func(path []any, msg string)) (bool, any, []Issue, any) {
	m := Clone(migrated).(*Obj)
	var id any = Undef
	if ok, _, _ := SafeParse(packIDSchema, m.Get("id")); !ok {
		id = m.Get("id")
		m.Set("id", "lenient-pack")
		warn([]any{"id"}, fmt.Sprintf(`id "%s" is not lowercase letters, digits, - or _; accepted for this overlay`, jsToString(id)))
	}
	if layout := m.Get("layout"); isObjOrArr(layout) {
		hb := jsGet(layout, "hitboxes")
		switch h := hb.(type) {
		case *Obj:
			for _, key := range h.Keys() {
				region := h.Get(key)
				if !contains(HitboxIDs, key) {
					h.Delete(key)
					warn([]any{"layout", "hitboxes", key}, fmt.Sprintf(`unknown hitbox "%s" ignored`, key))
				} else if ok, _, _ := SafeParse(hitboxRegionSchema, region); !ok {
					h.Delete(key)
					warn([]any{"layout", "hitboxes", key}, fmt.Sprintf(`invalid hitbox region "%s" ignored`, key))
				}
			}
			if h.Len() == 0 {
				deleteKey(layout, "hitboxes")
			}
		case []any:
			// 数组的下标键都不是命中区 id：逐个删掉（留空位），最后整个删除
			for i := range h {
				key := strconv.Itoa(i)
				warn([]any{"layout", "hitboxes", key}, fmt.Sprintf(`unknown hitbox "%s" ignored`, key))
			}
			deleteKey(layout, "hitboxes")
		}
	}
	ok, data, iss := SafeParse(manifestSchema, m)
	for round := 0; !ok && round < 64; round++ {
		progressed := false
		for _, is := range iss {
			if is.Code == "unrecognized_keys" {
				ps := pathStrings(is.Path)
				parent := getPath(m, ps)
				for _, key := range is.Keys {
					if o, isO := parent.(*Obj); isO && jsIn(o, key) {
						o.Delete(key)
						full := append(append([]any{}, is.Path...), key)
						warn(full, fmt.Sprintf(`unknown field "%s" ignored`, strings.Join(pathStrings(full), ".")))
						progressed = true
					}
				}
				continue
			}
			if dropped, d := dropAt(m, is.Path); d {
				warn(is.Path, fmt.Sprintf(`invalid field "%s" ignored (%s)`, dropped, is.Message))
				progressed = true
				break
			}
		}
		if !progressed {
			break
		}
		ok, data, iss = SafeParse(manifestSchema, m)
	}
	return ok, data, iss, id
}

func deleteKey(v any, k string) {
	if o, ok := v.(*Obj); ok {
		o.Delete(k)
	}
}

func strList(v any) []string {
	arr, _ := v.([]any)
	out := []string{}
	for _, x := range arr {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// ValidatePack = validatePack。
func ValidatePack(src PackSource, opts ValidateOptions) ValidateResult {
	var errs, warns []PackIssue
	sink := func(severity, code, file, message string, path []any) {
		if severity == "error" && opts.Lenient && contains(NonStructuralIssues, code) {
			severity = "warning"
		}
		if severity == "error" && opts.Lenient && file != FileManifest && (code == "schema-invalid" || code == "json-invalid") {
			severity = "warning"
		}
		if path == nil {
			path = []any{}
		}
		is := PackIssue{severity, code, file, path, message}
		if severity == "error" {
			errs = append(errs, is)
		} else {
			warns = append(warns, is)
		}
	}
	files := map[string]bool{}
	var fileList []string
	for _, f := range src.Files {
		if n, ok := NormalizePackPath(f); ok && !files[n] {
			files[n] = true
			fileList = append(fileList, n)
		}
	}
	done := func(pack *Obj) ValidateResult {
		r := ValidateResult{OK: len(errs) == 0, Errors: errs, Warnings: warns}
		if len(errs) == 0 {
			r.Pack = pack
		}
		return r
	}

	// ── manifest
	found, rawManifest := readJSONSafe(src, FileManifest, sink)
	if !found {
		sink("error", "manifest-missing", FileManifest, "manifest.json is required", nil)
		return done(nil)
	}
	if rawManifest == Undef {
		return done(nil)
	}
	var rawAssets any = Undef
	if rawManifest != nil {
		rawAssets = jsGet(rawManifest, "assets")
	}
	var rawLayout any = Undef
	if rawAssets != nil && rawAssets != Undef {
		rawLayout = jsGet(rawAssets, "layout")
	}
	layoutDir := dirOf(rawLayout, "layout")
	legacyHitboxesFile := layoutDir + "/hitboxes.json"
	var legacyHitboxes any = Undef
	if files[legacyHitboxesFile] {
		_, legacyHitboxes = readJSONSafe(src, legacyHitboxesFile, sink)
	}

	migrated := MigrateManifest(rawManifest, legacyHitboxes)
	ok, data, iss := SafeParse(manifestSchema, migrated)
	var lenientID any = Undef
	if !ok && opts.Lenient && passes205ManifestChecks(migrated) {
		ok, data, iss, lenientID = relaxManifest(migrated.(*Obj), func(path []any, msg string) {
			sink("warning", "schema-lenient", FileManifest, msg, path)
		})
	}
	if !ok {
		zodIssues(sink, FileManifest, iss)
		return done(nil)
	}
	manifest := data.(*Obj)
	if lenientID != Undef {
		manifest = manifest.Spread()
		manifest.Set("id", lenientID)
	}
	hasHitboxes := truthy(jsGet(manifest.Get("layout"), "hitboxes"))
	if legacyHitboxes != Undef && !hasHitboxes {
		sink("warning", "layout-legacy", legacyHitboxesFile, "unrecognised legacy hitboxes file", nil)
	} else if legacyHitboxes != Undef {
		sink("warning", "layout-legacy", legacyHitboxesFile, "legacy layout/hitboxes.json — move hitboxes and bubbleAnchor into manifest.layout", nil)
	}
	cv := manifest.Get("contractVersion").(float64)
	if !IsContractVersionSupported(cv) {
		sink("error", "contract-version-unsupported", FileManifest,
			fmt.Sprintf("contractVersion %s is newer than supported %d", JSNumber(cv), ContractVersion), []any{"contractVersion"})
	}
	assets := manifest.Get("assets").(*Obj)
	mode := assets.Get("mode").(string)

	// ── onboarding
	onboardingDir := dirOf(assets.Get("onboarding"), "onboarding")
	for _, f := range OnboardingFiles {
		rel := onboardingDir + "/" + f
		if !files[rel] {
			sink("error", "onboarding-missing", rel, "missing "+rel, nil)
		}
	}

	// ── engine assets
	var rive, spriteManifest, staticRel any = nil, nil, nil
	spriteDir := dirOf(assets.Get("sprite"), "sprite")
	spriteManifestRel := spriteDir + "/manifest.json"
	if files[spriteManifestRel] {
		spriteManifest = spriteManifestRel
	}
	if mode == "static" {
		if s, ok := resolveStatic(files, assets.Get("static")); ok {
			staticRel = s
		} else {
			file := "static/character.webp"
			if s, ok := assets.Get("static").(string); ok {
				file = s
			}
			sink("error", "asset-missing", file, "static mode requires static/character.webp (or .png)", nil)
		}
	} else {
		if mode == "rive" || truthy(assets.Get("rive")) {
			decl := "rive/character.riv"
			if s, ok := assets.Get("rive").(string); ok {
				decl = s
			}
			riveRel, ok := NormalizePackPath(decl)
			if !ok {
				riveRel = "rive/character.riv"
			}
			if !files[riveRel] && remoteHas(assets, "rive") {
				// 远程素材：按需下载，本地没有不算错
				rive = riveRel
			} else if !files[riveRel] {
				code := "fallback-asset-missing"
				if mode == "rive" {
					code = "asset-missing"
				}
				sink("error", code, riveRel, "missing "+riveRel, nil)
			} else {
				rive = riveRel
				if src.SizeOf != nil {
					if size, ok := src.SizeOf(riveRel); ok && size <= minRiveBytes {
						sink("error", "asset-too-small", riveRel, fmt.Sprintf("rive file too small (%d bytes)", size), nil)
					}
				}
			}
		}
		if mode == "sprite" || truthy(assets.Get("sprite")) {
			if spriteManifest == nil {
				code := "fallback-asset-missing"
				if mode == "sprite" {
					code = "asset-missing"
				}
				sink("error", code, spriteManifestRel, "sprite/manifest.json required when sprite present", nil)
			} else {
				if !files[spriteDir+"/thumb.png"] {
					sink("warning", "sprite-thumb-recommended", spriteDir+"/thumb.png", "sprite thumb.png recommended", nil)
				}
				declared := strList(jsGet(manifest.Get("capabilities"), "spriteActions"))
				if len(declared) > 0 {
					n := 0
					for _, id := range Contract.Sprite.ActionIDs {
						if !contains(declared, id) {
							n++
						}
					}
					if n > 0 {
						sink("warning", "sprite-actions-incomplete", FileManifest,
							fmt.Sprintf("sprite capabilities omit %d contract actions (ok if intentional)", n), []any{"capabilities", "spriteActions"})
					}
				}
			}
		} else if mode == "rive" {
			sink("warning", "sprite-fallback-recommended", spriteManifestRel, "sprite/ fallback strongly recommended for rive packs", nil)
		}
	}

	// ── voice
	voiceDir := dirOf(assets.Get("voice"), "voice")
	anyVoice := false
	for _, locale := range Contract.Voice.Locales {
		dir := voiceDir + "/" + locale
		present := false
		for _, f := range fileList {
			if strings.HasPrefix(f, dir+"/") {
				present = true
				break
			}
		}
		if !present {
			continue
		}
		anyVoice = true
		manPath := dir + "/manifest.json"
		found, man := readJSONSafe(src, manPath, sink)
		if !found {
			sink("error", "voice-manifest-missing", manPath, manPath+" required when "+dir+" present", nil)
			continue
		}
		value := man
		if value == Undef || value == nil {
			value = NewObj()
		}
		idSchema := jsGet(value, "idSchema")
		if truthy(idSchema) && idSchema != "stable-v1" {
			sink("warning", "voice-id-schema", manPath, "unexpected voice idSchema: "+jsToString(idSchema), nil)
		}
		clips, _ := jsGet(value, "clips").([]any)
		have := map[string]bool{}
		for _, c := range clips {
			if c == nil {
				panic(JSThrow{"Cannot read properties of null (reading 'id')"})
			}
			if s, ok := jsGet(c, "id").(string); ok {
				have[ResolveVoiceClipID(s)] = true
			}
			if s, ok := jsGet(c, "key").(string); ok {
				have[ResolveVoiceClipID(s)] = true
			}
		}
		req := Contract.Voice.RequiredClipIDs
		var missing []string
		for _, id := range req {
			if !have[id] {
				missing = append(missing, id)
			}
		}
		if len(missing) > 0 {
			sev := "warning"
			if opts.RequireCompleteVoice {
				sev = "error"
			}
			ex := missing
			if len(ex) > 3 {
				ex = ex[:3]
			}
			sink(sev, "voice-clips-incomplete", manPath,
				fmt.Sprintf("voice missing %d/%d contract clips (e.g. %s)", len(missing), len(req), strings.Join(ex, ", ")), nil)
		}
		for _, c := range clips {
			f, ok := jsGet(c, "file").(string)
			if !ok {
				continue
			}
			rel, rok := JoinPackPath(dir, f)
			if !rok || !files[rel] {
				file := rel
				if !rok {
					file = dir + "/" + f
				}
				sink("warning", "voice-file-missing", file, "voice file missing: "+f, nil)
			}
		}
	}
	if !anyVoice {
		first := "zh"
		if len(Contract.Voice.Locales) > 0 {
			first = Contract.Voice.Locales[0]
		}
		sink("warning", "voice-not-provided", voiceDir, voiceDir+"/"+first+" not provided — prompt clips fall back to TTS / silence", nil)
	}

	// ── locales
	locales := NewObj()
	copyDir := dirOf(assets.Get("copy"), DirLegacyCopy)
	legacyCopy := map[string]any{}
	for _, locale := range CharacterLocales {
		file := DirLocales + "/" + locale + ".json"
		legacyFile := copyDir + "/" + locale + ".json"
		var raw any
		source := file
		if files[file] {
			_, raw = readJSONSafe(src, file, sink)
		} else if files[legacyFile] {
			_, legacy := readJSONSafe(src, legacyFile, sink)
			legacyCopy[locale] = legacy
			raw = MigrateLegacyCopy(legacy)
			source = legacyFile
			sink("warning", "locale-legacy", legacyFile, "legacy "+legacyFile+" — move to "+file, nil)
		} else {
			sink("warning", "locale-missing", file, file+" recommended (character copy)", nil)
			continue
		}
		if raw == Undef {
			continue
		}
		if ok, d, iss := SafeParse(characterLocaleSchema, raw); !ok {
			zodIssues(sink, source, iss)
		} else {
			locales.Set(locale, d)
		}
	}
	primaryLines, _ := jsGet(locales.Get(PrimaryLocale), "lines").(*Obj)
	for _, locale := range CharacterLocales {
		if locale == PrimaryLocale || !locales.Has(locale) {
			continue
		}
		lines, _ := jsGet(locales.Get(locale), "lines").(*Obj)
		if lines == nil {
			lines = NewObj()
		}
		var missing []string
		for _, k := range primaryLines.Keys() {
			if !jsIn(lines, k) {
				missing = append(missing, k)
			}
		}
		if len(missing) > 0 {
			ex := missing
			if len(ex) > 3 {
				ex = ex[:3]
			}
			sink("warning", "locale-key-missing", DirLocales+"/"+locale+".json",
				fmt.Sprintf("%d line(s) missing translation (e.g. %s)", len(missing), strings.Join(ex, ", ")), []any{"lines"})
		}
	}

	// ── persona
	var persona *Obj
	var personaSource any = nil
	if files[FilePersona] {
		_, raw := readJSONSafe(src, FilePersona, sink)
		if raw != Undef {
			if ok, d, iss := SafeParse(personaSchema, raw); !ok {
				zodIssues(sink, FilePersona, iss)
			} else {
				persona = d.(*Obj)
				personaSource = "persona.json"
			}
		}
	} else {
		var sp *string
		if files[FileLegacySysPrompt] && src.ReadText != nil {
			if t, ok := src.ReadText(FileLegacySysPrompt); ok {
				sp = &t
			}
		}
		lc, ok := legacyCopy[PrimaryLocale]
		if !ok {
			lc = Undef
		}
		if legacy := MigrateLegacyPersona(rawManifest, lc, sp, PrimaryLocale); legacy != nil {
			persona = legacy
			personaSource = "legacy"
			sink("warning", "persona-legacy", FilePersona, "persona derived from legacy copy/ and persona/system-prompt.md — add persona.json", nil)
		} else {
			sink("warning", "persona-missing", FilePersona, "persona.json recommended", nil)
		}
	}
	if persona != nil && len(persona.Get("greetings").([]any)) == 0 {
		sink("warning", "persona-greetings-empty", FilePersona, "persona.greetings is empty", []any{"greetings"})
	}

	// ── mapping
	var mapping *Obj
	caps := manifest.Get("capabilities")
	if files[FileMapping] {
		_, raw := readJSONSafe(src, FileMapping, sink)
		if raw != Undef {
			if ok, d, iss := SafeParse(mappingSchema, raw); !ok {
				zodIssues(sink, FileMapping, iss)
			} else if IsLegacyMapping(d, strList(jsGet(caps, "expressions"))) {
				sink("warning", "mapping-legacy", FileMapping,
					"mapping.json follows the 2.0.5 template (emotions point at motions); it is ignored "+
						"and the engine default mapping is used. Map emotions to expressions to use it.", []any{"emotions"})
			} else {
				mapping = d.(*Obj)
			}
		}
	}
	if mapping != nil {
		motions := map[string]bool{}
		for _, x := range append(strList(jsGet(caps, "riveMotions")), strList(jsGet(caps, "spriteActions"))...) {
			motions[x] = true
		}
		expressions := map[string]bool{}
		for _, x := range strList(jsGet(caps, "expressions")) {
			expressions[x] = true
		}
		vocab := map[string][]string{"emotions": SemanticEmotions, "activities": SemanticActivities, "gestures": SemanticGestures}
		for _, section := range []string{"emotions", "activities", "gestures"} {
			declared := motions
			if section == "emotions" {
				declared = expressions
			}
			sec, _ := mapping.Get(section).(*Obj)
			for _, name := range sec.Keys() {
				if !contains(vocab[section], name) {
					sink("warning", "mapping-unknown-semantic", FileMapping,
						fmt.Sprintf(`unknown %s name "%s" (ignored by runtime)`, section, name), []any{section, name})
				}
				if len(declared) == 0 {
					continue
				}
				var targets []any
				switch t := sec.Get(name).(type) {
				case []any:
					targets = t
				default:
					targets = []any{t}
				}
				for _, tv := range targets {
					t := tv.(string)
					if !declared[t] && !contains(MappingReservedTargets, t) {
						sink("warning", "mapping-target-undeclared", FileMapping,
							fmt.Sprintf(`"%s" is not declared in manifest.capabilities`, t), []any{section, name})
					}
				}
			}
		}
	}

	pack := NewObj()
	pack.Set("manifest", manifest)
	pack.Set("mode", mode)
	if l := manifest.Get("layout"); l != Undef {
		pack.Set("layout", l)
	} else {
		pack.Set("layout", NewObj())
	}
	if persona != nil {
		pack.Set("persona", persona)
	} else {
		pack.Set("persona", nil)
	}
	pack.Set("personaSource", personaSource)
	if mapping != nil {
		pack.Set("mapping", mapping)
	} else {
		pack.Set("mapping", nil)
	}
	pack.Set("locales", locales)
	a := NewObj()
	a.Set("rive", rive)
	a.Set("spriteManifest", spriteManifest)
	a.Set("static", staticRel)
	a.Set("onboardingDir", onboardingDir)
	a.Set("voiceDir", voiceDir)
	remote := []any{}
	if rive != nil && remoteHas(assets, "rive") {
		remote = append(remote, "rive")
	}
	a.Set("remote", remote)
	pack.Set("assets", a)
	return done(pack)
}

// remoteHas：manifest assets.remote 是否声明了这种素材（= TS assets.remote?.includes(kind)）
func remoteHas(assets *Obj, kind string) bool {
	arr, _ := assets.Get("remote").([]any)
	for _, v := range arr {
		if v == kind {
			return true
		}
	}
	return false
}
