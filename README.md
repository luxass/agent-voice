# 🎙️ agent-voice

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]

Host-independent audio recording, input device discovery, and Whisper transcription for Node.js.

## 📦 Installation

```sh
pnpm add @luxass/agent-voice
```

## 📚 Usage

```ts
import {
  createRecorder,
  listInputDevices,
  resolveOptions,
  resolvePreferredDevice,
  transcribe,
  transcriptionProfile,
} from "@luxass/agent-voice";

const options = resolveOptions({});
const recorder = createRecorder({
  onError: (error) => console.error(`Recording failed: ${error.message}`),
});

// Start recording (system default input, or pass a device).
const { device, warning } = resolvePreferredDevice(await listInputDevices(), options.input);
if (warning) console.warn(warning);
recorder.start(device);

// …later: stop, transcribe, clean up. The file is yours after stop().
const file = await recorder.stop();
try {
  const active = transcriptionProfile(options, options.activeTranscription);
  const text = await transcribe(file, active);
  console.log(text);
} finally {
  recorder.discard(file);
}
```

> [!NOTE]
> Recording is file-based: `stop()` hands you a WAV path in the OS temp
> directory, and you delete it with `discard()`. The recorder deletes it
> for you on every failure path. With local transcription the audio never
> leaves the machine.

## ⚙️ Configuration

`resolveOptions` parses plain JSON into a validated config. Everything is
optional — omitting it all means system-default mic plus auto-discovered
local model:

```json
{
  "input": "",
  "transcriptions": {
    "default": {
      "type": "local",
      "model": "~/.cache/whisper/ggml-large-v3-turbo.bin",
      "modelsDirectory": "~/.cache/whisper",
      "binary": "whisper-cli",
      "language": "auto"
    }
  }
}
```

Local models are auto-discovered from `~/.cache/whisper` and
`~/.local/share/whisper-cpp`, so `model` is only needed to pin one.
An empty `input` means the system default, re-resolved on every recording
with a warning when a saved device is unplugged.

Use an OpenAI-compatible API instead of local whisper.cpp:

```json
{
  "transcriptions": {
    "default": {
      "type": "api",
      "endpoint": "https://stt.example.com/v1",
      "models": ["whisper-large-v3-turbo", "whisper-small"],
      "apiKeyEnv": "VOICE_STT_API_KEY",
      "format": "multipart"
    }
  }
}
```

The first model is the default; the rest feed the model picker.

Set the key in the environment, never in the file. `format` is `multipart`
by default, or `openrouter` for OpenRouter's JSON audio format.

Switch between backends with named profiles. Exactly one is active at a time
(`activeTranscription`, defaults to the first profile; `{}` alone means
zero-config local):

```json
{
  "activeTranscription": "syv",
  "transcriptions": {
    "syv": {
      "type": "api",
      "endpoint": "https://platform.syv.ai/v1",
      "models": ["syv-transcribe"],
      "apiKeyEnv": "SYV_API_KEY"
    },
    "local": { "type": "local" }
  }
}
```

> [!TIP]
> Two local _models_ need no profiles: override the model per call with
> `transcribe(file, config, model)` (e.g. from a `modelChoices(config)`
> picker). Profiles are for switching backend _configs_.

## 🔌 Requirements

- Node.js >= 24
- `sox` on `PATH` for recording (a custom binary works via `soxBackend(command)`)
- Local transcription: `whisper-cli` on `PATH` plus a `ggml-*.bin` model
- API transcription needs no local tools

Recording and transcription are composable backends (`soxBackend`,
`whisperCliBackend`, `apiBackend`) — `createRecorder({ backend })` accepts
any capture backend, so a future ffmpeg backend slots in without changing
callers.

## 📄 License

Published under [MIT License](./LICENSE).

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/@luxass/agent-voice?style=flat&colorA=18181B&colorB=4169E1
[npm-version-href]: https://npmjs.com/package/@luxass/agent-voice
[npm-downloads-src]: https://img.shields.io/npm/dm/@luxass/agent-voice?style=flat&colorA=18181B&colorB=4169E1
[npm-downloads-href]: https://npmjs.com/package/@luxass/agent-voice
