package cli

import (
	"path/filepath"
	"strings"
)

// GatewayAgentDir：第三方模型下，一个标签的 CLI 私有目录（配置、私有主目录）：<gatewayDir>/agents/<kind>/<tabId>。
// tabId 里 /[^\w-]/ 按 UTF-16 码元换成 _（gwstore 写文件、沙箱放行都用它，两边一致）
func GatewayAgentDir(gatewayDir, kind, tabID string) string {
	var b strings.Builder
	for _, r := range tabID {
		switch {
		case r == '_' || r == '-' || (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z'):
			b.WriteRune(r)
		case r > 0xFFFF:
			b.WriteString("__")
		default:
			b.WriteByte('_')
		}
	}
	return filepath.Join(gatewayDir, "agents", kind, b.String())
}
