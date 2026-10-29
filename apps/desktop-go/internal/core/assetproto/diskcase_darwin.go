package assetproto

import (
	"os"
	"path/filepath"
	"strings"
)

// diskCase：APFS 大小写不敏感，realpath(3) 返回磁盘上记录的大小写；逐段在父目录里找同名（先精确、再忽略大小写）
func diskCase(p string) string {
	out := "/"
	for _, seg := range strings.Split(strings.TrimPrefix(p, "/"), "/") {
		if seg == "" {
			continue
		}
		name := seg
		if ents, err := os.ReadDir(out); err == nil {
			exact := false
			for _, e := range ents {
				if e.Name() == seg {
					exact = true
					break
				}
			}
			if !exact {
				for _, e := range ents {
					if strings.EqualFold(e.Name(), seg) {
						name = e.Name()
						break
					}
				}
			}
		}
		out = filepath.Join(out, name)
	}
	return out
}
