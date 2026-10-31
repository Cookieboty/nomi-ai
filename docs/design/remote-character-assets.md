# 远程角色素材

2.0.8 起，角色包可以把体积大的素材声明为「远程素材」：它们不随安装包发，用到时由内核下载到用户数据目录。
官方角色的 Rive 动画（`characters/nomi/rive/character.riv`，约 16 MB）是第一个远程素材：桌面角色默认显示静态立绘，
用户在设置里打开「动画（Rive）」时才下载。这一层也是以后动态切换角色、角色商店的基础。

## 角色包契约

`manifest.json` 的 `assets.remote` 列出远程素材的种类（目前只有 `rive`）：

```json
"assets": { "mode": "rive", "rive": "rive/character.riv", "remote": ["rive"] }
```

- 声明为远程的素材本地可以没有，校验不报错；本地有时照常校验（大小下限等）。
- 规范化后的包 `assets.remote` 列出这些素材，`assets.rive` 仍是声明的包内路径。
- TS（`packages/character-contract`）与 Go（`apps/desktop-go/internal/core/charcontract`）一致，
  `scripts/parity/record-character-contract.mjs` 的 golden 覆盖声明 / 不声明 / 未知种类等情况。

## 远程角色目录

托管在 GitHub Release `characters`（预发布，不能是 latest：Go 更新器读 `releases/latest/download/latest-go.json`）：

- `catalog.json`（`schemaVersion: 1`）：

  ```json
  {
    "schemaVersion": 1,
    "generatedAt": "…",
    "packs": [
      {
        "id": "nomi",
        "version": "1.0.0",
        "assets": {
          "rive": { "file": "nomi-rive-4a51213a963b.riv", "url": "https://…", "size": 16368864, "sha256": "…" }
        }
      }
    ]
  }
  ```

- 素材文件按内容命名：`<id>-<种类>-<sha256 前 12 位><扩展名>`。内容不变文件名就不变；新版本是新文件，
  旧文件留着，已下载的客户端不受影响。

`scripts/character/remote-catalog.mjs --out <dir>` 从 `characters/*` 生成目录和素材，
`.github/workflows/characters-publish.yml`（手动触发）上传。素材有变化时、第一次上线前各跑一次。
每个素材的 `url` 是完整地址，以后换 CDN 只要重新生成目录，客户端不用改。

## 打包

声明为远程的文件不进安装包：视图构建（`scripts/character/vite-plugin.mjs` 的 `publishedFiles`）和
Go 版的 `resources/characters`（`packaging/package.sh` 的 `stage_resources`）都跳过它们。

## 内核

Node `core/src/character/CharacterAssets.ts` 与 Go `internal/core/characterassets` 行为一致：

| 情况                                   | 行为                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 启动                                   | `<userData>/character-assets/<packId>/current.json` 记的文件在、大小对 → 直接就绪              |
| 切到 Rive / 启动时已是 Rive            | `ensure`：读目录；sha256 与缓存一致就不动，否则下载                                            |
| 下载                                   | 写 `.part`、边下边算 sha256、推送进度；大小与 sha256 都对才改名、更新 `current.json`、删旧文件 |
| 更新已有素材                           | 下载期间状态保持 `ready`（旧素材照常用），完成后换成新地址                                     |
| 失败（离线、404、校验不过、卡住 60 s） | 有缓存继续用缓存；没有就 `error`，等用户重试                                                   |
| 当前包没有远程素材（覆盖包等）         | `remote: false`，什么也不做                                                                    |

契约：查询 `character.assets`、操作 `character.ensureAssets`（重试）、事件 `character.assetsChanged`。
就绪时 `riveUrl` 为 `character-pack://assets/<packId>/<file>`，由 `character-pack://` 协议的 `assets` 主机提供
（Node `packProtocol.ts`、Go `assetproto.ResolveCharacterAssetURL`），路径只能落在缓存目录里。

## 视图

- 桌面角色（`Nomi2DCanvas`）：选了 Rive，但内置包的 .riv 是远程素材且还没就绪时，按静态立绘显示；
  收到就绪事件后换成下载好的地址。
- 设置 → 桌面角色动画：打开后这一行显示「检查中 / 下载中 n% / 失败原因 + 重试」。

## 以后

角色商店在 `catalog.json` 里加角色条目（更多素材种类、展示信息），客户端按同一套「目录 → 校验 → 缓存」下载；
远程素材种类在 `REMOTE_ASSET_KINDS` 里扩展。
