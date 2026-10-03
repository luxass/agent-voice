---
"@luxass/agent-voice": minor
---

Replace SoX recording and platform-specific device discovery with `@handy-computer/recorder` 0.1.0. Use the native speech preset for 16 kHz mono Float32 PCM in 480-sample chunks, preserve native device IDs, and exclude loopback monitors. Device opening and shutdown are asynchronous. Return completed audio from native collection without a polling loop or another PCM buffer.

Reject incomplete capture with its native failure or dropped-frame count. Stop resolves after the final frame callback; cancel closes and discards capture.

Replace the local whisper-cli backend with transcribe-cpp 0.2.4. Add `createTranscriber()` to keep a model loaded across recordings, with ordered frame feeding and final transcript output for streaming-capable models. API profiles continue to upload a WAV encoded in memory. Local inference no longer uses subprocesses or temporary audio files.

Replace whisper.cpp model downloads with a curated GGUF catalog using pinned Hugging Face revisions. Doctor checks report native microphone and inference availability instead of requiring SoX or whisper-cli.

Breaking changes for the next pre-1.0 minor release:

- Await `createRecorder()`, `start()`, and `cancel()`.
- Call `start({ input, onError, onFrame })`.
- `stop()` returns `RecordedAudio`; pass it to a transcriber instead of a WAV path.
- `discard()` is removed because hosts no longer own recording files.
- Previously saved SoX or PvRecorder inputs must be selected again.
- Local profiles no longer use `binary`. They require a compatible GGUF model; old Whisper `.bin` files are not converted.
- Replace `WHISPER_MODELS`/`WhisperModel` with `MODEL_CATALOG`/`DownloadableModel`.
- The default model directory is now `~/.cache/agent-voice`.
- Await streaming `cancel()` to finish in-flight work and release its session before disposing the transcriber.
- Dispose reusable transcribers when changing profiles or shutting down the host.

Local inference is explicitly unsupported under Bun because transcribe-cpp 0.2.4 documents a native finalizer crash. API profiles remain available there.

Move runtime dependencies to the named `runtime` catalog and remove the unnamed catalog. Pin `@handy-computer/recorder` to 0.1.0 and remove the Picovoice dependency. Development dependencies retain the named `dev` catalog.
