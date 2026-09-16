# Usage Instructions

## Start

```powershell
cd voice-supervisor
npm install
npm run search:setup
npm run local:check
npm run copilot:check
# Or, to verify Agency start and resume:
npm run agency:check
npm run local
```

Open `http://127.0.0.1:4317`. The default route is local Moonshine STT, Ling LLM, and Kokoro TTS. Select another provider or voice mode from the top bar when needed.

## Voice

1. Select the text model.
2. Click **Connect Mic** and allow microphone access.
3. Speak naturally; one second of silence commits the turn.
4. Use **Stop Talking** to interrupt output.

Local defaults:

- STT: `moonshine-streaming-small-q4_k.gguf`
- LLM: `Ling-3.0-tiny-abliterated-APEX-I-Compact.gguf`
- TTS: `hexgrad/Kokoro-82M`, voice `af_heart`
- LLM context: 8192 tokens with llama.cpp KV cache reuse

Configure model paths, model IDs, Kokoro voice, context, and thread counts in `.env`; see `example.env` for every option. Models remain resident for the active process/session, llama.cpp uses memory mapping, and Hugging Face caches Kokoro assets.

The requested `moonshine-streaming-small-Q8_0.gguf` currently crashes CrispASR 0.8.32 on both CPU and Vulkan. The app detects that exact override and uses the installed canonical Small Q4_K model, reporting both paths in `/api/config`.

## Coding Sessions

Register a Git repository root as a Work Area. Start a task by voice, typed chat, or **New Task**. Choose Copilot CLI or Agency, the Copilot-compatible model and context, and a repository agent discovered from `.github/agents`.

The built-in defaults are Copilot CLI, `gpt-5.6-sol`, `medium` reasoning, and the short CLI context tier. Settings persist a different backend, model, default work area, or long context tier (up to 1M tokens). An explicit private `.env` value supplies the initial defaults.

The supervisor creates an isolated Git worktree and starts the selected backend with an explicit session ID. It records JSONL progress, tool/build output, final result, model, context, branch, and worktree. Use **Continue Thread** or `send_work_message` after a terminal result to resume the same task and backend session. Agency adds Hub reporting and suppresses its default MCPs. Status checks are passive and survive app restarts; an interrupted active session becomes stale/unknown rather than successful.

Available voice tools:

- `list_work`: list work areas and recent sessions.
- `start_work`: start a Copilot CLI or Agency task with backend, model, agent, and context.
- `send_work_message`: continue a finished task in its existing backend session.
- `get_work_status`: read state and recent progress for a task.
- `open_work`: open a task worktree in VS Code.
- `delete_work`: delete one finished task or unused work area.
- `invoke_vscode`: open a text note containing prompt, model, context, and directory. It does not start a VS Code agent yet.

Copilot CLI must be installed and authenticated. Agency must also be installed for Agency sessions; set `AGENCY_CLI` only when its executable is not on `PATH`. `npm run copilot:check` and `npm run agency:check` verify isolated start/resume lifecycles without changing this repository. Neither backend currently supports reliable noninteractive cancellation.

Open **Tool Lab** to inspect the exact schemas supplied to the LLM. Select a tool, enter its arguments, and click **Run Tool**. The panel shows the request ID, arguments, result, duration, and failures; action tools ask for confirmation before execution.

## Hosted Voice

Set the relevant API key in `.env`, select its provider and voice mode, then use **Connect Mic**. Gemini Live defaults to `gemini-3.1-flash-live-preview`. Local transcripts are never sent to a hosted text model unless **Allow Cloud Hybrid** is enabled.