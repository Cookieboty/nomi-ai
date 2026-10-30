// Package edge 对应 apps/desktop-electron/internal/core/src/tts/edge：Edge 在线朗读（Sec-MS-GEC、线格式、websocket 客户端、服务、音色表）。
package edge

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"math"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

// TrustedClientToken = TRUSTED_CLIENT_TOKEN
const TrustedClientToken = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"

const copyrightPrefix = "Copyright (C) Microsoft Corporation. All rights reserved."

// windowsEpochOffset：1601-01-01 到 1970-01-01 的秒数
const windowsEpochOffset = 11644473600

func rot16(x uint32) uint32 { return x<<16 | x>>16 }

func swapTerm(word, key, a, b, c uint32) uint32 {
	s := word*key + rot16(word)*a
	p := rot16(s) * b
	return rot16(p)*c + p
}

func mixChain(v uint32, fs [4]uint32) uint32 {
	for _, f := range fs {
		v = rot16(v) * f
	}
	return v
}

var (
	mixA = [4]uint32{0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83}
	mixB = [4]uint32{0xa27416f5, 0xd38396ff, 0x7c932b89, 0xbfa49f69}
)

// CS64 = cs64(msg, digest)：以 SHA-256 摘要前两个字为键的 8 字节校验
func CS64(msg, digest []byte) []byte {
	k1 := binary.LittleEndian.Uint32(digest[0:]) | 1
	k2 := binary.LittleEndian.Uint32(digest[4:]) | 1
	buf := make([]byte, (len(msg)+7)/8*8)
	copy(buf, msg)
	var sumSwap, lastSwap, mix, sumMix uint32
	for i := 0; i < len(buf); i += 8 {
		w1 := binary.LittleEndian.Uint32(buf[i:])
		w2 := binary.LittleEndian.Uint32(buf[i+4:])
		s1 := swapTerm(w1, k1, 0xef0569fb, 0x76f50f34, 0xc3efea97)
		lastSwap = swapTerm(w2, k2, 0xc31713db, 0x1881ce3c, 0x35bd1ec9)
		sumSwap += s1 + lastSwap
		mix = mixChain((mix+w1)*k1, mixA)
		sumMix += mix
		mix = mixChain((mix+w2)*k2, mixB)
		sumMix += mix
	}
	out := make([]byte, 8)
	binary.LittleEndian.PutUint32(out[0:], lastSwap^mix)
	binary.LittleEndian.PutUint32(out[4:], sumSwap^sumMix)
	return out
}

// SecMsGec = secMsGec(unixSeconds)
func SecMsGec(unixSeconds float64) string {
	t := new(big.Int).SetInt64(int64(math.Floor(unixSeconds)) + windowsEpochOffset)
	m := new(big.Int).Rem(t, big.NewInt(300)) // JS %：符号随被除数
	t.Sub(t, m)
	ticks := t.Mul(t, big.NewInt(10_000_000)).String()
	msg := []byte(copyrightPrefix + ticks + TrustedClientToken)
	d := sha256.Sum256(msg)
	return strings.ToUpper(hex.EncodeToString(CS64(msg, d[:]))) + "-" + strings.ToUpper(hex.EncodeToString(d[:]))
}

var (
	skewMu      sync.Mutex
	skewSeconds float64
	// Now 可在测试中替换（= Date.now）
	Now = func() time.Time { return time.Now() }
)

func unixFloat(t time.Time) float64 { return float64(t.UnixMilli()) / 1000 }

// NowSeconds = nowSeconds()
func NowSeconds() float64 {
	skewMu.Lock()
	defer skewMu.Unlock()
	return unixFloat(Now()) + skewSeconds
}

// AdjustSkewFromServerDate = adjustSkewFromServerDate(dateHeader)
func AdjustSkewFromServerDate(dateHeader string) bool {
	if dateHeader == "" {
		return false
	}
	server, err := http.ParseTime(dateHeader)
	if err != nil {
		return false
	}
	skewMu.Lock()
	skewSeconds = float64(server.UnixMilli())/1000 - unixFloat(Now())
	skewMu.Unlock()
	return true
}

// ResetSkewForTests = resetSkewForTests()
func ResetSkewForTests() {
	skewMu.Lock()
	skewSeconds = 0
	skewMu.Unlock()
}
