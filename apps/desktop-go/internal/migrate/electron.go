// Package migrate：首次启动把 Electron 2.0.4/2.0.5 的 userData 复制进 Go 版目录，
// 并尽量把 safeStorage 密文解到 go-keyring。原目录只读不改（copy, don't move）。
package migrate

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/aichat"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/settings"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
)

const markerName = ".migrated-from-electron.json"

// Chromium / Electron 运行时目录，不复制（对齐 legacyUserData.BOOT_ENTRIES + 缓存）
var skipNames = map[string]bool{
	"Crashpad": true, "Cache": true, "Code Cache": true, "GPUCache": true,
	"DawnCache": true, "DawnGraphiteCache": true, "DawnWebGPUCache": true,
	"Dictionaries": true, "Local State": true, "Network Persistent State": true,
	"Preferences": true, "Shared Dictionary": true, "SharedStorage": true,
	"blob_storage": true, "Session Storage": true, "Service Worker": true,
	"WebStorage": true, "Cookies": true, "Cookies-journal": true,
	"TransportSecurity": true, "Network": true, "IndexedDB": true,
	".migrated-from-electron.json": true,
}

type Result struct {
	Migrated        bool     `json:"migrated"`
	Skipped         bool     `json:"skipped,omitempty"`
	From            string   `json:"from,omitempty"`
	To              string   `json:"to"`
	FilesCopied     int      `json:"filesCopied"`
	SecretsMigrated int      `json:"secretsMigrated"`
	SecretsFailed   []string `json:"secretsFailed,omitempty"`
	// SecretsPending：文件已复制、密钥（钥匙串）还没迁（D-B11-12：放到桌面角色窗口出现之后）
	SecretsPending    bool   `json:"secretsPending,omitempty"`
	ChatKeysExtracted int    `json:"chatKeysExtracted"`
	At                string `json:"at"`
}

// Run：RunFiles + RunSecrets（同步一次做完）。幂等。
func Run(goUserData string, box security.SecretBox, ss security.ElectronSafeStorage) (Result, error) {
	r, err := RunFiles(goUserData)
	if err != nil || !r.SecretsPending {
		return r, err
	}
	return RunSecrets(goUserData, box, ss), nil
}

// RunSecrets：标记里 secretsPending 时迁密钥（唯一会碰钥匙串 / 弹授权框的一步），完成后清掉标记位。
// 被拒 / 解不开的字段记入 secretsFailed、原样保留，读的一方当空（同 2.0.4 keyStore read failed）。
func RunSecrets(goUserData string, box security.SecretBox, ss security.ElectronSafeStorage) Result {
	marker := filepath.Join(goUserData, markerName)
	res := Result{To: goUserData}
	raw, err := os.ReadFile(marker)
	if err != nil {
		return res
	}
	_ = json.Unmarshal(raw, &res)
	if !res.SecretsPending {
		return res
	}
	res.SecretsMigrated, res.SecretsFailed = migrateSecrets(goUserData, box, ss)
	res.SecretsPending = false
	_ = writeMarker(marker, res)
	log.Printf("[migrate] secrets=%d failed=%v", res.SecretsMigrated, res.SecretsFailed)
	return res
}

// RunFiles：若 Go userData 尚无迁移标记且能找到 Electron 目录，则复制文件 / 抽聊天键，
// 密钥留给 RunSecrets（标记 secretsPending）。不碰钥匙串。
func RunFiles(goUserData string) (Result, error) {
	res := Result{To: goUserData, At: time.Now().UTC().Format(time.RFC3339)}
	marker := filepath.Join(goUserData, markerName)
	if raw, err := os.ReadFile(marker); err == nil {
		_ = json.Unmarshal(raw, &res)
		res.Skipped = true
		return res, nil
	}
	// 已有应用数据且不是空的 → 不覆盖（用户可能已经在用 Go 版）
	if hasAppData(goUserData) {
		res.Skipped = true
		_ = writeMarker(marker, res)
		return res, nil
	}
	from := findElectron()
	if from == "" {
		res.Skipped = true
		_ = writeMarker(marker, res)
		return res, nil
	}
	res.From = from
	n, err := copyTree(from, goUserData)
	if err != nil {
		return res, err
	}
	res.FilesCopied = n
	res.Migrated = true

	// 密钥：gateway/store.json、ai-providers.json、voice/volc-key.json、ai-chat/keys.enc → RunSecrets
	res.SecretsPending = true

	// 聊天：从 Electron Local Storage LevelDB 抽 ai-chat:* 键
	res.ChatKeysExtracted = aichat.ExtractLocalStorage(from, goUserData)

	// Q5：升级用户也默认 SVG
	st := settings.New(filepath.Join(goUserData, "settings.json"))
	_ = st.SetMascotRenderer("svg")

	_ = writeMarker(marker, res)
	log.Printf("[migrate] electron %s → %s: files=%d chatKeys=%d (secrets pending)",
		from, goUserData, res.FilesCopied, res.ChatKeysExtracted)
	return res, nil
}

