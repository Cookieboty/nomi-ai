package gwstore

import (
	"log"
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Legacy = GatewayServiceDeps.legacy 里存储相关的部分
type Legacy struct {
	NomiFile   string
	CliRoot    string
	CliDecrypt func(enc string) string
}

// Service：GatewayService 的存储部分（init 的迁移 → 规范 → 令牌 → 保存 → 归档）。
// runtimeConfig / 拉起网关进程随批 5 的 GatewayService 一起接（偏差 D-B4d-5 说明）。
type Service struct {
	Store  *Store
	cipher Cipher
	logger Logger
	legacy *Legacy
	rt     *runtimeState
}

// NewService：root = userData/gateway，同 Node `file: path.join(root, 'store.json')`
func NewService(root string, cipher Cipher, logger Logger, legacy *Legacy) *Service {
	if logger == nil {
		logger = stdLogger{}
	}
	return &Service{Store: NewStore(filepath.Join(root, "store.json"), cipher, logger), cipher: cipher, logger: logger, legacy: legacy}
}

// NewServiceForUserData：Node createCore 的接法（nomiFile / cli-providers / legacyCliKeyDecryptor）
func NewServiceForUserData(userData string, cipher Cipher, logger Logger) *Service {
	return NewService(filepath.Join(userData, "gateway"), cipher, logger, &Legacy{
		NomiFile:   filepath.Join(userData, "ai-providers.json"),
		CliRoot:    filepath.Join(userData, "cli-providers"),
		CliDecrypt: LegacyCliKeyDecryptor(cipher),
	})
}

func (s *Service) sources() LegacySources {
	return LegacySources{NomiFile: s.legacy.NomiFile, CliRoot: s.legacy.CliRoot, NomiCipher: s.Store.cipher, CliDecrypt: s.legacy.CliDecrypt}
}

// InitAfterMigration（D-B11-12）：2.0.4 密钥迁移（后台）完成后调用 —— 持写锁重新读盘再 Init，
// 避免启动早期读到的旧密文被 EnsurePrivacyKey 当成坏 key 重新生成（数据丢失）。
func (s *Service) InitAfterMigration(reload bool) error {
	if s.rt != nil {
		s.lock()
		defer s.unlock()
	}
	if reload {
		s.Store.Reload()
	}
	return s.Init()
}

// Init = GatewayService.init() 的存储部分
func (s *Service) Init() error {
	if !s.Store.Exists() && s.legacy != nil {
		if _, err := MigrateLegacy(s.Store, s.sources(), s.logger); err != nil && s.logger != nil {
			// 迁移失败不阻塞启动：保留空存储，旧文件原样
			s.logger.Warn("gateway migration failed", err.Error())
		}
	}
	normalized := s.normalizeCliAssignments()
	keyed := s.Store.EnsurePrivacyKey()
	var err error
	if s.Store.EnsureClients() || keyed || normalized || !s.Store.Exists() {
		err = s.Store.Save()
	}
	s.archiveLeftoverLegacy()
	return err
}

func (s *Service) normalizeCliAssignments() bool {
	data := s.Store.Snapshot()
	changed := false
	cs := asObj(data.Get("clients"))
	for _, id := range config.ClientIDs {
		if id == "nomi" || cs == nil {
			continue
		}
		c := asObj(cs.Get(id))
		if c == nil {
			continue
		}
		main := ""
		if m, ok := asObj(c.Get("models")).Get("main").(string); ok {
			main = u.JSTrim(m)
		}
		src := c.Get("newTabSource")
		if main != "" && src != "thirdParty" {
			c.Set("newTabSource", "thirdParty")
			c.Set("newTabAccountId", u.Undefined)
			changed = true
		} else if main == "" && src == "thirdParty" {
			c.Set("newTabSource", "official")
			changed = true
		}
	}
	if changed {
		s.Store.Replace(data)
	}
	return changed
}

func (s *Service) archiveLeftoverLegacy() {
	if s.legacy == nil {
		return
	}
	snap := s.Store.Snapshot()
	if !u.Truthy(snap.Get("migratedFrom")) && len(s.Store.Providers()) == 0 {
		return
	}
	left := []string{}
	for _, f := range LegacyFileCandidates(s.sources()) {
		if exists(f) {
			left = append(left, f)
		}
	}
	if len(left) == 0 {
		return
	}
	ArchiveLegacyFiles(left, s.logger)
}

// stdLogger：未注入 logger 时（createCore 总会传 logger）写标准日志
type stdLogger struct{}

func (stdLogger) Info(msg string, d any) { log.Printf("[gateway] %s %v", msg, d) }
func (stdLogger) Warn(msg string, d any) { log.Printf("[gateway] WARN %s %v", msg, d) }
