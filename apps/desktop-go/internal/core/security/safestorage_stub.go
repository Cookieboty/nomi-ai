//go:build !windows && !darwin

package security

// linuxSafeStorage：Linux 上 Electron 用 libsecret/kwallet 里的钥匙 + AES。
// 完整移植 Chromium OSCrypt 的 PBKDF2 派生较重；本批先提供探测与「解不了」路径，
// 迁移时 encryption=none 的 Key 仍可迁，safeStorage 密文记入 failed 列表让用户重填（偏差 D14）。
type linuxSafeStorage struct{}

func NewElectronSafeStorage() ElectronSafeStorage { return linuxSafeStorage{} }

func (linuxSafeStorage) Available() bool { return false }

func (linuxSafeStorage) Decrypt([]byte) (string, bool) { return "", false }
