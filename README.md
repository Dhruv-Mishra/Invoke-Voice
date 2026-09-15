# Voice Work Supervisor

Windows prototype for talking to a work supervisor, starting coding tasks in isolated worktrees, and reading passive progress observations.

See [usage instructions.md](usage%20instructions.md) for the concise operating guide and tool list.

## Install

Requires Node.js 22 or newer.

```powershell
cd voice-supervisor
npm install
Copy-Item example.env .env   # first setup only; do not overwrite a configured .env
```

Put secrets only in `.env`. The browser never receives provider keys.

Build the local zvec-grep index once, then use hybrid code search:

```powershell
npm run search:index
npm run search -- "where task status is rendered"
```

The generated `.zvec-grep/` index and embedding model stay local.

## Hosted Voice

Set `GEMINI_API_KEY` in `.env`. The configured voice model is `gemini-3.1-flash-live-preview`.

```powershell
npm start
```

Open the printed loopback URL, normally `http://127.0.0.1:4317`, select **Gemini Live**, and connect the microphone. `npm run desktop` starts the same hosted flow in Electron. The app opens on the local route by default.

## Local Voice

The default route is Moonshine Streaming Small through CrispASR, Ling through llama.cpp, and Kokoro-82M through Python. A final transcript is committed after 1 second of silence.

Expected assets:

- `../LocalVoiceStack/LLMs/Ling-3.0-tiny-abliterated-APEX-I-Compact.gguf`
- `../LocalVoiceStack/STT_Models/moonshine-streaming-small-q4_k.gguf`
- `../LocalVoiceStack/STT_Models/tokenizer.bin`
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

Open the printed URL and connect the microphone. Local text and voice are preselected. `LLAMA_CONTEXT=8192`, memory mapping, and KV cache reuse are enabled; model IDs, paths, voices, and thread counts remain configurable in `.env`.

`moonshine-streaming-small-Q8_0.gguf` currently crashes CrispASR 0.8.32 on both CPU and Vulkan. The app detects that exact override and uses the installed, verified canonical Small Q4_K instead; `/api/config` reports the requested path, effective path, and warning.

After Kokoro is cached, set `HF_HUB_OFFLINE=1` for offline-only voice startup. Copilot coding sessions still require network access.

## Coding Tasks

1. Run `npm run copilot:check` to verify Copilot CLI authentication and lifecycle.
2. Register a Git repository root as a work area.
3. Start work by voice, chat, or **New Task**, selecting a Copilot model and context.

The supervisor owns the Copilot CLI process, assigns an explicit session ID, persists JSONL progress, and records tool/build updates and the final result. Status reads are passive; missing active observations become stale/unknown.

The `invoke_vscode` tool currently opens a text note with the requested prompt, model, context, and directory. It intentionally does not claim to start a VS Code agent. `open_work` opens a real Copilot worktree in VS Code.

## Verified Here

On 2026-09-15: Gemini 3.1 Live returned 24 kHz audio; canonical Moonshine Small Q4_K and Kokoro reached ready together; llama.cpp b10970 loaded Ling; focused tests passed; and the supervisor completed a real isolated Copilot CLI task with a persisted session ID and result.