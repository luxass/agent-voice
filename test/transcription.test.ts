import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { apiBackend, whisperCliBackend } from "../src/backends";
import type { ApiTranscription, LocalTranscription } from "../src/config";
import { modelChoices, transcribe } from "../src/transcription";

const WHISPER_STUB = `#!/usr/bin/env node
if (process.env.STUB_WHISPER_MODE === "unknown-language") {
  process.stderr.write("error: unknown language 'xx'\\n");
  process.exit(1);
}
if (process.env.STUB_WHISPER_MODE === "fail") {
  process.stderr.write("loading\\nwhisper FAIL: bad file\\n");
  process.exit(1);
}
if (process.env.STUB_WHISPER_MODE === "empty") {
  process.exit(0);
}
if (process.env.STUB_WHISPER_MODE === "hang") {
  setInterval(() => {}, 1000);
} else {
  process.stdout.write("  hello\\nworld  ");
  process.exit(0);
}
`;

let dir: string | undefined;
afterEach(() => {
  delete process.env.STUB_WHISPER_MODE;
  delete process.env.VOICE_STT_API_KEY;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function setup(): { whisper: string } {
  dir = mkdtempSync(join(tmpdir(), "agent-voice-tx-"));
  const whisper = join(dir, "whisper-cli");
  writeFileSync(whisper, WHISPER_STUB);
  chmodSync(whisper, 0o755);
  return { whisper };
}

function wav(size = 100): string {
  const d = dir ?? (dir = mkdtempSync(join(tmpdir(), "agent-voice-tx-")));
  const file = join(d, `rec-${Math.random().toString(36).slice(2)}.wav`);
  writeFileSync(file, Buffer.alloc(size));
  return file;
}

function modelFile(): string {
  const d = dir ?? (dir = mkdtempSync(join(tmpdir(), "agent-voice-tx-")));
  const file = join(d, "ggml-test.bin");
  writeFileSync(file, Buffer.alloc(10));
  return file;
}

const local = (overrides: Partial<LocalTranscription> = {}): LocalTranscription => ({
  type: "local",
  model: "/models/ggml-test.bin",
  modelsDirectory: "/models",
  binary: "whisper-cli",
  language: "auto",
  ...overrides,
});

const api = (overrides: Partial<ApiTranscription> = {}): ApiTranscription => ({
  type: "api",
  endpoint: "https://stt.example.com/v1",
  models: ["whisper-large-v3-turbo"],
  format: "multipart",
  ...overrides,
});

describe("transcribe guards", () => {
  it("rejects empty recordings", async () => {
    await expect(transcribe(wav(10), local(), "m")).rejects.toThrow("Recording is empty");
  });

  it("rejects missing files", async () => {
    await expect(transcribe("/does/not/exist.wav", local(), "m")).rejects.toThrow(
      "Recording is empty",
    );
  });

  it("rejects missing local models", async () => {
    const { whisper } = setup();
    const backend = whisperCliBackend({ binary: whisper });
    await expect(backend.transcribe(wav(), "/nope/ggml.bin")).rejects.toThrow(
      "Whisper model not found at /nope/ggml.bin",
    );
  });
});

describe("whisperCliBackend", () => {
  it("resolves normalized text on success", async () => {
    const { whisper } = setup();
    const model = modelFile();
    const backend = whisperCliBackend({ binary: whisper });
    await expect(backend.transcribe(wav(), model)).resolves.toBe("hello world");
  });

  it("rejects a missing binary", async () => {
    const backend = whisperCliBackend({ binary: "/does/not/exist-whisper" });
    await expect(backend.transcribe(wav(), modelFile())).rejects.toThrow();
  });

  it("rejects with the last stderr line on failure", async () => {
    process.env.STUB_WHISPER_MODE = "fail";
    const { whisper } = setup();
    const backend = whisperCliBackend({ binary: whisper });
    await expect(backend.transcribe(wav(), modelFile())).rejects.toThrow("whisper FAIL: bad file");
  });

  it("maps unknown-language errors", async () => {
    process.env.STUB_WHISPER_MODE = "unknown-language";
    const { whisper } = setup();
    const backend = whisperCliBackend({ binary: whisper });
    await expect(backend.transcribe(wav(), modelFile())).rejects.toThrow(
      "Unknown whisper language: xx",
    );
  });

  it("rejects empty output as no speech", async () => {
    process.env.STUB_WHISPER_MODE = "empty";
    const { whisper } = setup();
    const backend = whisperCliBackend({ binary: whisper });
    await expect(backend.transcribe(wav(), modelFile())).rejects.toThrow("No speech detected");
  });

  it("kills the subprocess on timeout", async () => {
    process.env.STUB_WHISPER_MODE = "hang";
    const { whisper } = setup();
    const backend = whisperCliBackend({ binary: whisper, timeoutMs: 50 });
    await expect(backend.transcribe(wav(), modelFile())).rejects.toThrow("Transcription timed out");
  });
});

type SeenRequest = {
  url: string;
  authorization: string;
  contentType: string;
  body: Buffer;
};

function startApiServer(
  respond: (body: Buffer) => { status: number; payload: unknown },
): Promise<{ url: string; requests: SeenRequest[]; close: () => Promise<void> }> {
  const requests: SeenRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({
        url: req.url ?? "",
        authorization: (req.headers.authorization as string) ?? "",
        contentType: (req.headers["content-type"] as string) ?? "",
        body,
      });
      const { status, payload } = respond(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe("apiBackend", () => {
  it("posts multipart and returns trimmed text", async () => {
    const server = await startApiServer(() => ({ status: 200, payload: { text: "  hello  " } }));
    try {
      const backend = apiBackend({ endpoint: server.url });
      await expect(backend.transcribe(wav(), "whisper-large-v3-turbo")).resolves.toBe("hello");
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.url).toBe("/audio/transcriptions");
      expect(server.requests[0]?.contentType).toContain("multipart/form-data");
    } finally {
      await server.close();
    }
  });

  it("posts openrouter JSON with base64 audio", async () => {
    const server = await startApiServer(() => ({ status: 200, payload: { text: "hi" } }));
    try {
      const backend = apiBackend({ endpoint: server.url, format: "openrouter" });
      await expect(backend.transcribe(wav(), "m")).resolves.toBe("hi");
      const body = JSON.parse((server.requests[0]?.body ?? Buffer.alloc(0)).toString());
      expect(body.input_audio.format).toBe("wav");
      expect(typeof body.input_audio.data).toBe("string");
    } finally {
      await server.close();
    }
  });

  it("sends the bearer token when configured", async () => {
    vi.stubEnv("VOICE_STT_API_KEY", "secret");
    const server = await startApiServer(() => ({ status: 200, payload: { text: "hi" } }));
    try {
      const backend = apiBackend({ endpoint: server.url, apiKeyEnv: "VOICE_STT_API_KEY" });
      await expect(backend.transcribe(wav(), "m")).resolves.toBe("hi");
      expect(server.requests[0]?.authorization).toBe("Bearer secret");
    } finally {
      await server.close();
    }
  });

  it("throws when the api key env var is missing", async () => {
    const server = await startApiServer(() => ({ status: 200, payload: { text: "hi" } }));
    try {
      const backend = apiBackend({ endpoint: server.url, apiKeyEnv: "VOICE_STT_API_KEY" });
      await expect(backend.transcribe(wav(), "m")).rejects.toThrow(
        "Set VOICE_STT_API_KEY to use the transcription API",
      );
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("throws on HTTP errors", async () => {
    const server = await startApiServer(() => ({ status: 500, payload: {} }));
    try {
      const backend = apiBackend({ endpoint: server.url });
      await expect(backend.transcribe(wav(), "m")).rejects.toThrow(
        "Transcription API returned HTTP 500",
      );
    } finally {
      await server.close();
    }
  });

  it("throws on empty text", async () => {
    const server = await startApiServer(() => ({ status: 200, payload: { text: "  " } }));
    try {
      const backend = apiBackend({ endpoint: server.url });
      await expect(backend.transcribe(wav(), "m")).rejects.toThrow("No speech detected");
    } finally {
      await server.close();
    }
  });
});

describe("transcribe", () => {
  it("defaults to the configured model", async () => {
    const { whisper } = setup();
    const model = modelFile();
    await expect(transcribe(wav(), local({ binary: whisper, model }), undefined)).resolves.toBe(
      "hello world",
    );
  });
});

describe("modelChoices", () => {
  it("lists api models", () => {
    expect(modelChoices(api({ models: ["a", "b"] }))).toEqual([
      { title: "a", value: "a" },
      { title: "b", value: "b" },
    ]);
  });

  it("returns empty when the models directory is missing and no model file exists", () => {
    expect(
      modelChoices(local({ modelsDirectory: "/does/not/exist", model: "/does/not/exist.bin" })),
    ).toEqual([]);
  });
});
