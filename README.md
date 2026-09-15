# Voice Work Supervisor

Windows prototype for talking to a work supervisor, starting coding tasks in isolated worktrees, and reading passive progress observations.

## Install

Requires Node.js 22 or newer.

```powershell
cd voice-supervisor
npm install
Copy-Item example.env .env   # first setup only; do not overwrite a configured .env
```

Put secrets only in `.env`. The browser never receives provider keys.

## Gemini Live

Set `GEMINI_API_KEY` in `.env`. The configured voice model is `gemini-3.1-flash-live-preview`.

```powershell
npm start
```

Open the printed loopback URL, normally `http://127.0.0.1:4317`, select **Gemini Live**, and connect the microphone. `npm run desktop` starts the same hosted flow in Electron.

## Local Voice

The local route is Moonshine Streaming Tiny through CrispASR, Ling through llama.cpp, and Kokoro-82M through Python. A final transcript is committed after 1 second of silence. The models stay resident while the app runs.

Expected assets:

- `../LocalVoiceStack/LLMs/Ling-3.0-tiny-abliterated-APEX-I-Compact.gguf`
- `%LOCALAPPDATA%\VoiceSupervisor\models\moonshine-streaming-tiny-q4_k.gguf`
- `%LOCALAPPDATA%\VoiceSupervisor\models\tokenizer.bin`
- `%LOCALAPPDATA%\VoiceSupervisor\models\ggml-silero-v6.2.0.bin`
- `%LOCALAPPDATA%\VoiceSupervisor\runtimes\crispasr.exe`

Provision missing runtimes or Moonshine support files:

```powershell
npm run models -- runtimes
npm run models -- moonshine
winget install --exact --id ggml.llamacpp
winget install --exact --id Python.Python.3.12

py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements-local.txt
```

Kokoro downloads its official weights and voice on first use. Validate Ling once, then start both the LLM server and supervisor:

```powershell
npm run local:check
npm run local
```

Open the printed URL, select **Local** as the text provider and **Moonshine + Ling + Kokoro** as voice mode, then connect the microphone. `LLAMA_THREADS` controls Ling; `LOCAL_THREADS` controls STT/TTS. The defaults reserve CPU capacity for VS Code and builds.

After Kokoro is cached, set `HF_HUB_OFFLINE=1` for an offline-only voice startup. Cloud coding agents and Kusto still require network access.

## Coding Tasks

1. Enable VS Code agent hooks with `chat.hooks.enabled` if the installed build and policy permit it.
2. Register a Git repository root as a work area in the supervisor.
3. Start work by its registered name. The supervisor creates a worktree, invokes `code chat`, and binds progress only after a matching hook acknowledgement.

Status reads do not prompt or interrupt the coding agent. `Stop` is not treated as success, and missing observations become stale/unknown.

The VS Code bridge is prototype-grade: the CLI does not return a native chat session ID or completion result. Copilot CLI/ACP is the preferred next adapter because it supports explicit session IDs, resume, JSONL output, and process ownership. Playwright UI automation should be used only if both native CLI routes fail because it can steal focus and is sensitive to UI changes.

## Verified Here

On 2026-09-15: Gemini 3.1 Live connected and returned 24 kHz audio; CrispASR and Kokoro reached ready together; Kokoro generated PCM; llama.cpp b10970 loaded Ling and completed a request; all three focused Node checks passed. A real VS Code coding-task roundtrip has not yet been run.