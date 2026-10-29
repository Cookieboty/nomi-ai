package charcontract

import (
	"regexp"
	"strings"
)

// 与 copy.ts 对应。persona / locales 为 validatePack 输出的 JS 形状（*Obj）。

var localeSplitRe = regexp.MustCompile(`[-_]`)

func baseLocale(locale string) string {
	return localeSplitRe.Split(strings.ToLower(locale), -1)[0]
}

// ResolvePersona = resolvePersona。
func ResolvePersona(persona *Obj, locales *Obj, locale string) *Obj {
	override, ok := jsGet(locales.Get(baseLocale(locale)), "persona").(*Obj)
	if !ok {
		return persona
	}
	merged := persona.Spread()
	for _, k := range override.Keys() {
		if v := override.Get(k); v != Undef {
			merged.Set(k, v)
		}
	}
	if truthy(override.Get("displayName")) && !truthy(override.Get("shortName")) && truthy(persona.Get("shortName")) {
		merged.Set("shortName", override.Get("displayName"))
	}
	return merged
}

func strOr(v any) string { s, _ := v.(string); return s }

// PersonaNames = personaNames；override 可为 nil。
func PersonaNames(displayName, shortName string, override *Obj) (string, string) {
	od, os := "", ""
	if override != nil {
		od, os = strOr(override.Get("displayName")), strOr(override.Get("shortName"))
	}
	dn := od
	if dn == "" {
		dn = displayName
	}
	sn := os
	if sn == "" && od == "" {
		sn = shortName
	}
	if sn == "" {
		sn = dn
	}
	return dn, sn
}

var DefaultPronoun = map[string]string{"zh": "它", "en": "it"}

// PersonaPronoun = personaPronoun。
func PersonaPronoun(lang, own string) string {
	if v := jsTrim(own); v != "" {
		return v
	}
	if p, ok := DefaultPronoun[baseLocale(lang)]; ok {
		return p
	}
	return DefaultPronoun["en"]
}

var enForms = map[string][2]string{"she": {"her", "her"}, "he": {"him", "his"}, "it": {"it", "its"}, "they": {"them", "their"}}

// PronounForms = pronounForms → (object, possessive)。
func PronounForms(lang, pronoun string) (string, string) {
	if baseLocale(lang) == "zh" {
		return pronoun, pronoun
	}
	if f, ok := enForms[strings.ToLower(pronoun)]; ok {
		return f[0], f[1]
	}
	return pronoun, pronoun + "’s"
}

// ResolveLine = resolveLine。
func ResolveLine(locales *Obj, key, locale string) (string, bool) {
	ids := []string{key, ResolveVoiceClipID(key)}
	for _, lang := range []string{baseLocale(locale), PrimaryLocale} {
		lines, ok := jsGet(locales.Get(lang), "lines").(*Obj)
		if !ok {
			continue
		}
		for _, id := range ids {
			if v, ok := lines.Get(id).(string); ok && v != "" {
				return v, true
			}
		}
	}
	return "", false
}
