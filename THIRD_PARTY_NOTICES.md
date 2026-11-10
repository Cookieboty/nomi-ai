# Third-party notices

Nomi itself is MIT-licensed. This file lists the third-party components it ships.
The licence gate `pnpm check:licenses` (scripts/check-licenses.mjs, run in CI) enforces that
production dependencies use allow-listed licences and that every bundled asset has an open-licence
entry in `assets-licenses.json`.

## Mascot stack

| Component                                                                                                                                                           | Licence              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nomi brand assets (`apps/desktop-go/assets/{icon.*,trayTemplate*.png,icons/,app-icons/}`, `docs/brand/*.svg`, `apps/desktop-go/assets/backgrounds/nomi-preset.jpg`) | MIT (owner-provided) | Owner-provided, AI-generated, licensed by project owner (Cookieboty). Vector logo recreated from the brand board by contributors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Completion chimes (`apps/desktop-go/assets/completion/*.mp3`)                                                                                                       | CC0-1.0              | Synthesised by the project with ffmpeg                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Toolbar icons (`lucide-react`)                                                                                                                                      | ISC                  | Lucide icons — https://lucide.dev/license                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Provider brand icons (`packages/ui/src/brand/icons.ts`, 14 SVGs)                                                                                                    | MIT                  | From `@lobehub/icons-static-svg` 1.95.1 © 2023 LobeHub — https://github.com/lobehub/lobe-icons/blob/master/LICENSE. Logos are trademarks of their respective owners (OpenAI, Anthropic, Google, DeepSeek, Moonshot AI, Zhipu, Alibaba Cloud, ByteDance/Volcengine, MiniMax, xAI, OpenRouter, SiliconFlow, Ollama, LM Studio), shown only to identify the corresponding API service; no endorsement implied. Providers without an icon fall back to initials. The Codex endpoint icon reuses the OpenAI mark and the dsh endpoint icon the DeepSeek whale mark from the same set (`packages/ui/src/brand/endpointGlyphs.ts`, also embedded in the Dynamic Island page); the Nomi endpoint icon is the project's own app mark. |
| Mascot tip / greeting texts (`characters/nomi/locales/*.json`)                                                                                                      | MIT                  | Original project text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

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
| Tesseract `tessdata_fast` `eng` / `chi_sim` (on demand, commit `8741641`) | Apache-2.0 | © Google / Tesseract contributors — https://github.com/tesseract-ocr/tessdata_fast — pinned URLs + SHA-256 in `apps/desktop-electron/internal/core/src/knowledge/catalog.ts`                                  |

## Voice input (speech-to-text)

Model files and binaries are **not bundled**: they are downloaded on demand from the pinned URLs in `apps/desktop-go/internal/core/voice/catalog.go`, verified by SHA-256, and the licence is shown before download.

| Component                                                                                                             | Licence                                           | Notes                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `onnxruntime-web` 1.30.0 (+ `onnxruntime-common`, `flatbuffers`, `guid-typescript`, `long`, `platform`, `protobufjs`) | MIT (deps: MIT / Apache-2.0 / ISC / BSD-3-Clause) | Runs Silero VAD in the Electron main process (WASM, single thread)                      |
| whisper.cpp release b5454 binaries (on demand)                                                                        | MIT                                               | © The ggml authors — https://github.com/ggml-org/whisper.cpp                            |
| Whisper `ggml-tiny` / `ggml-base` weights (on demand)                                                                 | MIT                                               | OpenAI Whisper weights converted to ggml — https://huggingface.co/ggerganov/whisper.cpp |
| Silero VAD v5 ONNX (on demand, commit `1e261b0`)                                                                      | MIT                                               | © Silero Team — https://github.com/snakers4/silero-vad                                  |

openWakeWord pretrained models (CC BY-NC-SA 4.0) are **not** used.

## Speech output (Nomi prompt clips, Edge online read-aloud)

There is no built-in (offline) speech synthesis engine. Nomi's short fixed prompt lines (Chinese UI, Nomi character only) play prerecorded MP3 clips from `characters/nomi/voice/zh/` (list in its `manifest.json`).

