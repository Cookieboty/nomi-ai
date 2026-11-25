# Voice

Settings entry point: "Settings → General → Voice".

## Voice Input

- **Hold to talk**: Hold the microphone button in the input bar, or hold `F2` in the chat window; press `Esc` to cancel.
- If recognition is not configured yet (neither a local model downloaded nor a cloud provider set up), the microphone and hands-free buttons stay hidden from the input bar: open the "+" menu in the input box and click "Set up voice input…" to configure it; pressing `F2` or the hands-free shortcut also opens Voice settings directly.
- **Hands-free voice**: `Ctrl/⌘+Shift+H`, or toggle from the voice menu on Nomi's toolbar. Automatically detects when you start and stop speaking with adjustable sensitivity (Sensitive / Balanced / Conservative). Downloading Silero VAD improves detection accuracy; otherwise, basic energy-based detection is used.
- **Interrupt read-aloud when you start speaking**: Speaking while Nomi is reading aloud immediately stops playback.
- **Auto-send after recognition**: On by default; when off, recognized text is placed into the input box so you can edit it first.
- **Recognition engines**:
  - **Local whisper.cpp** (offline, recommended): Engine and models download on demand, displaying license info before download and verifying SHA-256 afterward; larger models improve accuracy at the cost of disk space and latency.
  - **OpenAI-compatible service**: Uses a saved third-party provider or a custom base URL (such as a local `whisper.cpp` server), calling `/audio/transcriptions`.
  - **Doubao Streaming ASR 2.0** (Volcengine, bring your own API Key): Streams audio in real time for recognition and is billed by the provider; requires activation in the Volcengine console first. Can be configured to fall back to local `whisper.cpp` if cloud recognition fails.
- Cloud recognition asks for your consent before uploading audio; when "Only local models can read files" is enabled, recordings cannot be sent to the cloud.

## Wake Word (Experimental, Off by Default)

When enabled, speaking the wake word starts listening; anything spoken immediately after it is handled directly as a command. Defaults to the active character pack's wake word ("Hello, Nomi" for the official pack) and can be customized to 2–8 Chinese characters or words in English. Wake-word detection always runs locally via `whisper.cpp` without uploading audio and requires downloading the local engine and model first; when enabled, the microphone listens continuously in the background.

## Nomi's Voice

Voice playback consists of two parts: **pre-recorded prompt clips** and a **real-time TTS engine**. If a line has a pre-recorded clip, that clip plays; otherwise, it is handed to the real-time engine. When the engine is set to "None" or synthesis fails, only text is shown.

### Character Prompt Voice (On by Default)

- 96 pre-recorded Chinese prompt clips for Nomi's common lines (greetings, reminders, voice toggles, etc.) are bundled with the installer under `characters/nomi/voice/zh/`.
- Plays only when the UI language is Chinese, Nomi is not muted, and "Character prompt voice" is enabled.
- For lines with variables (such as "You missed N reminders while you were away"), the bubble shows the full text while the voice plays a fixed phrasing; the same line plays at most once every 1.5 seconds.

### Real-Time TTS Engine (Default: Edge Online TTS)

| Option                    | Description                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------- |
| Edge online TTS (default) | Defaults to Xiaoyi (`zh-CN-XiaoyiNeural`), rate -5%; requires internet access      |
| None (text only)          | Disables speech synthesis; pre-recorded prompt clips are unaffected                |
| Azure Speech / OpenAI TTS | Not yet wired up; selecting them produces no audio and shows text only             |

- Edge TTS uses the online service backing Microsoft Edge's "Read aloud" feature—**it is not an official public Microsoft API** and may stop working in the future. If you do not want spoken text sent to Microsoft, set the engine to "None".
- **Voices and rate**: The voice list is fetched online and filtered to Chinese voices, falling back to a few built-in voices if unavailable. "Speech rate" ranges from -50% to +50% and applies to both character lines and AI replies. "Preview" synthesizes a sample sentence using unsaved settings; "Check connection" synthesizes a short test phrase and reports latency.
- Code, URLs, HTML, and Markdown syntax are stripped before speaking; long text is split into sentences and prefetched sequentially during playback.
- When offline, timed out (15 seconds), or if the service changes, playback fails silently and shows text only; consecutive failures show "Real-time TTS is temporarily unreachable" in Settings.

### Read AI Replies Aloud (On by Default)

- When "Read AI replies aloud" is on and the real-time TTS engine is available, Nomi reads replies in Nomi chats aloud as they stream; agent tabs and delegated turns are not read aloud.
- Code blocks, inline code, thinking blocks, tables, and URLs are skipped; each reply reads only the first ~300 characters (aligned to full sentences).
- Sending a new message, stopping generation, switching or creating a conversation, or holding push-to-talk interrupts playback immediately.

## Privacy

- The app never saves recordings or keeps audio history. Local `whisper.cpp` recognition (including wake-word detection) writes the current clip temporarily to the system temp directory (`cd-asr-*/in.wav`, readable only by the current user) for the engine to read and deletes it on completion, error, or cancellation; all other recordings are processed strictly in memory.
- The local engine is completely offline and never uploads audio; online recognition sends audio to the selected provider, logs every call to the audit log, and is governed by the provider's data retention policy.
- API keys for cloud recognition are encrypted in the OS secure storage and are not saved if secure storage is unavailable.

## Implementation

- UI: `packages/voice` (recording, VAD, wake word, settings panel); Nomi playback and lip-sync in `packages/renderer/src/mascot/tts/audioPlayback.ts`; pre-recorded clips in `packages/renderer/src/mascot/voice/promptClips.ts`; reply sentence splitting in `packages/ai-chat/src/services/replySpeech.ts`.
- Core: recognition in `apps/desktop-go/internal/core/voice` (`whisper.go`, `cloudasr.go`, `volc.go`), TTS in `internal/core/tts` (the Edge client in `tts/edge/` is built in and does not require Microsoft Edge to be installed).
- Pre-recorded clip generation script: `scripts/voice/gen.py` (requires `pip install edge-tts` and `ffmpeg`).
