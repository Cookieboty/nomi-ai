package security

// FakeSafeStorage 单测用：密文 = "FAKE" + 明文，不碰系统钥匙串。
type FakeSafeStorage struct{}

func (FakeSafeStorage) Available() bool { return true }

func (FakeSafeStorage) Decrypt(cipher []byte) (string, bool) {
	if len(cipher) < 4 || string(cipher[:4]) != "FAKE" {
		return "", false
	}
	return string(cipher[4:]), true
}

// FakeEncrypt 生成 FakeSafeStorage 能解的字节（测试写 fixture）
func FakeEncrypt(plain string) []byte {
	return append([]byte("FAKE"), plain...)
}
