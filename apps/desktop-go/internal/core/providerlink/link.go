// Package providerlink 是第三方供应商链接（docs/design/provider-link.md）：
// apps/desktop-electron/internal/core/src/gateway/providerLink.ts（纯逻辑）与 ProviderLinkService.ts（流程）的移植。
// 纯逻辑与 TS 跑同一份用例：apps/desktop-electron/internal/core/tests/fixtures/provider-link-cases.json。
package providerlink

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	gwnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Wires：四种网关协议（顺序与 TS 的 LINK_WIRES 一致）
var Wires = []string{"chat", "responses", "messages", "gemini"}

const (
	LinkMax     = 16384
	NameMax     = 64
	ModelsMax   = 200
	RedirectURI = "nomi://provider/callback"
	ClientID    = "nomi"
)

// Provider：待保存的第三方供应商（Key 明文，只在内核里）
type Provider struct {
	Name     string            `json:"name"`
	Homepage string            `json:"homepage,omitempty"`
	URLs     map[string]string `json:"urls"`
	Key      string            `json:"key"`
	Models   []string          `json:"models"`
}

// Manifest：`/.well-known/nomi-provider.json` 校验后的样子
type Manifest struct {
	Issuer                string            `json:"issuer"`
	Name                  string            `json:"name"`
	Homepage              string            `json:"homepage,omitempty"`
	URLs                  map[string]string `json:"urls"`
	Models                []string          `json:"models"`
	AuthorizationEndpoint string            `json:"authorizationEndpoint"`
	TokenEndpoint         string            `json:"tokenEndpoint"`
}

// Link：解析后的 `nomi://provider/<action>`
type Link struct {
	Kind     string    `json:"kind"`
	Provider *Provider `json:"provider,omitempty"`
	Issuer   string    `json:"issuer,omitempty"`
	State    string    `json:"state,omitempty"`
	Code     string    `json:"code,omitempty"`
	Error    string    `json:"error,omitempty"`
}

// Result 对应 TS 的 LinkResult
type Result[T any] struct {
	OK    bool   `json:"ok"`
	Value *T     `json:"value,omitempty"`
	Code  string `json:"code,omitempty"`
}

func ok[T any](v T) Result[T]           { return Result[T]{OK: true, Value: &v} }
func fail[T any](code string) Result[T] { return Result[T]{Code: code} }

func strOf(v any) string { s, _ := v.(string); return s }

// jsSpace 是 JS 正则 \s / String.prototype.trim 认的空白
func jsSpace(r rune) bool { return unicode.IsSpace(r) || r == 0xFEFF }

// CleanName：去掉控制字符、合并空白、按码点截到 max
func CleanName(raw any, max int) string {
	var b strings.Builder
	space := false
	for _, r := range strOf(raw) {
		if r <= 0x1f || (r >= 0x7f && r <= 0x9f) || jsSpace(r) {
			space = true
			continue
		}
		if space && b.Len() > 0 {
			b.WriteByte(' ')
		}
		space = false
		b.WriteRune(r)
	}
	rs := []rune(b.String())
	if len(rs) > max {
		rs = rs[:max]
	}
	return string(rs)
}

// CheckURL：https、不带用户名密码、不指向本机 / 局域网；通过时返回去掉首尾空白的原串
func CheckURL(raw any) string {
	s := strings.TrimFunc(strOf(raw), jsSpace)
	if s == "" || util.UTF16Len(s) > 2048 {
		return ""
	}
	if len(s) < 6 || !strings.EqualFold(s[:6], "https:") {
		return ""
	}
	u, err := gwnet.ParseURL(s)
	if err != nil || u.User != nil || u.Hostname() == "" {
		return ""
	}
	h := u.Hostname()
	if strings.Contains(h, ":") {
		h = "[" + h + "]"
	}
	if gwnet.IsPrivateHost(h) {
		return ""
	}
	return s
}

func originOf(u *url.URL) string { return strings.ToLower(u.Scheme) + "://" + u.Host }

