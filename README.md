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
npm run search:setup
npm run search -- "where task status is rendered"
```

The generated `.zvec-grep/` index and embedding model stay local. The setup command also starts the search-only MCP endpoint at `http://127.0.0.1:7999/mcp`; workspace Copilot and VS Code sessions discover it through `.github/mcp.json`.

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

After Kokoro is cached, set `HF_HUB_OFFLINE=1` for offline-only voice startup. Copilot and Agency coding sessions still require network access.

## Coding Tasks

1. Install and authenticate GitHub Copilot CLI. Install Agency when that backend is needed.
2. Run `npm run copilot:check` or `npm run agency:check` to verify start and same-thread continuation.
3. Register a Git repository root as a work area.
4. Start work by voice, chat, or **New Task**, selecting Copilot CLI or Agency, a model, context, and repository agent.

Both backends use the same supervisor contract. The supervisor owns the process, assigns and persists an explicit session ID, records JSONL progress and final results, and resumes that session through **Continue Thread** or `send_work_message`. Agency runs Copilot-compatible sessions with Agency Hub reporting and default Agency MCPs disabled; repository MCP configuration remains available. Status reads are passive, and missing active observations become stale/unknown. Work-area instructions and `.github/agents/*.agent.md` choices are passed through. Worktrees open in a separate VS Code window.

The **Settings** view controls the default work area, coding backend, Copilot-compatible model and context, and completion/input/failure notification channels. Ordinary chat requests do not need a work area; coding dispatches may omit one only when a default is configured. Finished tasks and unused work areas can be deleted. Neither backend exposes reliable noninteractive cancellation, so the app reports cancellation as unsupported rather than pretending it succeeded.

Azure DevOps and Teams MCP connections are intentionally marked **planned**, not connected. Start Azure DevOps read-only, scoped to work items assigned to the authenticated user. Start Teams with read/list operations; sending a message should require an exact recipient/body preview and one-time confirmation. Add authenticated local access before attaching corporate credentials, and do not grant these business mutations to coding workers.

The `invoke_vscode` tool currently opens a text note with the requested prompt, model, context, and directory. It intentionally does not claim to start a VS Code agent. `open_work` opens a real Copilot worktree in VS Code.

## Verified Here

On 2026-09-15: Gemini 3.1 Live returned 24 kHz audio; canonical Moonshine Small Q4_K and Kokoro reached ready together; llama.cpp b10970 loaded Ling; focused tests passed; and the supervisor completed a real isolated Copilot CLI task with a persisted session ID and result.