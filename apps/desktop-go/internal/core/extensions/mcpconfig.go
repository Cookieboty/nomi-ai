// Package extensions 移植 apps/desktop-electron/internal/core/src/extensions：MCP 服务器配置、技能包、从其它工具迁移与 ExtensionsService。
package extensions

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	gnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
)

// T：对应 Node `import { t } from '../i18n'`（模块级）；main.go 启动时 SetTranslator。
var T i18n.Translate = i18n.Identity

func SetTranslator(t i18n.Translate) {
	if t != nil {
		T = t
	}
}

// McpServerEntry：字段顺序 = Node sanitizeServer 的字面量顺序 + 后续赋值顺序
type McpServerEntry struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Transport string            `json:"transport"`
	Enabled   bool              `json:"enabled"`
	Trust     string            `json:"trust"`
	Origin    string            `json:"origin"`
	Command   string            `json:"command,omitempty"`
	Args      []string          `json:"args,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	URL       string            `json:"url,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
}

var idRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)
var slugBad = regexp.MustCompile(`[^a-z0-9_-]+`)
var slugEdge = regexp.MustCompile(`^-+|-+$`)
var startAlnum = regexp.MustCompile(`^[a-z0-9]`)

func SlugID(name string, taken map[string]bool) string {
	base := deps.Slice0(slugEdge.ReplaceAllString(slugBad.ReplaceAllString(strings.ToLower(name), "-"), ""), 24)
	if base == "" {
		base = "mcp"
	}
	if !startAlnum.MatchString(base) {
		base = "s" + base
	}
	id := base
	for i := 2; taken[id]; i++ {
		id = base + "-" + itoa(i)
	}
	return id
}

func itoa(i int) string { b, _ := json.Marshal(i); return string(b) }

var envKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*$`)

// strMap：保留插入顺序的意义只在 JSON 输出；Go map 按键排序输出（见 D-B8 偏差表）
func strMap(v any) map[string]string {
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]string{}
	for k, x := range m {
		if envKeyRe.MatchString(k) && x != nil {
			out[k] = deps.JSString(x)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

type McpConfigError struct{ Msg string }

func (e *McpConfigError) Error() string { return e.Msg }

var sseRe = regexp.MustCompile(`/sse/?$`)

func jsStr(v any) string {
	if v == nil {
		return ""
	}
	return deps.JSString(v)
}

func SanitizeServer(raw any, taken map[string]bool) (McpServerEntry, error) {
	o, _ := raw.(map[string]any)
	if o == nil {
		o = map[string]any{}
	}
	nv := o["name"]
	if nv == nil {
		nv = o["id"]
	}
	name := deps.TrimSlice(jsStr(nv), 60)
	if name == "" {
		return McpServerEntry{}, &McpConfigError{T("electron.common.please-enter-a-name")}
	}
	transport := "stdio"
	if o["transport"] == "http" || o["transport"] == "sse" {
		transport = o["transport"].(string)
	}
	if tr, has := o["transport"]; !has || tr == nil || tr == "" || tr == false {
		if u, ok := o["url"].(string); ok {
			if sseRe.MatchString(u) {
				transport = "sse"
			} else {
				transport = "http"
			}
		}
	}
	id := ""
	if s, ok := o["id"].(string); ok && idRe.MatchString(s) {
		id = s
	} else {
		id = SlugID(name, taken)
	}
	e := McpServerEntry{ID: id, Name: name, Transport: transport, Enabled: o["enabled"] != false, Trust: "ask", Origin: "user"}
	if o["trust"] == "auto" || o["trust"] == "read-auto" {
		e.Trust = o["trust"].(string)
	}
	if o["origin"] == "env" {
		e.Origin = "env"
	}
	if transport == "stdio" {
		command := deps.Trim(jsStr(o["command"]))
		if command == "" {
			return e, &McpConfigError{T("electron.common.local-stdio-servers-need-a-start-command")}
		}
		if strings.ContainsAny(command, "\n\r") {
			return e, &McpConfigError{T("electron.common.the-command-can-t-contain-line-breaks")}
		}
		e.Command = command
		e.Args = []string{}
		if arr, ok := o["args"].([]any); ok {
			for _, a := range arr {
				if len(e.Args) >= 64 {
					break
				}
				e.Args = append(e.Args, deps.JSString(a))
			}
		}
		e.Env = strMap(o["env"])
	} else {
		raw := deps.Trim(jsStr(o["url"]))
		u, err := gnet.ParseURL(raw)
		if err != nil || u.Scheme == "" {
			return e, &McpConfigError{T("electron.common.please-enter-a-valid-server-url-http-https")}
		}
		if u.Scheme != "http" && u.Scheme != "https" {
			return e, &McpConfigError{T("electron.common.server-urls-only-support-http-https")}
		}
		e.URL = u.String()
		e.Headers = strMap(o["headers"])
	}
	return e, nil
}

// ParseImport：支持 { "mcpServers": {...} }、{ name: {...} } 或数组
func ParseImport(text string, existing []string) ([]McpServerEntry, error) {
	j, err := deps.ParseJSONOrdered([]byte(text))
	if err != nil {
		return nil, &McpConfigError{T("electron.common.not-valid-json")}
	}
	taken := map[string]bool{}
	for _, x := range existing {
		taken[x] = true
	}
	items := []map[string]any{}
	switch v := j.(type) {
	case []any:
		for _, it := range v {
			m, _ := it.(*deps.OrderedObject)
			items = append(items, m.Map())
		}
	case *deps.OrderedObject:
		root := any(v)
		if ms, ok := v.Get("mcpServers"); ok && ms != nil {
			root = ms
		}
		if ro, ok := root.(*deps.OrderedObject); ok {
			for _, k := range ro.Keys {
				val := ro.Values[k]
				if vo, ok := val.(*deps.OrderedObject); ok {
					m := map[string]any{"name": k}
					for kk, vv := range vo.Map() {
						m[kk] = vv
					}
					items = append(items, m)
				} else if va, ok := val.([]any); ok {
					_ = va
					items = append(items, map[string]any{"name": k})
				}
			}
		}
	}
	if len(items) == 0 {
		return nil, &McpConfigError{T("electron.common.no-server-configuration-found")}
	}
	out := []McpServerEntry{}
	for _, it := range items {
		if it == nil {
			it = map[string]any{}
		}
		it["origin"], it["trust"] = "user", "ask"
		e, err := SanitizeServer(it, taken)
		if err != nil {
			return nil, err
		}
		taken[e.ID] = true
		out = append(out, e)
	}
	return out, nil
}

var secretKeyRe = regexp.MustCompile(`(?i)(key|token|secret|password|passwd|auth|cookie|credential)`)
var credURLRe = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@`)
var bearerRe = regexp.MustCompile(`(?i)^(bearer|basic)\s+\S{8,}`)
var tokPrefixRe = regexp.MustCompile(`^(sk-|ghp_|gho_|ghu_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza|ya29\.)`)
var tokCharsRe = regexp.MustCompile(`^[A-Za-z0-9_\-+=.~]+$`)
var digitRe = regexp.MustCompile(`\d`)
var alphaRe = regexp.MustCompile(`[A-Za-z]`)

func IsSecretValue(v string) bool {
	if v == "" {
		return false
	}
	if credURLRe.MatchString(v) || bearerRe.MatchString(v) || tokPrefixRe.MatchString(v) {
		return true
	}
	return deps.Len16(v) >= 32 && tokCharsRe.MatchString(v) && len(digitRe.FindAllString(v, -1)) >= 4 && alphaRe.MatchString(v)
}

func IsSecretKey(k string) bool { return secretKeyRe.MatchString(k) }

func MaskServer(e McpServerEntry) McpServerEntry {
	mask := func(m map[string]string, all bool) map[string]string {
		if m == nil {
			return nil
		}
		out := map[string]string{}
		for k, v := range m {
			if (all || IsSecretKey(k) || IsSecretValue(v)) && v != "" {
				out[k] = deps.Slice0(v, 2) + "••••••"
			} else {
				out[k] = v
			}
		}
		return out
	}
	e.Env = mask(e.Env, false)
	e.Headers = mask(e.Headers, true)
	return e
}