| Component                                 | Licence            | Notes                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nomi prompt clips (`voice/nomi/zh/*.mp3`) | Unclear — see note | Generated with the Microsoft Edge online neural voice `zh-CN-XiaoyiNeural` (rate −5%, pitch +0Hz) via `scripts/voice/gen.py`. Redistribution terms for audio from the free Edge read-aloud service are not clearly stated; regenerate the clips with a licensed Azure Speech subscription before a formal release. |

### Edge online read-aloud (realtime engine, default)

Lines without a prerecorded clip are synthesized at runtime by the **Microsoft Edge online read-aloud service** (`speech.platform.bing.com`, the service behind Edge's "Read aloud"). Nothing is bundled and no audio is stored; text is sent to Microsoft over the network only when the engine is `edge` (the default) and the mascot speaks.

- **Not an official public Microsoft API.** It is used the way the Edge browser uses it; Microsoft may change or block it at any time, in which case Nomi silently falls back to text only. Terms of use for third-party clients are not stated — **licensing is a grey area**. Users can switch the engine to "None" in Settings.
- **Client code is original project code (MIT)** — `apps/desktop-go/internal/core/tts/edge/` — written on top of the existing `ws` dependency (MIT); no new dependency and no GPL/LGPL code. The wire format (request headers, `speech.config` / SSML frames, binary audio framing, `Sec-MS-GEC` token) was re-implemented from public protocol descriptions, with reference to `msedge-tts` (MIT, https://github.com/Migushthe2nd/MsEdgeTTS) and the public discussion in `rany2/edge-tts` PR #492; no source was copied from `edge-tts` (LGPL-3.0).

## Local models (llama.cpp)

Nothing here is bundled. The runtime and the model weights download on demand from the pinned URLs in `apps/desktop-go/internal/core/local/llmcatalog.go`. Each download is checked against its SHA-256, and the licence is shown before it starts. We checked every licence on the official model card. Models with custom licences (Llama, Gemma) or an "other" licence (Qwen2.5-3B) are not listed.

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

Clean-room implementation; code execution uses the Node.js permission model and the OS sandbox
(macOS `sandbox-exec` / Linux `bwrap`). No code from Open Interpreter (AGPL-3.0)
or other copyleft agents was used; no new dependencies were added. Python, when used, is the
user's own system interpreter and is not redistributed.

## Subscription quota readers

Clean-room code in `apps/desktop-go/internal/core/usage/`; no dependencies added. The restricted
`claude -p /usage` subprocess and the reset-time parser are written from scratch against the
official CLIs' documented behaviour. Codex quota is read through the official `codex app-server`
JSON-RPC (`account/rateLimits/read`), so credentials never leave the CLI.

## Usage & cost data sources

The usage readers, parsers and cost maths in `apps/desktop-go/internal/core/usage/` are original code
(MIT); no dependencies were added (SQLite sources are read read-only).
Three open-source projects informed the work — **no code was copied** from any of them:

| Project                                                   | Licence | How it is used                                                                                                                                                                                    |
| --------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [models.dev](https://github.com/sst/models.dev)           | MIT     | Public model price table. Downloaded only when the user clicks "Sync prices" (`https://models.dev/api.json`); cached locally as an overlay on the built-in table. © SST / models.dev contributors |
| [TokenTracker](https://github.com/mm7894215/TokenTracker) | MIT     | Reference for which local coding-tool log locations and accounting fields exist (ideas only; parsers are independently written)                                                                   |
| [vibe-usage](https://github.com/vibe-cafe/vibe-usage)     | MIT     | Reference for per-tool token-field semantics and de-duplication ideas (ideas only; parsers are independently written)                                                                             |

Token field names for Qwen Code, OpenCode, GitHub Copilot CLI and Kimi come from public documentation
and the projects above; they are marked as not yet verified against every real installation in
`docs/features/privacy-security.md`.

## Gateway model catalog

| Data                                                                            | Licence | Notes                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model capability table (`apps/desktop-go/internal/gateway/models/catalog.json`) | MIT     | Trimmed from [models.dev](https://github.com/sst/models.dev) (© SST / models.dev contributors): context / output limits, input modalities, tool calling, reasoning options and sampling support of first-party models. Shipped offline; regenerated by hand |

## Production dependencies (generated with `pnpm licenses list --prod -r`)

| Package                                             | Version(s)    | Licence                 |
| --------------------------------------------------- | ------------- | ----------------------- |
| `@antfu/install-pkg`                                | 2.1.0         | MIT                     |
| `@braintree/sanitize-url`                           | 7.1.2         | MIT                     |
| `@chevrotain/types`                                 | 11.1.2        | Apache-2.0              |
| `@codemirror/autocomplete`                          | 6.20.4        | MIT                     |
| `@codemirror/commands`                              | 6.11.1        | MIT                     |
| `@codemirror/lang-cpp`                              | 6.0.3         | MIT                     |
| `@codemirror/lang-css`                              | 6.3.1         | MIT                     |
| `@codemirror/lang-go`                               | 6.0.1         | MIT                     |
| `@codemirror/lang-html`                             | 6.4.12        | MIT                     |
| `@codemirror/lang-java`                             | 6.0.2         | MIT                     |
| `@codemirror/lang-javascript`                       | 6.2.5         | MIT                     |
| `@codemirror/lang-json`                             | 6.0.2         | MIT                     |
| `@codemirror/lang-less`                             | 6.0.2         | MIT                     |
| `@codemirror/lang-markdown`                         | 6.5.2         | MIT                     |
| `@codemirror/lang-php`                              | 6.0.2         | MIT                     |
| `@codemirror/lang-python`                           | 6.2.1         | MIT                     |
| `@codemirror/lang-rust`                             | 6.0.2         | MIT                     |
| `@codemirror/lang-sass`                             | 6.0.2         | MIT                     |
| `@codemirror/lang-sql`                              | 6.10.0        | MIT                     |
| `@codemirror/lang-vue`                              | 0.1.3         | MIT                     |
| `@codemirror/lang-xml`                              | 6.1.0         | MIT                     |
| `@codemirror/lang-yaml`                             | 6.1.3         | MIT                     |
| `@codemirror/language`                              | 6.13.1        | MIT                     |
| `@codemirror/legacy-modes`                          | 6.5.5         | MIT                     |
| `@codemirror/lint`                                  | 6.9.7         | MIT                     |
| `@codemirror/state`                                 | 6.7.6         | MIT                     |
| `@codemirror/streamparser`                          | 6.0.0         | MIT                     |
| `@codemirror/view`                                  | 6.43.15       | MIT                     |
| `@iconify/types`                                    | 2.0.0         | MIT                     |
| `@iconify/utils`                                    | 3.1.7         | MIT                     |
| `@lezer/common`                                     | 1.5.5         | MIT                     |
| `@lezer/cpp`                                        | 1.1.6         | MIT                     |
| `@lezer/css`                                        | 1.3.9         | MIT                     |
| `@lezer/go`                                         | 1.0.1         | MIT                     |
| `@lezer/highlight`                                  | 1.2.5         | MIT                     |
| `@lezer/html`                                       | 1.3.13        | MIT                     |
| `@lezer/java`                                       | 1.1.5         | MIT                     |
| `@lezer/javascript`                                 | 1.5.6         | MIT                     |
| `@lezer/json`                                       | 1.0.3         | MIT                     |
| `@lezer/lr`                                         | 1.4.12        | MIT                     |
| `@lezer/markdown`                                   | 1.8.1         | MIT                     |
| `@lezer/php`                                        | 1.0.6         | MIT                     |
| `@lezer/python`                                     | 1.1.19        | MIT                     |
| `@lezer/rust`                                       | 1.0.3         | MIT                     |
| `@lezer/sass`                                       | 1.1.0         | MIT                     |
| `@lezer/xml`                                        | 1.0.6         | MIT                     |
| `@lezer/yaml`                                       | 1.0.4         | MIT                     |
| `@marijn/find-cluster-break`                        | 1.0.4         | MIT                     |
| `@mermaid-js/parser`                                | 1.2.1         | MIT                     |
| `@rive-app/canvas-lite`                             | 2.44.2        | MIT                     |
| `@types/d3`                                         | 7.4.3         | MIT                     |
| `@types/d3-array`                                   | 3.2.2         | MIT                     |
| `@types/d3-axis`                                    | 3.0.6         | MIT                     |
| `@types/d3-brush`                                   | 3.0.6         | MIT                     |
| `@types/d3-chord`                                   | 3.0.6         | MIT                     |
| `@types/d3-color`                                   | 3.1.3         | MIT                     |
| `@types/d3-contour`                                 | 3.0.6         | MIT                     |
| `@types/d3-delaunay`                                | 6.0.4         | MIT                     |
| `@types/d3-dispatch`                                | 3.0.7         | MIT                     |
| `@types/d3-drag`                                    | 3.0.7         | MIT                     |
| `@types/d3-dsv`                                     | 3.0.7         | MIT                     |
| `@types/d3-ease`                                    | 3.0.2         | MIT                     |
| `@types/d3-fetch`                                   | 3.0.7         | MIT                     |
| `@types/d3-force`                                   | 3.0.10        | MIT                     |
| `@types/d3-format`                                  | 3.0.4         | MIT                     |
| `@types/d3-geo`                                     | 3.1.1         | MIT                     |
| `@types/d3-hierarchy`                               | 3.1.7         | MIT                     |
| `@types/d3-interpolate`                             | 3.0.4         | MIT                     |
| `@types/d3-path`                                    | 3.1.1         | MIT                     |
| `@types/d3-polygon`                                 | 3.0.2         | MIT                     |
| `@types/d3-quadtree`                                | 3.0.6         | MIT                     |
| `@types/d3-random`                                  | 3.0.4         | MIT                     |
| `@types/d3-scale`                                   | 4.0.9         | MIT                     |
| `@types/d3-scale-chromatic`                         | 3.1.0         | MIT                     |
| `@types/d3-selection`                               | 3.0.12        | MIT                     |
| `@types/d3-shape`                                   | 3.2.0         | MIT                     |
| `@types/d3-time`                                    | 3.0.4         | MIT                     |
| `@types/d3-time-format`                             | 4.0.3         | MIT                     |
| `@types/d3-timer`                                   | 3.0.2         | MIT                     |
| `@types/d3-transition`                              | 3.0.9         | MIT                     |
| `@types/d3-zoom`                                    | 3.0.9         | MIT                     |
| `@types/debug`                                      | 4.1.12        | MIT                     |
| `@types/estree`                                     | 1.0.9         | MIT                     |
| `@types/estree-jsx`                                 | 1.0.5         | MIT                     |
| `@types/geojson`                                    | 7946.0.16     | MIT                     |
| `@types/hast`                                       | 3.0.5         | MIT                     |
| `@types/mdast`                                      | 4.0.4         | MIT                     |
| `@types/ms`                                         | 2.1.0         | MIT                     |
| `@types/react`                                      | 19.3.0        | MIT                     |
| `@types/trusted-types`                              | 2.0.7         | MIT                     |
| `@types/unist`                                      | 2.0.11, 3.0.3 | MIT                     |
| `@ungap/structured-clone`                           | 1.4.0         | ISC                     |
| `@upsetjs/venn.js`                                  | 2.0.0         | MIT                     |
| `bail`                                              | 2.0.2         | MIT                     |
| `ccount`                                            | 2.0.1         | MIT                     |
| `character-entities`                                | 2.0.2         | MIT                     |
| `character-entities-html4`                          | 2.1.0         | MIT                     |
| `character-entities-legacy`                         | 3.0.0         | MIT                     |
| `character-reference-invalid`                       | 2.0.1         | MIT                     |
| `codemirror-lang-hcl`                               | 0.2.0         | MIT                     |
| `codemirror-lang-makefile`                          | 0.1.1         | MIT                     |
| `codemirror-lang-zig`                               | 0.1.0         | MIT                     |
| `comma-separated-tokens`                            | 2.0.3         | MIT                     |
| `commander`                                         | 7.2.0, 8.3.0  | MIT                     |
| `cose-base`                                         | 1.0.3, 2.2.0  | MIT                     |
| `crelt`                                             | 1.0.7         | MIT                     |
| `csstype`                                           | 3.2.3         | MIT                     |
| `cytoscape`                                         | 3.34.4        | MIT                     |
| `cytoscape-cose-bilkent`                            | 4.1.0         | MIT                     |
| `cytoscape-fcose`                                   | 2.2.0         | MIT                     |
| `d3`                                                | 7.9.2         | ISC                     |
| `d3-array`                                          | 2.12.1        | BSD-3-Clause            |
| `d3-array`                                          | 3.2.5         | ISC                     |
| `d3-axis`                                           | 3.0.1         | ISC                     |
| `d3-brush`                                          | 3.0.1         | ISC                     |
| `d3-chord`                                          | 3.0.2         | ISC                     |
| `d3-color`                                          | 3.1.1         | ISC                     |
| `d3-contour`                                        | 4.0.3         | ISC                     |
| `d3-delaunay`                                       | 6.0.6         | ISC                     |
| `d3-dispatch`                                       | 3.0.2         | ISC                     |
| `d3-drag`                                           | 3.0.1         | ISC                     |
| `d3-dsv`                                            | 3.0.2         | ISC                     |
| `d3-ease`                                           | 3.0.2         | BSD-3-Clause            |
| `d3-fetch`                                          | 3.0.2         | ISC                     |
| `d3-force`                                          | 3.0.1         | ISC                     |
| `d3-format`                                         | 3.1.3         | ISC                     |
| `d3-geo`                                            | 3.1.2         | ISC                     |
| `d3-hierarchy`                                      | 3.1.3         | ISC                     |
| `d3-interpolate`                                    | 3.0.2         | ISC                     |
| `d3-path`                                           | 1.0.9         | BSD-3-Clause            |
| `d3-path`                                           | 3.1.1         | ISC                     |
| `d3-polygon`                                        | 3.0.2         | ISC                     |
| `d3-quadtree`                                       | 3.0.2         | ISC                     |
| `d3-random`                                         | 3.0.2         | ISC                     |
| `d3-sankey`                                         | 0.12.3        | BSD-3-Clause            |
| `d3-scale`                                          | 4.0.3         | ISC                     |
| `d3-scale-chromatic`                                | 3.1.1         | ISC                     |
| `d3-selection`                                      | 3.0.1         | ISC                     |
| `d3-shape`                                          | 1.3.7         | BSD-3-Clause            |
| `d3-shape`                                          | 3.2.1         | ISC                     |
| `d3-time`                                           | 3.1.1         | ISC                     |
| `d3-time-format`                                    | 4.1.1         | ISC                     |
| `d3-timer`                                          | 3.0.2         | ISC                     |
| `d3-transition`                                     | 3.0.2         | ISC                     |
| `d3-zoom`                                           | 3.0.1         | ISC                     |
| `dagre-d3-es`                                       | 7.0.14        | MIT                     |
| `dayjs`                                             | 1.11.23       | MIT                     |
| `debug`                                             | 4.4.3         | MIT                     |
| `decode-named-character-reference`                  | 1.3.0         | MIT                     |
| `delaunator`                                        | 5.1.0         | ISC                     |
| `dequal`                                            | 2.0.3         | MIT                     |
| `devlop`                                            | 1.1.0         | MIT                     |
| `dompurify`                                         | 3.4.17        | (MPL-2.0 OR Apache-2.0) |
| `es-toolkit`                                        | 1.52.0        | MIT                     |
| `escape-string-regexp`                              | 5.0.0         | MIT                     |
| `estree-util-is-identifier-name`                    | 3.0.0         | MIT                     |
| `extend`                                            | 3.0.2         | MIT                     |
| `fastdom`                                           | 1.0.12        | MIT                     |
| `hachure-fill`                                      | 0.5.2         | MIT                     |
| `hast-util-to-jsx-runtime`                          | 2.3.6         | MIT                     |
| `hast-util-whitespace`                              | 3.0.0         | MIT                     |
| `highlight.js`                                      | 11.11.2       | BSD-3-Clause            |
| `html-url-attributes`                               | 3.0.1         | MIT                     |
| `iconv-lite`                                        | 0.6.3         | MIT                     |
| `import-meta-resolve`                               | 4.2.0         | MIT                     |
| `inline-style-parser`                               | 0.2.7         | MIT                     |
| `internmap`                                         | 1.0.1, 2.0.3  | ISC                     |
| `is-alphabetical`                                   | 2.0.1         | MIT                     |
| `is-alphanumerical`                                 | 2.0.1         | MIT                     |
| `is-decimal`                                        | 2.0.1         | MIT                     |
| `is-hexadecimal`                                    | 2.0.1         | MIT                     |
| `is-plain-obj`                                      | 4.1.0         | MIT                     |
| `katex`                                             | 0.16.47       | MIT                     |
| `khroma`                                            | 2.1.0         | MIT                     |
| `layout-base`                                       | 1.0.2, 2.0.1  | MIT                     |
| `lodash-es`                                         | 4.18.1        | MIT                     |
| `longest-streak`                                    | 3.1.0         | MIT                     |
| `lowlight`                                          | 3.3.0         | MIT                     |
| `lucide-react`                                      | 1.55.0        | ISC                     |
| `markdown-table`                                    | 3.0.4         | MIT                     |
| `marked`                                            | 16.4.2        | MIT                     |
| `mdast-util-find-and-replace`                       | 3.0.3         | MIT                     |
| `mdast-util-from-markdown`                          | 2.1.0         | MIT                     |
| `mdast-util-gfm`                                    | 3.1.0         | MIT                     |
| `mdast-util-gfm-autolink-literal`                   | 2.0.1         | MIT                     |
| `mdast-util-gfm-footnote`                           | 2.1.0         | MIT                     |
| `mdast-util-gfm-strikethrough`                      | 2.0.1         | MIT                     |
| `mdast-util-gfm-table`                              | 2.0.0         | MIT                     |
| `mdast-util-gfm-task-list-item`                     | 2.0.0         | MIT                     |
| `mdast-util-mdx-expression`                         | 2.0.1         | MIT                     |
| `mdast-util-mdx-jsx`                                | 3.2.0         | MIT                     |
| `mdast-util-mdxjs-esm`                              | 2.0.1         | MIT                     |
| `mdast-util-phrasing`                               | 4.1.0         | MIT                     |
| `mdast-util-to-hast`                                | 13.2.1        | MIT                     |
| `mdast-util-to-markdown`                            | 2.2.0         | MIT                     |
| `mdast-util-to-string`                              | 4.0.0         | MIT                     |
| `mermaid`                                           | 11.17.2       | MIT                     |
| `micromark`                                         | 4.0.3         | MIT                     |
| `micromark-core-commonmark`                         | 2.0.4         | MIT                     |
| `micromark-extension-gfm`                           | 3.0.0         | MIT                     |
| `micromark-extension-gfm-autolink-literal`          | 2.1.0         | MIT                     |
| `micromark-extension-gfm-footnote`                  | 2.1.0         | MIT                     |
| `micromark-extension-gfm-strikethrough`             | 2.1.0         | MIT                     |
| `micromark-extension-gfm-table`                     | 2.1.2         | MIT                     |
| `micromark-extension-gfm-tagfilter`                 | 2.0.0         | MIT                     |
| `micromark-extension-gfm-task-list-item`            | 2.1.0         | MIT                     |
| `micromark-factory-destination`                     | 2.0.1         | MIT                     |
| `micromark-factory-label`                           | 2.0.1         | MIT                     |
| `micromark-factory-space`                           | 2.1.0         | MIT                     |
| `micromark-factory-title`                           | 2.0.1         | MIT                     |
| `micromark-factory-whitespace`                      | 2.0.1         | MIT                     |
| `micromark-util-character`                          | 2.1.1         | MIT                     |
| `micromark-util-chunked`                            | 2.0.1         | MIT                     |
| `micromark-util-classify-character`                 | 2.0.1         | MIT                     |
| `micromark-util-combine-extensions`                 | 2.0.1         | MIT                     |
| `micromark-util-decode-numeric-character-reference` | 2.0.2         | MIT                     |
| `micromark-util-decode-string`                      | 2.0.1         | MIT                     |
| `micromark-util-edit-map`                           | 1.0.0         | MIT                     |
| `micromark-util-encode`                             | 2.0.1         | MIT                     |
| `micromark-util-html-tag-name`                      | 2.0.1         | MIT                     |
| `micromark-util-normalize-identifier`               | 2.0.1         | MIT                     |
| `micromark-util-resolve-all`                        | 2.0.1         | MIT                     |
| `micromark-util-sanitize-uri`                       | 2.0.1         | MIT                     |
| `micromark-util-subtokenize`                        | 2.1.0         | MIT                     |
| `micromark-util-symbol`                             | 2.0.1         | MIT                     |
| `micromark-util-types`                              | 2.0.3         | MIT                     |
| `ms`                                                | 2.1.3         | MIT                     |
| `package-manager-detector`                          | 1.8.0         | MIT                     |
| `parse-entities`                                    | 4.0.2         | MIT                     |
| `path-data-parser`                                  | 0.1.0         | MIT                     |
| `points-on-curve`                                   | 0.2.0         | MIT                     |
| `points-on-path`                                    | 0.2.1         | MIT                     |
| `property-information`                              | 7.2.0         | MIT                     |
| `react`                                             | 19.3.0        | MIT                     |
| `react-dom`                                         | 19.3.0        | MIT                     |
| `react-markdown`                                    | 10.1.0        | MIT                     |
| `react-window`                                      | 2.3.3         | MIT                     |
| `remark-gfm`                                        | 4.0.1         | MIT                     |
| `remark-parse`                                      | 11.0.0        | MIT                     |
| `remark-rehype`                                     | 11.1.2        | MIT                     |
| `remark-stringify`                                  | 11.0.0        | MIT                     |
| `robust-predicates`                                 | 3.0.3         | Unlicense               |
| `roughjs`                                           | 4.6.6         | MIT                     |
| `rw`                                                | 1.3.3         | BSD-3-Clause            |
| `safer-buffer`                                      | 2.1.2         | MIT                     |
| `scheduler`                                         | 0.28.0        | MIT                     |
| `space-separated-tokens`                            | 2.0.2         | MIT                     |
| `strictdom`                                         | 1.0.1         | MIT                     |
| `stringify-entities`                                | 4.0.4         | MIT                     |
| `style-mod`                                         | 4.1.4         | MIT                     |
| `style-to-js`                                       | 1.1.21        | MIT                     |
| `style-to-object`                                   | 1.0.14        | MIT                     |
| `stylis`                                            | 4.4.0         | MIT                     |
| `tinyexec`                                          | 1.3.1         | MIT                     |
| `trim-lines`                                        | 3.0.1         | MIT                     |
| `trough`                                            | 2.2.0         | MIT                     |
| `ts-dedent`                                         | 2.3.0         | MIT                     |
| `unified`                                           | 11.0.5        | MIT                     |
| `unist-util-is`                                     | 6.0.1         | MIT                     |
| `unist-util-position`                               | 5.0.0         | MIT                     |
| `unist-util-stringify-position`                     | 4.0.0         | MIT                     |
| `unist-util-visit`                                  | 5.1.0         | MIT                     |
| `unist-util-visit-parents`                          | 6.0.2         | MIT                     |
| `uuid`                                              | 14.0.3        | MIT                     |
| `vfile`                                             | 6.0.3         | MIT                     |
| `vfile-message`                                     | 4.0.3         | MIT                     |
| `w3c-keyname`                                       | 2.2.8         | MIT                     |
| `zod`                                               | 4.6.7         | MIT                     |
| `zwitch`                                            | 2.0.4         | MIT                     |

## magpie

Some secret-detection rules in `apps/desktop-go/internal/gateway/privacy/rules.go` are ported from
[yetone/magpie](https://github.com/yetone/magpie) `internal/redact/redact.go`; see [CREDITS.md](CREDITS.md#code-references).

```text
MIT License

Copyright (c) 2026 yetone

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Reviewed missing package metadata

`khroma@2.1.0` omits SPDX metadata in its package manifest but ships the MIT license.
Copyright (c) 2019-present Fabio Spampinato, Andrew Maney. The licence gate verifies
the exact installed version and the SHA-256 of its distributed `license` file before
accepting it as MIT; see `scripts/licenses/package-metadata.mjs`. The MIT permission
and warranty terms below also apply to this component.

```text
The MIT License (MIT)

Copyright (c) 2019-present Fabio Spampinato, Andrew Maney

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```
