# Building and Running

## Environment

- Node.js >= 22.12 (`.nvmrc` is 22; CI uses 24), pnpm 9 (via Corepack)
- Go (version specified in `apps/desktop-go/go.mod`; downloaded automatically when `GOTOOLCHAIN=auto`) and a cgo toolchain; Linux additionally requires GTK3 and WebKitGTK 4.1 development packages (`sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev`)

```bash
corepack enable
pnpm install
```

## Development

```bash
pnpm dev          # Runs environment self-check first, then starts Vite dev servers for both views and the Go app (hot reload for views; auto-rebuild & restart on Go edits; edits to packages/ui/src automatically rebuild the package and reload views)
pnpm dev:prod     # Same as pnpm dev, but omits the nomi_dev isolation tag to reuse production config and data directories (cannot run alongside the release build)
pnpm doctor       # Full environment self-check (Node, pnpm, Go, ports)
pnpm dev:libs     # Run in a separate terminal: watch and rebuild shared packages such as contract (packages/ui is already rebuilt by pnpm dev)
```

For details (flags, `--skip-deps`, dev-mode view proxy), see [apps/desktop-go/README.md](../../apps/desktop-go/README.md).

Development ports are defined in the root `dev-ports.json`:

| Purpose | Port | Override Variable |
| --- | --- | --- |
| Nomi window (renderer) | 6127 | `CD_RENDERER_PORT` |
| Chat window (ai-chat) | 6128 | `CD_CHAT_PORT` |
| demo | 6129 | `CD_DEMO_PORT` |

## Checks

```bash
pnpm build          # Build views and shared packages
pnpm typecheck
pnpm lint
pnpm test           # Package unit tests + script tests
pnpm check:i18n     # Check unified dictionary keys, languages, placeholders, and dead keys (including keys referenced in Go source)
pnpm check:licenses # Verify all dependency and asset licenses are open-source
pnpm format:check   # Prettier formatting check
cd apps/desktop-go && go vet ./... && go test ./...   # Add -tags private_mac_apis on macOS, -tags gtk3 on Linux
```

## Packaging

```bash
pnpm package mac-arm64 | mac-x64 | windows | linux   # = bash apps/desktop-go/packaging/package.sh <platform>
```

Installers can only be built on the corresponding OS (macOS x64 is cross-compiled from arm64). The script first builds the views (`apps/desktop-go/frontend/build.mjs`, skip with `SKIP_FRONTEND=1`) and outputs artifacts to `apps/desktop-go/dist-pkg/`. The version is read from the root `package.json` (override with `NOMI_VERSION`). See [RELEASE.md](../RELEASE.md) for signing and release workflows.

## Assets and Verification Scripts

| Script | Purpose |
| --- | --- |
| `scripts/brand/build-app-icon.py [output-dir]` | Generate app icon SVG variants (defaults to `docs/brand/icon-variants`) |
| `scripts/brand/build-icon-assets.py` | Rasterize and bundle app/tray icons into `apps/desktop-go/assets` |
| `python3 scripts/contact-sheet.py <dir> <output.png>` | Stitch screenshots into a grid for inspecting animations |

Python scripts require Pillow, NumPy, and OpenCV.