func findElectron() string {
	for _, c := range hostports.ElectronUserDataCandidates() {
		if hasAppData(c) {
			return c
		}
	}
	return ""
}

func hasAppData(dir string) bool {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range ents {
		if skipNames[e.Name()] || e.Name() == "logs" {
			continue
		}
		if e.Name() == markerName {
			continue
		}
		return true
	}
	return false
}

func copyTree(src, dst string) (int, error) {
	n := 0
	err := filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // 跳过读不了的
		}
		rel, _ := filepath.Rel(src, path)
		if rel == "." {
			return nil
		}
		name := d.Name()
		// 顶层跳过名单；Local Storage 单独处理
		if filepath.Dir(rel) == "." && skipNames[name] {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if name == "Local Storage" {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		if err := copyFile(path, target); err != nil {
			return nil
		}
		n++
		return nil
	})
	return n, err
}

func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func writeMarker(path string, res Result) error {
	b, _ := json.MarshalIndent(res, "", "  ")
	return utils.WritePrivateFileAtomic(path, append(b, '\n'))
}

func migrateSecrets(root string, box security.SecretBox, ss security.ElectronSafeStorage) (int, []string) {
	ok, failed := 0, []string{}
	// 1) voice/volc-key.json: { key: "enc:..." } 或明文
	ok += migrateEncFile(filepath.Join(root, "voice", "volc-key.json"), "key", "voice:volc", box, ss, &failed)
	// 2) ai-providers.json / gateway/store.json / cli-providers/<kind>/store.json：Node 形态的密文字段
	for _, rel := range []string{"ai-providers.json", filepath.Join("gateway", "store.json")} {
		n, f := migrateProviderFile(filepath.Join(root, rel), box, ss, false)
		ok += n
		failed = append(failed, f...)
	}
	for _, kind := range gwstore.CLIKinds {
		n, f := migrateProviderFile(filepath.Join(root, "cli-providers", kind, "store.json"), box, ss, true)
		ok += n
		failed = append(failed, f...)
	}
	// 3) ai-chat/keys.enc：整包 safeStorage
	n, f := migrateKeysEnc(filepath.Join(root, "ai-chat", "keys.enc"), box, ss)
	ok += n
	failed = append(failed, f...)
	return ok, failed
}

func migrateEncFile(path, field, account string, box security.SecretBox, ss security.ElectronSafeStorage, failed *[]string) int {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return 0
	}
	v, _ := m[field].(string)
	plain, ok := decryptValue(v, "safeStorage", ss)
	if !ok {
		*failed = append(*failed, path+":"+field)
		return 0
	}
	enc, err := box.Encrypt(plain, "keyring unavailable")
	if err != nil {
		*failed = append(*failed, path+":"+field)
		return 0
	}
	m[field] = enc
	b, _ := json.MarshalIndent(m, "", "  ")
	_ = utils.WritePrivateFileAtomic(path, append(b, '\n'))
	_ = security.KeyringSet(account, plain)
	return 1
}

// Node 存储里成对出现的「密文字段 / 加密方式字段」（GatewayStore + ai-providers.json）
var encPairs = [][2]string{
	{"enc", "encryption"}, {"secret", "encryption"},
	{"tokenEnc", "tokenEncryption"}, {"privacyKeyEnc", "privacyKeyEncryption"},
}

