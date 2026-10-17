# Third-party notices

Nomi itself is MIT-licensed. This file lists the third-party components it ships.
The licence gate `pnpm check:licenses` (scripts/check-licenses.mjs, run in CI) enforces that
production dependencies use allow-listed licences and that every bundled asset has an open-licence
entry in `assets-licenses.json`.

## Mascot stack

| Component                                                                                                                                                              | Licence              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| three.js (`three`)                                                                                                                                                     | MIT                  | WebGL renderer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `@pixiv/three-vrm`                                                                                                                                                     | MIT                  | VRM loader, expressions, look-at, spring bones                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `@react-three/fiber`, `@react-three/drei`                                                                                                                              | MIT                  | React bindings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Body motions (`packages/renderer/public/assets/motions/motions.json`)                                                                                                  | CC0-1.0 AND MIT      | 6 clips retargeted from Quaternius _Universal Animation Library_ (Standard, CC0); 9 procedural gestures original to this project (MIT). Per-clip licences in `assets-licenses.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Nomi brand assets (`packages/electron/assets/{icon.*,trayTemplate*.png,icons/,app-icons/}`, `docs/brand/*.svg`, `packages/renderer/public/assets/models/sprite/nomi/`) | MIT (owner-provided) | Owner-provided, AI-generated, licensed by project owner (Cookieboty). Vector logo recreated from the brand board by contributors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Completion chimes (`packages/electron/assets/completion/*.mp3`)                                                                                                        | CC0-1.0              | Synthesised by the project with ffmpeg                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Toolbar icons (`lucide-react`)                                                                                                                                         | ISC                  | Lucide icons — https://lucide.dev/license                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Provider brand icons (`packages/ui/src/brand/icons.ts`, 14 SVGs)                                                                                                       | MIT                  | From `@lobehub/icons-static-svg` 1.95.1 © 2023 LobeHub — https://github.com/lobehub/lobe-icons/blob/master/LICENSE. Logos are trademarks of their respective owners (OpenAI, Anthropic, Google, DeepSeek, Moonshot AI, Zhipu, Alibaba Cloud, ByteDance/Volcengine, MiniMax, xAI, OpenRouter, SiliconFlow, Ollama, LM Studio), shown only to identify the corresponding API service; no endorsement implied. Providers without an icon fall back to initials. The Codex endpoint icon reuses the OpenAI mark and the dsh endpoint icon the DeepSeek whale mark from the same set (`packages/ui/src/brand/endpointGlyphs.ts`, also embedded in the Dynamic Island page); the Nomi endpoint icon is the project's own app mark. |
| Mascot tip / voice-line texts (`packages/renderer/src/mascot/tips.ts`)                                                                                                 | MIT                  | Original project text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Desktop file tools

| Component | Licence | Notes                                                                                   |
| --------- | ------- | --------------------------------------------------------------------------------------- |
| `unpdf`   | MIT     | PDF text extraction in a sandboxed utility process; bundles Mozilla pdf.js (Apache-2.0) |
| `fflate`  | MIT     | Unzips `.docx` to read `word/document.xml`                                              |

## Local knowledge base

BM25 tokenizer/index, chunking, ODT/RTF/XLSX text extraction and the cited-answer prompt are original project code (MIT). Optional embeddings / rerank call any OpenAI-compatible endpoint the user configures (e.g. a local Ollama); no model is bundled.

| Component                                                                 | Licence    | Notes                                                                                                                                                                                                         |
| ------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tesseract.js` 7.0.0 (+ `tesseract.js-core` WASM)                         | Apache-2.0 | Offline OCR of images in indexed folders. Deps: `bmp-js`, `is-url`, `node-fetch`, `regenerator-runtime`, `zlibjs` (MIT); `idb-keyval`, `wasm-feature-detect` (Apache-2.0); `opencollective-postinstall` (MIT) |
| Tesseract `tessdata_fast` `eng` / `chi_sim` (on demand, commit `8741641`) | Apache-2.0 | © Google / Tesseract contributors — https://github.com/tesseract-ocr/tessdata_fast — pinned URLs + SHA-256 in `packages/electron/src/knowledge/catalog.ts`                                                    |

## Voice input (speech-to-text)

Model files and binaries are **not bundled**: they are downloaded on demand from the pinned URLs in `packages/electron/src/voice/catalog.ts`, verified by SHA-256, and the licence is shown before download.

| Component                                                                                                             | Licence                                           | Notes                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `onnxruntime-web` 1.30.0 (+ `onnxruntime-common`, `flatbuffers`, `guid-typescript`, `long`, `platform`, `protobufjs`) | MIT (deps: MIT / Apache-2.0 / ISC / BSD-3-Clause) | Runs Silero VAD in the Electron main process (WASM, single thread)                      |
| whisper.cpp release b5454 binaries (on demand)                                                                        | MIT                                               | © The ggml authors — https://github.com/ggml-org/whisper.cpp                            |
| Whisper `ggml-tiny` / `ggml-base` weights (on demand)                                                                 | MIT                                               | OpenAI Whisper weights converted to ggml — https://huggingface.co/ggerganov/whisper.cpp |
| Silero VAD v5 ONNX (on demand, commit `1e261b0`)                                                                      | MIT                                               | © Silero Team — https://github.com/snakers4/silero-vad                                  |

openWakeWord pretrained models (CC BY-NC-SA 4.0) are **not** used.

## Speech output (offline, default)

The speech model (~133 MB) is shipped as an Electron `extraResource` (`resources/tts-models/`, staged at package time by `scripts/sync-tts-model.mjs`, not committed to git). Per-file sizes are checked against `packages/electron/src/tts/sherpa/manifest.ts`.

| Component                                                                                                                    | Licence    | Notes                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sherpa-onnx-node` 1.13.8 + platform packages `sherpa-onnx-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,win-x64,win-ia32}` | Apache-2.0 | © k2-fsa / sherpa-onnx contributors — https://github.com/k2-fsa/sherpa-onnx. Native N-API addon and bundled ONNX Runtime, unpacked from the asar. |

## Speech output (optional advanced: Fish Audio / fish-speech)

**Built with Fish Audio.** Not enabled by default. Model weights are **not** bundled. The app talks to a user-run local fish-speech HTTP API (`http://127.0.0.1:8080`) or the user’s own Fish cloud API key.

| Component                                                                               | Licence                                  | Notes                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fish Speech / Fish Audio Materials (optional runtime)                                   | Fish Audio Community License             | Research / non-commercial free; community commercial while Annual Revenue &lt; USD 500k (see official LICENSE); Hosted Service needs a separate agreement; no non-consensual real-person cloning; do not train other base TTS models on outputs. Full excerpt in `NOTICE`. |
| Nomi built-in reference preset `nomi` (`packages/electron/assets/tts/references/nomi/`) | MIT (owner-provided sample when present) | Cute / kawaii Mandarin preset id only; place project-owned `sample.wav` + `sample.lab` beside the README. No third-party character packs.                                                                                                                                  |

## Local models (llama.cpp)

Nothing here is bundled. The runtime and the model weights download on demand from the pinned URLs in `packages/electron/src/local/llmCatalog.ts`. Each download is checked against its SHA-256, and the licence is shown before it starts. We checked every licence on the official model card. Models with custom licences (Llama, Gemma) or an "other" licence (Qwen2.5-3B) are not listed.

| Component                                                              | Source                                                                                                                                          | Licence    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| llama.cpp release b11565 `llama-server` binaries (on demand)           | https://github.com/ggml-org/llama.cpp (© The ggml authors)                                                                                      | MIT        |
| Qwen3 0.6B                                                             | [Qwen/Qwen3-0.6B-GGUF](https://huggingface.co/Qwen/Qwen3-0.6B-GGUF) `Qwen3-0.6B-Q8_0.gguf`                                                      | Apache-2.0 |
| Qwen2.5 1.5B Instruct                                                  | [Qwen/Qwen2.5-1.5B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF) `qwen2.5-1.5b-instruct-q4_k_m.gguf`                   | Apache-2.0 |
| SmolLM2 1.7B Instruct                                                  | [HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF](https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF) `smollm2-1.7b-instruct-q4_k_m.gguf` | Apache-2.0 |
| Qwen3 1.7B                                                             | [Qwen/Qwen3-1.7B-GGUF](https://huggingface.co/Qwen/Qwen3-1.7B-GGUF) `Qwen3-1.7B-Q8_0.gguf`                                                      | Apache-2.0 |
| Qwen3 4B                                                               | [Qwen/Qwen3-4B-GGUF](https://huggingface.co/Qwen/Qwen3-4B-GGUF) `Qwen3-4B-Q4_K_M.gguf`                                                          | Apache-2.0 |
| Phi-4 mini Instruct (GGUF by Unsloth of microsoft/Phi-4-mini-instruct) | [unsloth/Phi-4-mini-instruct-GGUF](https://huggingface.co/unsloth/Phi-4-mini-instruct-GGUF) `Phi-4-mini-instruct-Q4_K_M.gguf`                   | MIT        |

Ollama is optional. The user installs it separately (MIT); the app only calls its local HTTP API. The calendar (ICS/CalDAV), clipboard history and data export add no new dependencies; the zip export uses the existing `fflate` (MIT).

## Sandboxed browser & code execution

Clean-room implementation on Electron (`BrowserWindow` sandbox + memory partition) and the
Node.js permission model (both MIT, already listed). No code from Open Interpreter (AGPL-3.0)
or other copyleft agents was used; no new dependencies were added. Python, when used, is the
user's own system interpreter and is not redistributed.

## Subscription quota readers

Clean-room TypeScript in `packages/electron/src/usage/`; no dependencies added. The restricted
`claude -p /usage` subprocess and the reset-time parser are written from scratch against the
official CLIs' documented behaviour. Codex quota is read through the official `codex app-server`
JSON-RPC (`account/rateLimits/read`), so credentials never leave the CLI.

## Usage & cost data sources

The usage readers, parsers and cost maths in `packages/electron/src/usage/` are original TypeScript
(MIT); no dependencies were added (SQLite sources use Node's built-in `node:sqlite`, read-only).
Three open-source projects informed the work — **no code was copied** from any of them:

| Project                                                   | Licence | How it is used                                                                                                                                                                                    |
| --------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [models.dev](https://github.com/sst/models.dev)           | MIT     | Public model price table. Downloaded only when the user clicks "Sync prices" (`https://models.dev/api.json`); cached locally as an overlay on the built-in table. © SST / models.dev contributors |
| [TokenTracker](https://github.com/mm7894215/TokenTracker) | MIT     | Reference for which local coding-tool log locations and accounting fields exist (ideas only; parsers are independently written)                                                                   |
| [vibe-usage](https://github.com/vibe-cafe/vibe-usage)     | MIT     | Reference for per-tool token-field semantics and de-duplication ideas (ideas only; parsers are independently written)                                                                             |

Token field names for Qwen Code, OpenCode, GitHub Copilot CLI and Kimi come from public documentation
and the projects above; they are marked as not yet verified against every real installation in
`docs/features/privacy-security.md`.

## Production dependencies (generated with `pnpm licenses list --prod -r`)

| Package                                                   | Version(s)    | Licence                   |
| --------------------------------------------------------- | ------------- | ------------------------- |
| `@ai-sdk/anthropic`                                       | 4.0.78        | Apache-2.0                |
| `@ai-sdk/gateway`                                         | 4.0.110       | Apache-2.0                |
| `@ai-sdk/mcp`                                             | 2.0.73        | Apache-2.0                |
| `@ai-sdk/openai`                                          | 4.0.91        | Apache-2.0                |
| `@ai-sdk/openai-compatible`                               | 3.0.67        | Apache-2.0                |
| `@ai-sdk/provider`                                        | 4.0.26        | Apache-2.0                |
| `@ai-sdk/provider-utils`                                  | 5.0.58        | Apache-2.0                |
| `@babel/runtime`                                          | 7.27.6        | MIT                       |
| `@dimforge/rapier3d-compat`                               | 0.12.0        | Apache-2.0                |
| `@electron-internal/extract-zip`                          | 1.0.5         | BSD-2-Clause              |
| `@electron/get`                                           | 5.1.0         | MIT                       |
| `@mediapipe/tasks-vision`                                 | 0.10.17       | Apache-2.0                |
| `@monogrid/gainmap-js`                                    | 3.1.0         | MIT                       |
| `@pixiv/three-vrm`                                        | 3.5.5         | MIT                       |
| `@pixiv/three-vrm-core`                                   | 3.5.5         | MIT                       |
| `@pixiv/three-vrm-materials-hdr-emissive-multiplier`      | 3.5.5         | MIT                       |
| `@pixiv/three-vrm-materials-mtoon`                        | 3.5.5         | MIT                       |
| `@pixiv/three-vrm-materials-v0compat`                     | 3.5.5         | MIT                       |
| `@pixiv/three-vrm-node-constraint`                        | 3.5.5         | MIT                       |
| `@pixiv/three-vrm-springbone`                             | 3.5.5         | MIT                       |
| `@pixiv/types-vrm-0.0`                                    | 3.5.5         | MIT                       |
| `@pixiv/types-vrmc-materials-hdr-emissive-multiplier-1.0` | 3.5.5         | MIT                       |
| `@pixiv/types-vrmc-materials-mtoon-1.0`                   | 3.5.5         | MIT                       |
| `@pixiv/types-vrmc-node-constraint-1.0`                   | 3.5.5         | MIT                       |
| `@pixiv/types-vrmc-springbone-1.0`                        | 3.5.5         | MIT                       |
| `@pixiv/types-vrmc-springbone-extended-collider-1.0`      | 3.5.5         | MIT                       |
| `@pixiv/types-vrmc-vrm-1.0`                               | 3.5.5         | MIT                       |
| `@protobufjs/aspromise`                                   | 1.1.2         | BSD-3-Clause              |
| `@protobufjs/base64`                                      | 1.1.2         | BSD-3-Clause              |
| `@protobufjs/codegen`                                     | 2.0.5         | BSD-3-Clause              |
| `@protobufjs/eventemitter`                                | 1.1.1         | BSD-3-Clause              |
| `@protobufjs/fetch`                                       | 1.1.1         | BSD-3-Clause              |
| `@protobufjs/float`                                       | 1.0.2         | BSD-3-Clause              |
| `@protobufjs/path`                                        | 1.1.2         | BSD-3-Clause              |
| `@protobufjs/pool`                                        | 1.1.0         | BSD-3-Clause              |
| `@protobufjs/utf8`                                        | 1.1.2         | BSD-3-Clause              |
| `@react-three/drei`                                       | 10.7.9        | MIT                       |
| `@react-three/fiber`                                      | 9.8.1         | MIT                       |
| `@standard-schema/spec`                                   | 1.1.0         | MIT                       |
| `@tweenjs/tween.js`                                       | 23.1.3        | MIT                       |
| `@types/draco3d`                                          | 1.4.10        | MIT                       |
| `@types/node`                                             | 24.13.3       | MIT                       |
| `@types/offscreencanvas`                                  | 2019.7.3      | MIT                       |
| `@types/react`                                            | 19.3.0        | MIT                       |
| `@types/react-reconciler`                                 | 0.28.9        | MIT                       |
| `@types/stats.js`                                         | 0.17.4        | MIT                       |
| `@types/three`                                            | 0.186.0       | MIT                       |
| `@types/webxr`                                            | 0.5.22        | MIT                       |
| `@use-gesture/core`                                       | 10.3.1        | MIT                       |
| `@use-gesture/react`                                      | 10.3.1        | MIT                       |
| `@vercel/oidc`                                            | 3.2.0         | Apache-2.0                |
| `@workflow/serde`                                         | 4.1.0         | Apache-2.0                |
| `ai`                                                      | 7.0.136       | Apache-2.0                |
| `argparse`                                                | 2.0.1         | Python-2.0                |
| `base64-js`                                               | 1.5.1         | MIT                       |
| `bidi-js`                                                 | 1.0.3         | MIT                       |
| `bmp-js`                                                  | 0.1.0         | MIT                       |
| `buffer`                                                  | 6.0.3         | MIT                       |
| `builder-util-runtime`                                    | 9.7.0         | MIT                       |
| `camera-controls`                                         | 3.1.2         | MIT                       |
| `cross-env`                                               | 7.0.3         | MIT                       |
| `cross-spawn`                                             | 7.0.6         | MIT                       |
| `csstype`                                                 | 3.2.3         | MIT                       |
| `debug`                                                   | 4.4.3         | MIT                       |
| `detect-gpu`                                              | 5.0.70        | MIT                       |
| `draco3d`                                                 | 1.5.7         | Apache-2.0                |
| `electron`                                                | 44.7.0        | MIT                       |
| `electron-updater`                                        | 6.8.9         | MIT                       |
| `env-paths`                                               | 3.0.0         | MIT                       |
| `eventsource-parser`                                      | 3.1.1         | MIT                       |
| `fflate`                                                  | 0.6.10, 0.8.3 | MIT                       |
| `flatbuffers`                                             | 25.9.23       | Apache-2.0                |
| `fs-extra`                                                | 10.1.0        | MIT                       |
| `glsl-noise`                                              | 0.0.0         | MIT                       |
| `graceful-fs`                                             | 4.2.11        | ISC                       |
| `guid-typescript`                                         | 1.0.9         | ISC                       |
| `hls.js`                                                  | 1.6.7         | Apache-2.0                |
| `idb-keyval`                                              | 6.3.0         | Apache-2.0                |
| `ieee754`                                                 | 1.2.1         | BSD-3-Clause              |
| `immediate`                                               | 3.0.6         | MIT                       |
| `immer`                                                   | 11.1.21       | MIT                       |
| `is-promise`                                              | 2.2.2         | MIT                       |
| `is-url`                                                  | 1.2.4         | MIT                       |
| `isexe`                                                   | 2.0.0         | ISC                       |
| `its-fine`                                                | 2.1.1         | MIT                       |
| `js-yaml`                                                 | 4.3.2         | MIT                       |
| `json-schema`                                             | 0.4.0         | (AFL-2.1 OR BSD-3-Clause) |
| `jsonfile`                                                | 6.1.0         | MIT                       |
| `lazy-val`                                                | 1.0.5         | MIT                       |
| `lie`                                                     | 3.3.0         | MIT                       |
| `lodash.escaperegexp`                                     | 4.1.2         | MIT                       |
| `lodash.isequal`                                          | 4.5.0         | MIT                       |
| `long`                                                    | 5.3.2         | Apache-2.0                |
| `lucide-react`                                            | 1.55.0        | ISC                       |
| `maath`                                                   | 0.10.8        | MIT                       |
| `meshline`                                                | 3.3.1         | MIT                       |
| `meshoptimizer`                                           | 1.1.1         | MIT                       |
| `ms`                                                      | 2.1.3         | MIT                       |
| `node-fetch`                                              | 2.7.0         | MIT                       |
| `node-global-key-listener`                                | 0.3.0         | MIT                       |
| `onnxruntime-common`                                      | 1.30.0        | MIT                       |
| `onnxruntime-web`                                         | 1.30.0        | MIT                       |
| `opencollective-postinstall`                              | 2.0.3         | MIT                       |
| `path-key`                                                | 3.1.1         | MIT                       |
| `pkce-challenge`                                          | 5.0.1         | MIT                       |
| `platform`                                                | 1.3.6         | MIT                       |
| `potpack`                                                 | 1.0.2         | ISC                       |
| `progress`                                                | 2.0.3         | MIT                       |
| `promise-worker-transferable`                             | 1.0.4         | Apache-2.0                |
| `protobufjs`                                              | 7.6.6         | BSD-3-Clause              |
| `react`                                                   | 19.3.0        | MIT                       |
| `react-dom`                                               | 19.3.0        | MIT                       |
| `react-use-measure`                                       | 2.1.7         | MIT                       |
| `react-window`                                            | 2.3.3         | MIT                       |
| `regenerator-runtime`                                     | 0.13.11       | MIT                       |
| `require-from-string`                                     | 2.0.2         | MIT                       |
| `sax`                                                     | 1.4.1         | ISC                       |
| `scheduler`                                               | 0.28.0        | MIT                       |
| `semver`                                                  | 7.7.4, 7.8.5  | ISC                       |
| `shebang-command`                                         | 2.0.0         | MIT                       |
| `shebang-regex`                                           | 3.0.0         | MIT                       |
| `stats-gl`                                                | 2.4.2         | MIT                       |
| `stats.js`                                                | 0.17.0        | MIT                       |
| `sudo-prompt`                                             | 9.2.1         | MIT                       |
| `sumchecker`                                              | 3.0.1         | Apache-2.0                |
| `suspend-react`                                           | 0.1.3         | MIT                       |
| `tesseract.js`                                            | 7.0.0         | Apache-2.0                |
| `tesseract.js-core`                                       | 7.0.0         | Apache-2.0                |
| `three`                                                   | 0.186.1       | MIT                       |
| `three-mesh-bvh`                                          | 0.8.3         | MIT                       |
| `three-stdlib`                                            | 2.36.0        | MIT                       |
| `tiny-typed-emitter`                                      | 2.1.0         | MIT                       |
| `tr46`                                                    | 0.0.3         | MIT                       |
| `troika-three-text`                                       | 0.52.4        | MIT                       |
| `troika-three-utils`                                      | 0.52.4        | MIT                       |
| `troika-worker-utils`                                     | 0.52.0        | MIT                       |
| `tunnel-rat`                                              | 0.1.2         | MIT                       |
| `undici`                                                  | 7.29.0        | MIT                       |
| `undici-types`                                            | 7.18.2        | MIT                       |
| `universalify`                                            | 2.0.1         | MIT                       |
| `unpdf`                                                   | 1.8.1         | MIT                       |
| `use-sync-external-store`                                 | 1.5.0         | MIT                       |
| `utility-types`                                           | 3.11.0        | MIT                       |
| `wasm-feature-detect`                                     | 1.9.0         | Apache-2.0                |
| `webgl-constants`                                         | 1.1.1         | MIT                       |
| `webgl-sdf-generator`                                     | 1.1.1         | MIT                       |
| `webidl-conversions`                                      | 3.0.1         | BSD-2-Clause              |
| `whatwg-url`                                              | 5.0.0         | MIT                       |
| `which`                                                   | 2.0.2         | ISC                       |
| `zlibjs`                                                  | 0.3.1         | MIT                       |
| `zod`                                                     | 4.6.5         | MIT                       |
| `zustand`                                                 | 4.5.7, 5.0.15 | MIT                       |
