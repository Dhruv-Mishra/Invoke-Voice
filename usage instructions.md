# Usage Instructions

## Start

```powershell
cd voice-supervisor
npm install
npm run local:check
npm run copilot:check
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

Register a Git repository root as a Work Area. Start a task by voice, typed chat, or **New Task**. Choose the Copilot model and context for each task.

The built-in and `example.env` defaults are `gpt-5.6-sol`, `medium` reasoning, and the CLI `long_context` tier. An explicit private `.env` value overrides these defaults.

The supervisor creates an isolated Git worktree and starts GitHub Copilot CLI with an explicit session ID. It records JSONL progress, tool/build output, final result, model, context, branch, and worktree. Status checks are passive and survive app restarts; an interrupted active session becomes stale/unknown rather than successful.

Available voice tools:

- `list_work`: list work areas and recent sessions.
- `start_work`: start a Copilot CLI task with model and context.
- `get_work_status`: read state and recent progress for a task.
- `open_work`: open a task worktree in VS Code.
- `invoke_vscode`: open a text note containing prompt, model, context, and directory. It does not start a VS Code agent yet.

Copilot CLI must be installed and authenticated. `npm run copilot:check` verifies the full isolated lifecycle without changing this repository.

Open **Tool Lab** to inspect the exact schemas supplied to the LLM. Select a tool, enter its arguments, and click **Run Tool**. The panel shows the request ID, arguments, result, duration, and failures; action tools ask for confirmation before execution.

## Hosted Voice

Set the relevant API key in `.env`, select its provider and voice mode, then use **Connect Mic**. Gemini Live defaults to `gemini-3.1-flash-live-preview`. Local transcripts are never sent to a hosted text model unless **Allow Cloud Hybrid** is enabled.