func MergeSecrets(next, prev map[string]string) map[string]string {
	if next == nil {
		return nil
	}
	out := map[string]string{}
	for k, v := range next {
		if strings.Contains(v, "••••••") && prev[k] != "" {
			out[k] = prev[k]
		} else {
			out[k] = v
		}
	}
	return out
}

var secretArgAssign = regexp.MustCompile(`(?is)^(-{0,2}[\w.-]*(?:key|token|secret|password|passwd|auth|cookie|credential)[\w.-]*)=(.*)$`)
var secretFlag = regexp.MustCompile(`(?i)^-{1,2}[\w.-]*(?:key|token|secret|password|passwd|auth|cookie|credential)[\w.-]*$`)
var urlLike = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)

func StripURLCredentials(raw string) string {
	u, err := gnet.ParseURL(raw)
	if err != nil {
		return raw
	}
	u.User = nil
	u.RawQuery, u.ForceQuery = "", false
	u.Fragment, u.RawFragment = "", ""
	return u.String()
}

// RedactServerForExport：作用于磁盘上的原始对象（保留未知字段与键顺序）
func RedactServerForExport(e *deps.OrderedObject, placeholder string) *deps.OrderedObject {
	out := e.Clone()
	blank := func(v any) any {
		m, ok := v.(*deps.OrderedObject)
		if !ok {
			return v
		}
		r := deps.NewOrderedObject()
		for _, k := range m.Keys {
			r.Set(k, placeholder)
		}
		return r
	}
	for _, k := range []string{"env", "headers"} {
		if v, ok := e.Get(k); ok {
			out.Set(k, blank(v))
		}
	}
	if u, ok := e.Values["url"].(string); ok {
		out.Set("url", StripURLCredentials(u))
	}
	if args, ok := e.Values["args"].([]any); ok {
		maskNext := false
		r := make([]any, len(args))
		for i, a := range args {
			arg := deps.JSString(a)
			switch {
			case maskNext:
				maskNext = false
				r[i] = placeholder
			case secretArgAssign.MatchString(arg):
				m := secretArgAssign.FindStringSubmatch(arg)
				r[i] = m[1] + "=" + placeholder
			case secretFlag.MatchString(arg):
				maskNext = true
				r[i] = arg
			case urlLike.MatchString(arg):
				r[i] = StripURLCredentials(arg)
			default:
				r[i] = arg
			}
		}
		out.Set("args", r)
	}
	return out
}

func NeedsConfirm(trust string, readOnlyHint bool) bool {
	switch trust {
	case "auto":
		return false
	case "read-auto":
		return !readOnlyHint
	}
	return true
}

type PresetServer struct {
	Transport string   `json:"transport"`
	Command   string   `json:"command,omitempty"`
	Args      []string `json:"args,omitempty"`
	URL       string   `json:"url,omitempty"`
}

type McpPreset struct {
	Key         string       `json:"key"`
	Name        string       `json:"name"`
	Description string       `json:"description"`
	Server      PresetServer `json:"server"`
	Needs       string       `json:"needs,omitempty"`
	License     string       `json:"license"`
}

var McpPresets = []McpPreset{
	{"filesystem", "electron.common.filesystem", "electron.common.read-and-write-the-folders-you-specify-official",
		PresetServer{Transport: "stdio", Command: "npx", Args: []string{"-y", "@modelcontextprotocol/server-filesystem", "{dir}"}}, "dir", "MIT"},
	{"memory", "electron.common.knowledge-graph-memory", "electron.common.store-information-as-entities-relations-official-reference-implementation",
		PresetServer{Transport: "stdio", Command: "npx", Args: []string{"-y", "@modelcontextprotocol/server-memory"}}, "", "MIT"},
	{"sequential-thinking", "electron.common.sequential-thinking", "electron.common.helps-the-model-break-down-complex-problems-official",
		PresetServer{Transport: "stdio", Command: "npx", Args: []string{"-y", "@modelcontextprotocol/server-sequential-thinking"}}, "", "MIT"},
	{"remote", "electron.common.remote-http-server", "electron.common.connect-to-a-streamable-http-sse-mcp-server",
		PresetServer{Transport: "http", URL: "https://"}, "", "—"},
}
