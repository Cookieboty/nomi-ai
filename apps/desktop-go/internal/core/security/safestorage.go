package security

import "encoding/base64"

// ElectronSafeStorage 解密 Electron safeStorage.encryptString 的产物。
// 存盘时一般再包一层 base64（GatewayStore / keys.enc / enc: 前缀）。
//
// 平台实现见 safestorage_*.go。解不了时返回 false（调用方提示用户重填）。
type ElectronSafeStorage interface {
	Available() bool
	Decrypt(cipher []byte) (plain string, ok bool)
}

// DecodeStored 把文件里的 base64 密文解成字节再交给平台解密
func DecodeStored(b64 string) ([]byte, error) { return base64.StdEncoding.DecodeString(b64) }
