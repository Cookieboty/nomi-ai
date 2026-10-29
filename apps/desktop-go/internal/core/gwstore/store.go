package gwstore

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/text/unicode/norm"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// DefaultGatewayPort = DEFAULT_GATEWAY_PORT
const DefaultGatewayPort = 18721

// Logger 同 Node 的 { info, warn }
type Logger interface {
	Info(msg string, d any)
	Warn(msg string, d any)
}

// 可替换的时钟 / 随机源（golden 测试固定它们，对应录制脚本里替换 Date.now / randomUUID / randomBytes）
var (
	Now        = func() float64 { return float64(time.Now().UnixMilli()) }
	RandomUUID = func() string {
		var b [16]byte
		_, _ = rand.Read(b[:])
		b[6] = b[6]&0x0f | 0x40
		b[8] = b[8]&0x3f | 0x80
		h := hex.EncodeToString(b[:])
		return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
	}
	RandomBytes = func(n int) []byte {
		b := make([]byte, n)
		_, _ = rand.Read(b)
		return b
	}
)

func empty() *u.Obj {
	return u.NewObj(
		"version", 1.0,
		"providers", []any{},
		"clients", u.NewObj(),
		"learned", u.NewObj(),
		"allowedPrivateHosts", []any{},
		"port", float64(DefaultGatewayPort),
	)
}

// MaskKey = maskKey（按 UTF-16 单元，同 JS slice / length）
func MaskKey(key string) string {
	n := u.UTF16Len(key)
	if n <= 8 {
		r := n - 2
		if r < 2 {
			r = 2
		}
		return strings.Repeat("•", r) + u.UTF16Tail(key, 2)
	}
	return u.UTF16Slice0(key, 3) + "…" + u.UTF16Tail(key, 4)
}

// NewClientToken = newClientToken
func NewClientToken(client string) string {
	return "nomi-gw-" + client + "-" + base64.RawURLEncoding.EncodeToString(RandomBytes(32))
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

// ProviderSlug = providerSlug
func ProviderSlug(name string) string {
	s := norm.NFKD.String(u.JSLower(name))
	s = nonSlug.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > 32 { // 只剩 ASCII：字节 = UTF-16 单元
		s = s[:32]
	}
	if s == "" {
		return "provider"
	}
	return s
}

// Store = GatewayStore（数据保持为有序 JSON 对象，落盘与 JSON.stringify(data, null, 2) 逐字节一致）
type Store struct {
	file           string
	cipher         Cipher
	logger         Logger
	data           *u.Obj
	ephemeralPrivK string
	preset         PresetDeps
}

// NewStore = new GatewayStore({ file, cipher, logger })
func NewStore(file string, cipher Cipher, logger Logger) *Store {
	if cipher == nil {
		cipher = providers.PlaintextCipher
	}
	s := &Store{file: file, cipher: cipher, logger: logger}
	s.data = s.load()
	return s
}

func (s *Store) File() string { return s.file }

func (s *Store) Exists() bool {
	_, err := os.Stat(s.file)
	return err == nil
}

func (s *Store) warn(m string, d any) {
	if s.logger != nil {
		s.logger.Warn(m, d)
	}
}

func (s *Store) load() *u.Obj {
	raw, err := os.ReadFile(s.file)
	if err != nil {
		return empty()
	}
	v, perr := u.Parse(raw)
	j, isObj := v.(*u.Obj)
	if perr == nil && isObj {
		if ver, ok := j.Get("version").(float64); ok && ver == 1 {
			out := empty()
			for _, k := range j.Keys() {
				out.Set(k, j.Get(k))
			}
			return out
		}
	}
	// JSON.parse 失败 / 非对象 / 版本不对：改名为 .corrupt-<ts>，用空存储（null 读 version 也会抛）
	bad := fmt.Sprintf("%s.corrupt-%s", s.file, u.FormatNumber(Now()))
	_ = os.Rename(s.file, bad)
	s.warn("gateway store unreadable, moved aside", map[string]any{"bad": bad})
	return empty()
}

// Save = save()
func (s *Store) Save() error {
	if err := os.MkdirAll(filepath.Dir(s.file), 0o755); err != nil {
		return err
	}
	return utils.WritePrivateFileAtomic(s.file, []byte(u.StringifyIndent(s.data, "  ")))
}

// Snapshot = structuredClone(data)
func (s *Store) Snapshot() *u.Obj { return deepClone(s.data).(*u.Obj) }

// Replace = replace(data)
func (s *Store) Replace(d *u.Obj) { s.data = d }

func deepClone(v any) any {
	switch t := v.(type) {
	case *u.Obj:
		o := u.NewObj()
		for _, k := range t.Keys() {
			raw, _ := t.Lookup(k)
			o.Set(k, deepClone(raw))
		}
		return o
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = deepClone(x)
		}
		return out
	}
	return v
}

