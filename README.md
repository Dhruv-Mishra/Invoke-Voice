# Voice Work Supervisor (POC)

Voice supervisor prototype combining live voice interaction (Gemini Live, OpenAI Realtime, or local offline pipeline) with workspace observation, git-aware work area tracking, and VS Code terminal bridge integration.

> **Verification Notice**: Cloud providers and live voice cannot be verified without active API credentials or downloaded local weights. No substitute models or automatic downloads are run by default.

## Quickstart

```powershell
# From the workspace root:
cd voice-supervisor

# 1. Install Node dependencies
npm install

# 2. Configure environment
Copy-Item example.env .env
# Edit .env and enter API secrets privately

# 3. Launch supervisor
npm start
# Or launch the secure Electron desktop wrapper:
npm run desktop
```
Open the URL printed at startup, normally `http://127.0.0.1:4317`; an occupied port advances to the next available one. Restart the app after changing environment settings. Run one companion instance per data directory.

## Supervision & Work Areas

1. **Register Work Area**: Register a clean git-repository-rooted directory via the UI (`POST /api/areas`).
2. **Hook Preview & Observation**: Enable VS Code agent hooks (`chat.hooks.enabled`) if supported by your build and organizational policy. Dispatch creates an isolated worktree and adds its own hook file without replacing existing hooks. Avoid changing the active VS Code window during dispatch. Missing workspace/session acknowledgement leaves the task unconfirmed; no automatic retry.
3. **Safety Boundaries**: Observations are passive. A `Stop` status indicates halted execution, not task success. All generated reports are unverified; the supervisor never performs automatic git merges or commits.

## Local Offline Voice & LLM Setup

To run locally with zero cloud dependencies:

### 1. Download Local Models & CrispASR Runtime
```powershell
node scripts/models.mjs runtimes    # CrispASR Windows CPU streaming binary
node scripts/models.mjs moonshine   # Moonshine Q4_K, tokenizer, and Silero VAD v6.2.0
node scripts/models.mjs ling        # Ling-3.0-Tiny APEX-I-Compact GGUF (~3.99GB)
# Or download both model packages at once:
node scripts/models.mjs all
```
Files are stored under `%LOCALAPPDATA%\VoiceSupervisor\` outside OneDrive to avoid file lock and sync overhead.

### 2. Local LLM Server (llama.cpp b10470+)
Launch `llama-server` on loopback:
```powershell
llama-server -m "$env:LOCALAPPDATA\VoiceSupervisor\models\Ling-3.0-tiny-abliterated-APEX-I-Compact.gguf" `
  --port 8081 --host 127.0.0.1 -c 4096 -b 256 -t 4 --alias ling-local --jinja
```

### 3. Kokoro-82M TTS Worker (Python 3.11)
```powershell
py -3.11 -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-local.txt

# Warmup worker (downloads official hexgrad/Kokoro-82M weights to Hugging Face cache on first run):
"" | python scripts/kokoro_worker.py
```
Verify that `{"type":"ready"}` is output. Once cached, Kokoro runs completely offline. In `.env`, update:
```env
KOKORO_READY=1
PYTHON_BIN=.venv\Scripts\python.exe
```
The adapter sends `enable_thinking: false` on every local request. Select **Local** as text provider and **Moonshine + Ling + Kokoro** as voice mode. Hybrid cloud text requires explicit consent. The supplied Ling checkpoint is third-party modified. The supervisor validates destinations; worker permissions and approvals remain in VS Code. Prompt grants and worktrees are not security sandboxes. Set `HF_HUB_OFFLINE=1` after warm-up for offline model loading. CrispASR uses rolling windows; full-loop latency still needs measurement.

Current checks: three focused automated tests, browser/API smoke checks, and exact Moonshine/Silero streaming model loading. Ling inference, Kokoro synthesis, hosted voice and a real VS Code task/session roundtrip remain unverified. Python 3.11 is recommended; this machine currently has only 3.13. No keys are stored by the UI.

## Security & Architecture
- **Loopback Enforcement**: Local HTTP, WebSocket, and LLM endpoints strictly require `127.0.0.1` or `localhost`.
- **Electron Security**: Runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, same-origin navigation enforcement, and microphone-only permissions.