// migrateProviderFile：把 Electron safeStorage 密文就地换成 Go safeStorage 密文（gwstore.NewCipher），
// 字段名 / encryption 取值 / 键顺序 / JSON 排版与 Node 写出的一致（D-B4d-5 消除：不再改成 "keyring"）。
// cli=true 时处理 cli-providers/<kind>/store.json 的 profiles[].keyEnc（无加密方式字段）。
// 解不开的保留原样（Node 侧同样读作 null / 按明文 base64 处理）。
func migrateProviderFile(path string, box security.SecretBox, ss security.ElectronSafeStorage, cli bool) (int, []string) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, nil
	}
	root, err := u.Parse(raw)
	if err != nil {
		return 0, nil
	}
	cipher := gwstore.NewCipher(box)
	ok, failed := 0, []string{}
	reenc := func(stored string) (string, string, bool) {
		ct, err := base64.StdEncoding.DecodeString(stored)
		if err != nil {
			return "", "", false
		}
		plain, good := ss.Decrypt(ct)
		if !good {
			return "", "", false
		}
		enc, err := cipher.Encrypt(plain)
		if err != nil {
			return "", "", false
		}
		return enc, cipher.Kind(), true
	}
	var walk func(v any)
	walk = func(v any) {
		switch t := v.(type) {
		case *u.Obj:
			for _, pr := range encPairs {
				stored, isStr := t.Get(pr[0]).(string)
				if !isStr || t.Get(pr[1]) != "safeStorage" {
					continue
				}
				if enc, kind, good := reenc(stored); good {
					t.Set(pr[0], enc)
					t.Set(pr[1], kind)
					ok++
				} else {
					failed = append(failed, path+":"+pr[0])
				}
			}
			if cli {
				if stored, isStr := t.Get("keyEnc").(string); isStr && stored != "" {
					// 钥匙串不可用时 cipher 是 'none'：enc = base64(明文)，legacyCliKeyDecryptor 照样读
					if enc, _, good := reenc(stored); good {
						t.Set("keyEnc", enc)
						ok++
					}
					// 解不开：旧版本也可能是明文 base64，原样留给 legacyCliKeyDecryptor
				}
			}
			for _, k := range t.Keys() {
				walk(t.Get(k))
			}
		case []any:
			for _, c := range t {
				walk(c)
			}
		}
	}
	walk(root)
	if ok > 0 {
		out := u.StringifyIndent(root, "  ")
		if strings.HasSuffix(string(raw), "\n") {
			out += "\n"
		}
		_ = utils.WritePrivateFileAtomic(path, []byte(out))
	}
	return ok, failed
}

func decryptValue(stored, kind string, ss security.ElectronSafeStorage) (string, bool) {
	if stored == "" {
		return "", false
	}
	// enc: 前缀（SecretBox 风格）
	if strings.HasPrefix(stored, "enc:") {
		b64 := stored[4:]
		raw, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			return "", false
		}
		if plain, ok := ss.Decrypt(raw); ok {
			return plain, true
		}
		// 可能已是 keyring id 或旧明文包在 base64 里——试 utf8
		return string(raw), true
	}
	switch kind {
	case "none", "":
		// plaintextCipher：base64(utf8)
		if b, err := base64.StdEncoding.DecodeString(stored); err == nil {
			return string(b), true
		}
		return stored, true
	case "safeStorage":
		raw, err := base64.StdEncoding.DecodeString(stored)
		if err != nil {
			return "", false
		}
		return ss.Decrypt(raw)
	case "keyring":
		id := stored
		if b, err := base64.StdEncoding.DecodeString(stored); err == nil {
			id = string(b)
		}
		p, err := security.KeyringGet(id)
		return p, err == nil
	default:
		return "", false
	}
}

func migrateKeysEnc(path string, box security.SecretBox, ss security.ElectronSafeStorage) (int, []string) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, nil
	}
	var file struct {
		Version int    `json:"version"`
		Payload string `json:"payload"`
	}
	if json.Unmarshal(raw, &file) != nil || file.Version != 1 {
		return 0, []string{path}
	}
	cipher, err := base64.StdEncoding.DecodeString(file.Payload)
	if err != nil {
		return 0, []string{path}
	}
	plain, ok := ss.Decrypt(cipher)
	if !ok {
		return 0, []string{path}
	}
	var entries map[string]string
	if json.Unmarshal([]byte(plain), &entries) != nil {
		return 0, []string{path}
	}
	n := 0
	out := map[string]string{}
	for id, secret := range entries {
		enc, err := box.Encrypt(secret, "keyring unavailable")
		if err != nil {
			return n, []string{path + ":" + id}
		}
		out[id] = enc
		n++
	}
	// 改存为明文 JSON 包一层（各 value 已是 SecretBox 的 enc: 密文）；不再依赖 safeStorage 整包
	b, _ := json.MarshalIndent(map[string]any{"version": 2, "entries": out}, "", "  ")
	_ = utils.WritePrivateFileAtomic(path, append(b, '\n'))
	return n, nil
}

func short(s string) string {
	if len(s) > 16 {
		return s[:16]
	}
	return s
}

func readMarker(goUserData string) Result {
	var res Result
	if raw, err := os.ReadFile(filepath.Join(goUserData, markerName)); err == nil {
		_ = json.Unmarshal(raw, &res)
	}
	return res
}
