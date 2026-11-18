# @nomi-ai/ai-sdk-client

## 0.0.4

### Patch Changes

- Updated dependencies [35ca37e]
  - @nomi-ai/contract@0.1.2

## 0.0.3

### Patch Changes

- Updated dependencies [5fe61e1]
- Updated dependencies [b27ece0]
  - @nomi-ai/contract@0.1.1

## 0.0.2

### Patch Changes

- f45b6ac: CLI-plugin review P0/P1: mapTools/AiSdkLlmProvider plumb `callerTabId` (ALS + ChatRequest.extra) so nested `delegate_to_cli` depth checks work on the production tool path; re-export `runWithToolCaller` / `getToolCallerTabId`.
- b2674bf: fix(sdk): IPC stream listeners are released as soon as a stream ends or fails (and on `dispose`), and `tts.stream(text, opts)` keeps its positional arguments (the request id travels in a separate envelope instead of being inserted in front of them).
- 3746bf4: fix(sdk): `useChat` now reads the real `ChatChunk` (`{type:'delta', content}`) instead of the non-existent `deltaText` field, so replies are no longer blank; `{type:'error'}` chunks surface as errors.
- Updated dependencies [bf74f72]
- Updated dependencies [1ec2af9]
- Updated dependencies [5a60967]
- Updated dependencies [0e6edc9]
- Updated dependencies [3cf04b1]
- Updated dependencies [ccbbfb9]
- Updated dependencies [5e21cdb]
- Updated dependencies [a98d631]
- Updated dependencies [9ea9699]
- Updated dependencies [ba7efe1]
- Updated dependencies [9165114]
- Updated dependencies [2603f92]
- Updated dependencies [7ad369f]
- Updated dependencies [16df054]
- Updated dependencies [4070aab]
- Updated dependencies [aa5a4cb]
- Updated dependencies [c0bc9ac]
- Updated dependencies [7abb8a5]
- Updated dependencies [7ecf142]
- Updated dependencies [172670d]
- Updated dependencies [7abb8a5]
- Updated dependencies [df95d1b]
- Updated dependencies [863dad7]
- Updated dependencies [42dc378]
- Updated dependencies [ccbbfb9]
- Updated dependencies [1ec2af9]
- Updated dependencies [1ec2af9]
- Updated dependencies [7200e84]
- Updated dependencies [2029912]
- Updated dependencies [dd5eec9]
- Updated dependencies [8559e9f]
- Updated dependencies [77062be]
- Updated dependencies [c004b2f]
- Updated dependencies [0211be6]
- Updated dependencies [e916b9e]
- Updated dependencies [25c09ad]
- Updated dependencies [a8eb3da]
- Updated dependencies [ab0a3db]
- Updated dependencies [568c407]
- Updated dependencies [c7f967c]
- Updated dependencies [89bbb9f]
- Updated dependencies [6de0750]
- Updated dependencies [0d9a30d]
- Updated dependencies [9e5b580]
- Updated dependencies [d3d1914]
- Updated dependencies [ab388c2]
- Updated dependencies [010c6a1]
- Updated dependencies [3197adc]
- Updated dependencies [6841bef]
- Updated dependencies [86e2ebd]
- Updated dependencies [d05e1ea]
- Updated dependencies [bb0e8c8]
- Updated dependencies [53a474c]
- Updated dependencies [85b017c]
- Updated dependencies [4e2760c]
- Updated dependencies [18b4428]
- Updated dependencies [f053e05]
- Updated dependencies [88bcadc]
- Updated dependencies [8314ee7]
- Updated dependencies [1735daf]
- Updated dependencies [241125e]
- Updated dependencies [b4f9ec9]
- Updated dependencies [d511566]
- Updated dependencies [4070aab]
  - @nomi-ai/contract@0.1.0