// NormalizeIssuer：只能是 https 源（不带路径 / 查询 / 片段），返回规范的 origin
func NormalizeIssuer(raw any) string {
	s := CheckURL(raw)
	if s == "" {
		return ""
	}
	u, _ := gwnet.ParseURL(s)
	if (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return ""
	}
	return originOf(u)
}

var (
	keyRE   = regexp.MustCompile(`^[\x21-\x7e]{8,512}$`)
	modelRE = regexp.MustCompile(`^[\x21-\x7e]{1,128}$`)
	b64RE   = regexp.MustCompile(`^[A-Za-z0-9+/_-]+={0,2}$`)
	stateRE = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)
)

func cleanKey(raw any) string {
	k := strings.TrimFunc(strOf(raw), jsSpace)
	if keyRE.MatchString(k) {
		return k
	}
	return ""
}

func cleanModels(raw any) []string {
	out := []string{}
	list, _ := raw.([]any)
	for _, m := range list {
		id := strings.TrimFunc(strOf(m), jsSpace)
		if modelRE.MatchString(id) && !contains(out, id) {
			out = append(out, id)
		}
		if len(out) >= ModelsMax {
			break
		}
	}
	return out
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// cleanURLs：只认四种协议；有一个不合法就整体不合法（返回 nil）；allowEmpty 为 false 时至少要有一个
func cleanURLs(raw any, present, allowEmpty bool) map[string]string {
	if !present && allowEmpty {
		return map[string]string{}
	}
	o, isObj := raw.(map[string]any)
	if !isObj {
		return nil
	}
	out := map[string]string{}
	for _, w := range Wires {
		v, has := o[w]
		if !has || v == nil || v == "" {
			continue
		}
		u := CheckURL(v)
		if u == "" {
			return nil
		}
		out[w] = u
	}
	if !allowEmpty && len(out) == 0 {
		return nil
	}
	return out
}

// firstPresent：`a ?? b ?? c`（null 与缺省都跳过）
func firstPresent(o map[string]any, keys ...string) any {
	for _, k := range keys {
		if v, has := o[k]; has && v != nil {
			return v
		}
	}
	return nil
}

var cherryTypeWire = map[string]string{"anthropic": "messages", "gemini": "gemini"}

// NormalizeProvider：导入负载（Nomi 的写法，或 Cherry Studio 的 baseUrl / apiKey / type）
func NormalizeProvider(raw any) Result[Provider] {
	o, isObj := raw.(map[string]any)
	if !isObj {
		return fail[Provider]("bad_payload")
	}
	name := CleanName(o["name"], NameMax)
	if name == "" {
		return fail[Provider]("bad_name")
	}
	var urls map[string]string
	if v, has := o["urls"]; has {
		urls = cleanURLs(v, true, false)
	} else if v, has := o["baseUrl"]; has {
		if u := CheckURL(v); u != "" {
			wire := cherryTypeWire[strings.ToLower(strOf(o["type"]))]
			if wire == "" {
				wire = "chat"
			}
			urls = map[string]string{wire: u}
		}
	}
	if urls == nil {
		return fail[Provider]("bad_url")
	}
	key := cleanKey(firstPresent(o, "key", "apiKey", "api_key"))
	if key == "" {
		return fail[Provider]("bad_key")
	}
	return ok(Provider{
		Name:     name,
		Homepage: CheckURL(o["homepage"]),
		URLs:     urls,
		Key:      key,
		Models:   cleanModels(o["models"]),
	})
}

func decodeData(data string) (any, bool) {
	if !b64RE.MatchString(data) {
		return nil, false
	}
	s := strings.NewReplacer("-", "+", "_", "/").Replace(data)
	s = strings.TrimRight(s, "=")
	if len(s)%4 == 1 {
		return nil, false
	}
	b, err := base64.RawStdEncoding.DecodeString(s)
	if err != nil || !utf8.Valid(b) || strings.ContainsRune(string(b), utf8.RuneError) {
		return nil, false
	}
	var v any
	if json.Unmarshal(b, &v) != nil {
		return nil, false
	}
	return v, true
}

// ParseLink 解析 `nomi://provider/<action>?…`
func ParseLink(raw string) Result[Link] {
	if util.UTF16Len(raw) > LinkMax {
		return fail[Link]("too_long")
	}
	u, err := url.Parse(strings.TrimFunc(raw, jsSpace))
	if err != nil || !strings.EqualFold(u.Scheme, "nomi") || !strings.EqualFold(u.Host, "provider") {
		return fail[Link]("bad_link")
	}
	action := strings.ToLower(strings.Trim(u.Path, "/"))
	q := u.Query()
	if v, has := q["v"]; has && (len(v) == 0 || v[0] != "1") {
		return fail[Link]("bad_link")
	}
	switch action {
	case "import":
		// 网页没给 + 转义时，查询串里的 + 会被读成空格：换回来
		data := strings.ReplaceAll(q.Get("data"), " ", "+")
		if data == "" {
			return fail[Link]("bad_payload")
		}
		payload, good := decodeData(data)
		if !good {
			return fail[Link]("bad_payload")
		}
		p := NormalizeProvider(payload)
		if !p.OK {
			return fail[Link](p.Code)
		}
		return ok(Link{Kind: "import", Provider: p.Value})
	case "connect":
		issuer := NormalizeIssuer(q.Get("issuer"))
		if issuer == "" {
			return fail[Link]("bad_issuer")
		}
		return ok(Link{Kind: "connect", Issuer: issuer})
	case "callback":
		state := q.Get("state")
		if !stateRE.MatchString(state) {
			return fail[Link]("bad_state")
		}
		code, e := q.Get("code"), q.Get("error")
		if code == "" && e == "" {
			return fail[Link]("bad_link")
		}
		return ok(Link{Kind: "callback", State: state, Code: util.UTF16Slice0(code, 2048), Error: util.UTF16Slice0(e, 64)})
	}
	return fail[Link]("bad_link")
}

// checkEndpoint：https，主机是 issuer 的主机或它的子域名
func checkEndpoint(raw any, issuer string) string {
	s := CheckURL(raw)
	if s == "" {
		return ""
	}
	u, _ := gwnet.ParseURL(s)
	iu, _ := gwnet.ParseURL(issuer)
	host, root := strings.ToLower(u.Hostname()), strings.ToLower(iu.Hostname())
	if host == root || strings.HasSuffix(host, "."+root) {
		return s
	}
	return ""
}

// ParseManifest：`/.well-known/nomi-provider.json`
func ParseManifest(raw any, issuer string) Result[Manifest] {
	o, isObj := raw.(map[string]any)
	if !isObj {
		return fail[Manifest]("bad_manifest")
	}
	if v, has := o["version"]; has && v != float64(1) {
		return fail[Manifest]("bad_manifest")
	}
	rawURLs, hasURLs := o["urls"]
	urls := cleanURLs(rawURLs, hasURLs, true)
	if urls == nil {
		return fail[Manifest]("bad_manifest")
	}
	auth := checkEndpoint(o["authorization_endpoint"], issuer)
	tok := checkEndpoint(o["token_endpoint"], issuer)
	if auth == "" || tok == "" {
		return fail[Manifest]("bad_manifest")
	}
	name := CleanName(o["name"], NameMax)
	if name == "" {
		iu, _ := gwnet.ParseURL(issuer)
		name = iu.Hostname()
	}
	return ok(Manifest{
		Issuer:                issuer,
		Name:                  name,
		Homepage:              CheckURL(o["homepage"]),
		URLs:                  urls,
		Models:                cleanModels(o["models"]),
		AuthorizationEndpoint: auth,
		TokenEndpoint:         tok,
	})
}

// ParseTokenResponse：换 Key 的返回 → 待保存的供应商（返回里的 urls 覆盖清单里的同名协议）
func ParseTokenResponse(raw any, m Manifest) Result[Provider] {
	o, isObj := raw.(map[string]any)
	if !isObj {
		return fail[Provider]("bad_token")
	}
	key := cleanKey(firstPresent(o, "api_key", "key", "access_token"))
	if key == "" {
		return fail[Provider]("bad_token")
	}
	rawURLs, hasURLs := o["urls"]
	extra := cleanURLs(rawURLs, hasURLs, true)
	if extra == nil {
		return fail[Provider]("bad_token")
	}
	urls := map[string]string{}
	for k, v := range m.URLs {
		urls[k] = v
	}
	for k, v := range extra {
		urls[k] = v
	}
	if len(urls) == 0 {
		return fail[Provider]("bad_token")
	}
	models := m.Models
	if v, has := o["models"]; has {
		models = cleanModels(v)
	}
	name := CleanName(o["name"], NameMax)
	if name == "" {
		name = m.Name
	}
	return ok(Provider{Name: name, Homepage: m.Homepage, URLs: urls, Key: key, Models: models})
}

// EncodeURIComponent 与 JS 的 encodeURIComponent 一致（两边拼出同一个串）
func EncodeURIComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func joinQuery(pairs [][2]string) string {
	parts := make([]string, len(pairs))
	for i, p := range pairs {
		parts[i] = p[0] + "=" + EncodeURIComponent(p[1])
	}
	return strings.Join(parts, "&")
}

// AuthorizeURL：打开浏览器去授权的地址
func AuthorizeURL(m Manifest, state, challenge string) string {
	q := joinQuery([][2]string{
		{"response_type", "code"},
		{"client_id", ClientID},
		{"redirect_uri", RedirectURI},
		{"state", state},
		{"code_challenge", challenge},
		{"code_challenge_method", "S256"},
	})
	sep := "?"
	if strings.Contains(m.AuthorizationEndpoint, "?") {
		sep = "&"
	}
	return m.AuthorizationEndpoint + sep + q
}

// TokenRequestBody：换 Key 的表单
func TokenRequestBody(code, verifier string) string {
	return joinQuery([][2]string{
		{"grant_type", "authorization_code"},
		{"code", code},
		{"redirect_uri", RedirectURI},
		{"client_id", ClientID},
		{"code_verifier", verifier},
	})
}

// PKCEChallenge：S256
func PKCEChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func randB64(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// NewPKCE：一次授权的 state / verifier / challenge
func NewPKCE() (state, verifier, challenge string) {
	verifier = randB64(32)
	return randB64(16), verifier, PKCEChallenge(verifier)
}

// MaskKey：前 3 位 + … + 后 4 位（太短只留后 2 位）
func MaskKey(key string) string {
	if len(key) >= 12 {
		return key[:3] + "…" + key[len(key)-4:]
	}
	if len(key) < 2 {
		return "…" + key
	}
	return "…" + key[len(key)-2:]
}

// SameOrigin = sameOrigin：协议 + 主机 + 端口相同（不分大小写）；解析不了的不算同源
func SameOrigin(a, b string) bool {
	x, err1 := gwnet.ParseURL(strings.TrimFunc(a, jsSpace))
	y, err2 := gwnet.ParseURL(strings.TrimFunc(b, jsSpace))
	if err1 != nil || err2 != nil || x.Host == "" || y.Host == "" {
		return false
	}
	return strings.EqualFold(x.Scheme, y.Scheme) && strings.EqualFold(x.Host, y.Host)
}

// SameURL：忽略主机大小写、默认端口、末尾的 /
func SameURL(a, b string) bool {
	norm := func(s string) string {
		s = strings.TrimFunc(s, jsSpace)
		u, err := gwnet.ParseURL(s)
		if err != nil || u.Host == "" {
			return strings.TrimRight(s, "/")
		}
		q := ""
		if u.RawQuery != "" {
			q = "?" + u.RawQuery
		}
		return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host) + strings.TrimRight(u.EscapedPath(), "/") + q
	}
	return norm(a) == norm(b)
}
