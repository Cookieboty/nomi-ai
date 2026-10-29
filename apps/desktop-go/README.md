# apps/desktop-go（POC，勿合并）

Go 核心 + Wails v3.0.0 外壳原型。设计与实测见 `docs/design/arch-go-wails.md`。
不属于 pnpm workspace，不参与现有构建/CI。

```bash
pnpm install                 # 仓库根，前端复用 contract 源码（Rive 版另需 avatar-runtime）
./run-linux.sh               # 构建 frontend/dist + build/bin/nomi-poc（Linux 需 -tags gtk3 + webkit2gtk-4.1）
NOMI_POC_CTL=127.0.0.1:47811 ./build/bin/nomi-poc
curl '127.0.0.1:47811/ctl?op=show-chat'   # show-chat|close-chat|show-mascot|hide-mascot|quit
```

看板娘按设置 `mascot.renderer`（`svg`|`rive`，默认 `svg`）显示：默认静态 SVG（`rive/nomi-complete/reference/svg-rig/nomi-fullbody-mother.svg`）；打开「动态看板娘（Rive 动画）」后运行时动态加载 Rive，关掉即卸载并释放 WebGL。

环境变量：`NOMI_LLM_BASE_URL` / `NOMI_LLM_API_KEY` / `NOMI_LLM_MODEL`，无 key 时使用内置 mock。

---
> 2.0.5：本目录由 POC（arch/go-wails-poc @ d5e854e3）原样迁入，作为 Go + Wails v3 迁移起点；计划见 `docs/design/migrate-2.0.5-go.md`。
