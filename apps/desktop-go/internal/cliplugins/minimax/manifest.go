package minimax

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/catalog"
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
)

// Manifest：清单。只写在 packages/cli-catalog/src/minimax/manifest.ts，生成到 cliplugins/catalog（见那里）
var Manifest = catalog.Manifest("minimax")

// Renderer：渲染进程用的插件信息
var Renderer = sh.RendererInfo(Manifest)
