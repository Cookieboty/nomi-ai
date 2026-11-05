package usage

// 账本记录的去重存储：十几万条记录里字段名序列、来源、模型、项目、会话高度重复，
// 每条各存一份占了账本内存的一半以上。这些值读出后只读（键序写时复制、指针字段从不原地改），
// 相同的值共用一份。key / rid / logKey 每条不同，不进表。

import (
	"slices"
	"strings"
	"sync"
)

var (
	internMu   sync.Mutex
	keySeqs    = map[string][]string{}
	strVals    = map[string]string{}
	strPtrs    = map[string]*string{}
	sigBuf     []byte
	uniqFields = map[string]bool{"key": true, "rid": true, "logKey": true}
)

// internMaxLen：超过这个长度的值大概率不重复，不进表
const internMaxLen = 128

// internKeys：相同的键序列共用一个切片（cap = len，追加时必然复制，不会改到别人）
func internKeys(keys []string) []string {
	internMu.Lock()
	defer internMu.Unlock()
	sigBuf = sigBuf[:0]
	for _, k := range keys {
		sigBuf = append(append(sigBuf, k...), 0)
	}
	if ks, ok := keySeqs[string(sigBuf)]; ok { // map[string(bytes)] 查找不分配
		return ks
	}
	ks := make([]string, len(keys))
	for i, k := range keys {
		ks[i] = internLocked(k)
	}
	ks = slices.Clip(ks)
	keySeqs[string(sigBuf)] = ks
	return ks
}

func internLocked(s string) string {
	if v, ok := strVals[s]; ok {
		return v
	}
	s = strings.Clone(s)
	strVals[s] = s
	return s
}

// internStr：字段 field 的字符串值
func internStr(field, s string) string {
	if uniqFields[field] || len(s) > internMaxLen {
		return s
	}
	internMu.Lock()
	defer internMu.Unlock()
	return internLocked(s)
}

// internStrp：可选字符串字段的指针，相同的值共用一个指针
func internStrp(field, s string) *string {
	if uniqFields[field] || len(s) > internMaxLen {
		return strp(s)
	}
	internMu.Lock()
	defer internMu.Unlock()
	if p, ok := strPtrs[s]; ok {
		return p
	}
	p := strp(internLocked(s))
	strPtrs[*p] = p
	return p
}