/* ------------------------------ 加解密 ------------------------------ */

// Encrypt = encrypt(plain) → { enc, encryption }
func (s *Store) Encrypt(plain string) (enc, encryption string) {
	e, err := s.cipher.Encrypt(plain)
	if err != nil {
		// Node 的 safeStorage.encryptString 抛错会冒泡；Go 钥匙串运行中失效时退回明文 base64（同 'none'）
		e, _ = providers.PlaintextCipher.Encrypt(plain)
		return e, "none"
	}
	return e, s.cipher.Kind()
}

// Decrypt = decrypt(enc, encryption)：读不出 → ok=false（Node 的 null）
func (s *Store) Decrypt(enc, encryption any) (string, bool) {
	es, ok := enc.(string)
	if !ok {
		return "", false
	}
	kind, _ := encryption.(string)
	switch {
	case kind == s.cipher.Kind():
		p, err := s.cipher.Decrypt(es)
		if err != nil {
			return "", false
		}
		return p, true
	case kind == "none":
		return providers.NodeBase64Decode(es), true
	case kind == "keyring":
		return keyringCompat(es)
	}
	return "", false
}

func truthyDecrypt(s *Store, enc, kind any) bool {
	if !u.Truthy(enc) {
		return false
	}
	p, ok := s.Decrypt(enc, kind)
	return ok && p != ""
}

// KeyOpts：makeKey 的 { name?, wire? }
type KeyOpts struct{ Name, Wire string }

// MakeKey = makeKey(plain, o)
func (s *Store) MakeKey(plain string, o KeyOpts) *u.Obj {
	k := u.NewObj("id", "k-"+RandomUUID()[:8])
	if o.Name != "" {
		k.Set("name", o.Name)
	}
	enc, kind := s.Encrypt(plain)
	k.Set("enc", enc).Set("encryption", kind).Set("masked", MaskKey(plain))
	if o.Wire != "" {
		k.Set("wire", o.Wire)
	}
	k.Set("enabled", true)
	return k
}

/* ------------------------------ 客户端 ------------------------------ */

func (s *Store) clients() *u.Obj {
	c, ok := s.data.Get("clients").(*u.Obj)
	if !ok {
		c = u.NewObj()
		s.data.Set("clients", c)
	}
	return c
}

func spreadClient(c any) *u.Obj {
	if o, ok := c.(*u.Obj); ok {
		return deepClone(o).(*u.Obj)
	}
	return u.NewObj("models", u.NewObj())
}

// EnsureClients = ensureClients()
func (s *Store) EnsureClients() bool {
	changed := false
	cs := s.clients()
	for _, id := range config.ClientIDs {
		c, _ := cs.Get(id).(*u.Obj)
		if c != nil && truthyDecrypt(s, c.Get("tokenEnc"), c.Get("tokenEncryption")) {
			continue
		}
		enc, kind := s.Encrypt(NewClientToken(id))
		n := spreadClient(cs.Get(id))
		n.Set("tokenEnc", enc).Set("tokenEncryption", kind)
		cs.Set(id, n)
		changed = true
	}
	return changed
}

// EnsurePrivacyKey = ensurePrivacyKey()
func (s *Store) EnsurePrivacyKey() bool {
	d := s.data
	if u.Truthy(d.Get("privacyKeyEnc")) && u.Truthy(d.Get("privacyKeyEncryption")) &&
		truthyDecrypt(s, d.Get("privacyKeyEnc"), d.Get("privacyKeyEncryption")) {
		return false
	}
	enc, kind := s.Encrypt(hex.EncodeToString(RandomBytes(32)))
	d.Set("privacyKeyEnc", enc)
	d.Set("privacyKeyEncryption", kind)
	return true
}

// PrivacyKey = privacyKey()
func (s *Store) PrivacyKey() string {
	d := s.data
	if u.Truthy(d.Get("privacyKeyEnc")) && u.Truthy(d.Get("privacyKeyEncryption")) {
		if p, ok := s.Decrypt(d.Get("privacyKeyEnc"), d.Get("privacyKeyEncryption")); ok {
			return p
		}
	}
	if s.ephemeralPrivK == "" {
		s.ephemeralPrivK = hex.EncodeToString(RandomBytes(32))
	}
	return s.ephemeralPrivK
}

