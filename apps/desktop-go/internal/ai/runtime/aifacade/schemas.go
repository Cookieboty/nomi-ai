package aifacade

import "regexp"

// 契约 packages/contract/src/app/ai.ts + schemas.ts 的入参 / 出参，
// 与 bundle-ig-base UserProfileSchema.ts 的严格 userProfileSchema。

func strMax(n int) *StrS { s := Str(); s.Max = n; return s }

func numRange(min, max float64) *NumS { return &NumS{Min: fp(min), Max: fp(max)} }

func intNonneg() *NumS { return &NumS{Int: true, Min: fp(0)} }

func arrMax(el Schema, n int) *ArrS { a := Arr(el); a.Max = n; return a }

var (
	str  = Str()
	num  = Num()
	sObj = func(kv ...any) *ObjS { return ObjOf('s', kv...) }

	semanticName = &StrS{Min: -1, Max: -1, Re: regexp.MustCompile(`^[a-z][a-zA-Z]{0,31}$`),
		ReSrc: "/^[a-z][a-zA-Z]{0,31}$/", ReMsg: "semantic name (camelCase), not a clip / motion id"}

	idIn = sObj("id", str)

	sessionMeta        = RecordS{Union(str, num, Bool)}
	createSessionInput = sObj("title", Opt(str), "agentPreset", Opt(str), "meta", Opt(sessionMeta))

	storedSession = sObj("id", str, "title", str, "createdAt", num, "updatedAt", num,
		"agentPreset", Opt(str), "meta", Opt(RecordS{Unknown}))

	memoryFactKinds   = []string{"preference", "identity", "goal", "dislike", "habit", "note"}
	memoryFactSources = []string{"user", "inferred", "distilled", "system"}
	memoryFact        = sObj("id", str, "kind", Enum(memoryFactKinds...), "text", str,
		"source", Enum(memoryFactSources...), "at", num, "confidence", Opt(num))
	storedMemoryFact = sObj("id", str, "kind", storedEnum(memoryFactKinds...), "text", str,
		"source", storedEnum(memoryFactSources...), "at", num, "confidence", Opt(num))
	sessionSummary = sObj("sessionId", str, "summary", str, "updatedAt", num, "stepCount", num)

	toolSpec = sObj("name", str, "description", str, "parametersJsonSchema", Unknown,
		"dangerous", Opt(Bool), "enabled", Opt(Bool))

	profilePatch = sObj("patch", RecordS{Unknown}, "source", Enum("user", "inferred", "distilled"), "reason", Opt(str))

	pcmChunk   = sObj("sampleRate", Lit(16000.0), "bitDepth", Lit(16.0), "channels", Lit(1.0), "data", Bytes)
	asrOptions = sObj("providerId", Opt(str), "language", Opt(str), "prompt", Opt(str))
	ttsOptions = sObj("providerId", Opt(str), "voiceId", Opt(str), "language", Opt(str),
		"rate", Opt(num), "pitch", Opt(num), "volume", Opt(num),
		"format", Opt(Enum("mp3", "wav", "ogg")), "reqId", Opt(str))
	ttsIn = sObj("text", str, "opts", Opt(ttsOptions))

	hitbox = Enum("head", "face", "body", "hand", "hem", "legs", "any")
	report = discS{Key: "type", Vals: []string{"touched", "clicked", "scene"}, Opts: []Schema{
		sObj("type", Lit("touched"), "hitbox", hitbox),
		sObj("type", Lit("clicked"), "hitbox", hitbox, "double", Opt(Bool)),
		sObj("type", Lit("scene"), "characterId", &StrS{Min: 1, Max: 64},
			"emotions", arrMax(semanticName, 64), "activities", arrMax(semanticName, 64),
			"gestures", arrMax(semanticName, 128)),
	}}

	// 出参 UserProfile（契约侧宽松版）
	outPV = func(v Schema) Schema {
		return sObj("value", v, "source", storedEnum(), "updatedAt", num, "confidence", Opt(num))
	}
	userProfileOut = ObjOf('L',
		"version", num,
		"identity", sObj("displayName", Opt(str), "nickname", Opt(str), "timezone", Opt(str), "locale", Opt(str)),
		"preferences", sObj(
			"replyLanguage", Opt(outPV(str)),
			"replyStyle", Opt(outPV(storedEnum())),
			"tone", Opt(outPV(storedEnum())),
			"codeStyle", Opt(sObj("language", Opt(Arr(str)), "framework", Opt(Arr(str)),
				"indent", Opt(Union(Lit("tab"), Lit(2.0), Lit(4.0), str, num)),
				"quotes", Opt(storedEnum()), "packageManager", Opt(storedEnum()), "comments", Opt(storedEnum()))),
			"ttsVoiceId", Opt(outPV(str)),
			"autoAcceptTools", Opt(Arr(str)),
			"privacy", Opt(sObj("allowScreenCapture", Opt(Bool), "allowClipboardRead", Opt(Bool), "allowFileWrite", Opt(Bool)))),
		"habits", sObj("activeHours", Opt(Arr(num)), "avgSessionLen", Opt(num), "stopGenerationRate", Opt(num),
			"regenRate", Opt(num), "topTools", Opt(Arr(sObj("tool", str, "count", num))),
			"topTopics", Opt(Arr(sObj("topic", str, "count", num))), "updatedAt", Opt(num)),
		"dislikes", Arr(str),
		"createdAt", num, "updatedAt", num)
)

