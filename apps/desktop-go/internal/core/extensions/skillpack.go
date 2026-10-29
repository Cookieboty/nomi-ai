package extensions

import (
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
)

type SkillMeta struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Version     string `json:"version,omitempty"`
	License     string `json:"license,omitempty"`
	Author      string `json:"author,omitempty"`
}

type SkillError struct{ Msg string }

func (e *SkillError) Error() string { return e.Msg }

var fmRe = regexp.MustCompile(`^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$`)
var kvRe = regexp.MustCompile(`^([A-Za-z_][\w-]*)\s*:\s*(.*)$`)
var lineSplit = regexp.MustCompile(`\r?\n`)
var skillNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// unquote：.replace(/^(['"])(.*)\1$/, '$2')（RE2 无反向引用，手写）
func unquote(s string) string {
	if len(s) >= 2 && (s[0] == '"' || s[0] == '\'') && s[len(s)-1] == s[0] && !strings.ContainsAny(s[1:len(s)-1], "\n\r\u2028\u2029") {
		return s[1 : len(s)-1]
	}
	return s
}

func ParseSkillMd(text string) (SkillMeta, string, error) {
	src := strings.TrimPrefix(text, "\uFEFF")
	m := fmRe.FindStringSubmatch(src)
	if m == nil {
		return SkillMeta{}, "", &SkillError{T("electron.common.skill-md-must-start-with-a-front-matter")}
	}
	meta := map[string]string{}
	for _, line := range lineSplit.Split(m[1], -1) {
		kv := kvRe.FindStringSubmatch(deps.Trim(line))
		if kv == nil {
			continue
		}
		meta[strings.ToLower(kv[1])] = unquote(deps.Trim(kv[2]))
	}
	name := deps.Trim(meta["name"])
	desc := deps.Trim(meta["description"])
	if !ValidSkillName(name) {
		return SkillMeta{}, "", &SkillError{T("electron.common.name-may-only-use-lowercase-letters-digits-and")}
	}
	if desc == "" {
		return SkillMeta{}, "", &SkillError{T("electron.common.missing-description-one-sentence-on-when-to-use")}
	}
	return SkillMeta{Name: name, Description: deps.Slice0(desc, 1024), Version: meta["version"], License: meta["license"], Author: meta["author"]}, deps.Trim(m[2]), nil
}

func ValidSkillName(n string) bool { return skillNameRe.MatchString(n) }

var needQuote = regexp.MustCompile(`[:#'"\n]`)

func BuildSkillMd(meta SkillMeta, body string) string {
	q := func(s string) string {
		if needQuote.MatchString(s) {
			b, _ := deps.Stringify(s, "")
			return string(b)
		}
		return s
	}
	lines := []string{"name: " + meta.Name, "description: " + q(strings.ReplaceAll(meta.Description, "\n", " "))}
	if meta.Version != "" {
		lines = append(lines, "version: "+q(meta.Version))
	}
	if meta.License != "" {
		lines = append(lines, "license: "+q(meta.License))
	}
	if meta.Author != "" {
		lines = append(lines, "author: "+q(meta.Author))
	}
	return "---\n" + strings.Join(lines, "\n") + "\n---\n\n" + deps.Trim(body) + "\n"
}

var dotdotRe = regexp.MustCompile(`(^|[\\/])\.\.([\\/]|$)`)

func SafeJoin(root, rel string) (string, error) {
	bad := &SkillError{T("electron.common.only-files-inside-the-skill-folder-can-be")}
	if rel == "" || filepath.IsAbs(rel) || dotdotRe.MatchString(rel) {
		return "", bad
	}
	r, _ := filepath.Abs(root)
	abs := filepath.Join(r, rel)
	if !strings.HasPrefix(abs, r+string(filepath.Separator)) {
		return "", bad
	}
	return abs, nil
}

func SkillsContext(list []SkillMeta) string {
	if len(list) == 0 {
		return ""
	}
	out := []string{T("electron.common.available-skills"), T("electron.common.the-following-skills-can-be-used-on-demand")}
	for _, s := range list {
		out = append(out, "- "+s.Name+"："+s.Description)
	}
	return strings.Join(out, "\n")
}

func jsTrim(s string) string { return deps.Trim(s) }