// Port = port()
func (s *Store) Port() float64 {
	p, _ := s.data.Get("port").(float64)
	return p
}

// ClientToken = clientToken(id)：没有 / 读不出 → ok=false
func (s *Store) ClientToken(id string) (string, bool) {
	c, _ := s.clients().Get(id).(*u.Obj)
	if c == nil {
		return "", false
	}
	return s.Decrypt(c.Get("tokenEnc"), c.Get("tokenEncryption"))
}

// ResetToken = resetToken(id)
func (s *Store) ResetToken(id string) {
	enc, kind := s.Encrypt(NewClientToken(id))
	cs := s.clients()
	n := spreadClient(cs.Get(id))
	n.Set("tokenEnc", enc).Set("tokenEncryption", kind)
	cs.Set(id, n)
}

// ClientPatch：setClient 的 patch。Models 的值 nil / "" = 清除；AccountID: Unset=不变，Clear=清除，否则指定
type ClientPatch struct {
	Models       *u.Obj
	NewTabSource string
	AccountSet   bool
	AccountID    string // AccountSet && "" = null（清除）
}

// SetClient = setClient(id, patch)
func (s *Store) SetClient(id string, p ClientPatch) error {
	cs := s.clients()
	c, ok := cs.Get(id).(*u.Obj)
	if !ok {
		return fmt.Errorf("unknown client %s", id)
	}
	n := deepClone(c).(*u.Obj)
	if p.Models != nil {
		merged := u.NewObj()
		if m, ok := c.Get("models").(*u.Obj); ok {
			for _, k := range m.Keys() {
				merged.Set(k, m.Get(k))
			}
		}
		for _, k := range p.Models.Keys() {
			merged.Set(k, p.Models.Get(k))
		}
		out := u.NewObj()
		for _, k := range merged.Keys() {
			v := merged.Get(k)
			if v == nil || v == "" {
				continue
			}
			out.Set(k, v)
		}
		n.Set("models", out)
	}
	if p.NewTabSource != "" {
		n.Set("newTabSource", p.NewTabSource)
	}
	if p.AccountSet {
		if p.AccountID != "" {
			n.Set("newTabAccountId", p.AccountID)
		} else {
			n.Set("newTabAccountId", u.Undefined)
		}
	}
	cs.Set(id, n)
	return nil
}

/* ------------------------------ 供应商 ------------------------------ */

// Providers = providers()（活引用）
func (s *Store) Providers() []any {
	a, _ := s.data.Get("providers").([]any)
	return a
}

// UniqueProviderID = uniqueProviderId(base)
func (s *Store) UniqueProviderID(base string) string {
	taken := map[string]bool{}
	for _, p := range s.Providers() {
		o, ok := p.(*u.Obj)
		if !ok {
			continue
		}
		taken[u.JSString(o.Get("id"))] = true
		if al, ok := o.Get("aliases").([]any); ok {
			for _, a := range al {
				taken[u.JSString(a)] = true
			}
		}
	}
	id := ProviderSlug(base)
	for n := 2; taken[id]; n++ {
		id = fmt.Sprintf("%s-%d", ProviderSlug(base), n)
	}
	return id
}

// UpsertProvider = upsertProvider(p)
func (s *Store) UpsertProvider(p *u.Obj) {
	next := deepClone(p).(*u.Obj)
	next.Set("updatedAt", Now())
	list := s.Providers()
	for i, x := range list {
		if o, ok := x.(*u.Obj); ok && jsEq(o.Get("id"), p.Get("id")) {
			list[i] = next
			return
		}
	}
	s.data.Set("providers", append(list, next))
}

// RemoveProvider = removeProvider(id)
func (s *Store) RemoveProvider(id string) {
	out := []any{}
	for _, x := range s.Providers() {
		if o, ok := x.(*u.Obj); ok && o.Get("id") == id {
			continue
		}
		out = append(out, x)
	}
	s.data.Set("providers", out)
	if l, ok := s.data.Get("learned").(*u.Obj); ok {
		l.Delete(id)
	}
}

// SetLearned = setLearned(providerId, learned)
func (s *Store) SetLearned(providerID string, learned any) {
	l, ok := s.data.Get("learned").(*u.Obj)
	if !ok {
		l = u.NewObj()
		s.data.Set("learned", l)
	}
	l.Set(providerID, learned)
}

// jsEq：=== （JSON 值）
func jsEq(a, b any) bool {
	switch x := a.(type) {
	case string:
		y, ok := b.(string)
		return ok && x == y
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case nil:
		return b == nil
	}
	return false
}