// storedEnum：union([enum, string])——持久化值容忍未知枚举
func storedEnum(vals ...string) Schema {
	if len(vals) == 0 {
		vals = []string{"_"}
	}
	return Union(Enum(vals...), str)
}

// 严格 userProfileSchema（bundle-ig-base）
var userProfileStrict Schema = func() Schema {
	st := func(kv ...any) *ObjS { return ObjOf('S', kv...) }
	pv := func(v Schema) Schema {
		return st("value", v, "source", Enum("user", "inferred", "distilled"), "updatedAt", intNonneg(),
			"confidence", Opt(numRange(0, 1)))
	}
	hours := Arr(intNonneg())
	hours.Length = 24
	return st(
		"version", Lit(1.0),
		"identity", st("displayName", Opt(strMax(64)), "nickname", Opt(strMax(64)), "timezone", Opt(strMax(64)), "locale", Opt(strMax(16))),
		"preferences", st(
			"replyLanguage", Opt(pv(strMax(16))),
			"replyStyle", Opt(pv(Enum("concise", "detailed", "bullet", "stepwise"))),
			"tone", Opt(pv(Enum("formal", "casual", "cute", "strict"))),
			"codeStyle", Opt(st(
				"language", Opt(arrMax(strMax(32), 16)), "framework", Opt(arrMax(strMax(32), 16)),
				"indent", Opt(Union(Lit("tab"), Lit(2.0), Lit(4.0))),
				"quotes", Opt(Enum("single", "double")),
				"packageManager", Opt(Enum("npm", "pnpm", "yarn", "bun")),
				"comments", Opt(Enum("minimal", "verbose")))),
			"ttsVoiceId", Opt(pv(strMax(128))),
			"autoAcceptTools", Opt(arrMax(strMax(64), 64)),
			"privacy", Opt(st("allowScreenCapture", Opt(Bool), "allowClipboardRead", Opt(Bool), "allowFileWrite", Opt(Bool)))),
		"habits", st(
			"activeHours", Opt(hours),
			"avgSessionLen", Opt(&NumS{Min: fp(0)}),
			"stopGenerationRate", Opt(numRange(0, 1)),
			"regenRate", Opt(numRange(0, 1)),
			"topTools", Opt(arrMax(st("tool", str, "count", intNonneg()), 64)),
			"topTopics", Opt(arrMax(st("topic", str, "count", intNonneg()), 64)),
			"updatedAt", Opt(intNonneg())),
		"dislikes", arrMax(strMax(64), 128),
		"createdAt", intNonneg(), "updatedAt", intNonneg())
}()
