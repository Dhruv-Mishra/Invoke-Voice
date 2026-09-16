# Voice Work Supervisor

Windows Node/Vue voice console for local or hosted voice and coding sessions. The server is loopback-only; provider keys stay in the server process.

## Windows App

This workspace's installer is [Voice Work Supervisor Setup](release/Voice%20Work%20Supervisor-Setup-0.1.0.exe). To try the built app without installing, open [the unpacked executable](release/win-unpacked/Voice%20Work%20Supervisor.exe); keep its neighboring files together.

Open the **Voice Work Supervisor Setup** executable from a trusted build. The one-click installer installs for your Windows user without administrator access. Launch **Voice Work Supervisor** from Start. The app includes its own Node runtime; you do not need Node or Python installed just to open it.

Local voice is optional. In Settings, review the local setup sources and explicitly start setup. Nothing downloads when you simply open the app. Setup installs Ling, Moonshine Small Q4_K, its tokenizer, Silero VAD, CPU llama.cpp/CrispASR, and an isolated Kokoro Python environment. Keep the app open until setup finishes. Progress and retry are available in Settings. Allow several GB of downloads and at least 12 GB of free disk space; 16 GB RAM is recommended. CPU speed and available memory affect voice latency.

Files are kept under `%LOCALAPPDATA%\VoiceSupervisor`: `models`, `runtimes`, `huggingface`, `pip-cache`, and `uv-cache`. Existing configured `LocalVoiceStack` models are verified in place, not copied. Completed, verified files are reused on retry and future launches, including offline. Unfinished downloads are never reported ready. First verification of previously unrecorded models needs source metadata online. Local setup does not edit your `.env` or system Python/PATH.

After successful setup, local runtimes start automatically on desktop launch without downloading anything. Setup changes take effect in the running app. Each desktop instance uses private loopback ports, so a browser development server can remain open. Closing the app stops its managed runtimes. Microphone permission is still required, and setup startup checks do not prove microphone/speaker hardware works.

Optional packaged provider configuration belongs in `%LOCALAPPDATA%\VoiceSupervisor\.env`; keep keys private. Logs are in `%LOCALAPPDATA%\VoiceSupervisor\logs\desktop.log` and are replaced on launch. Cached models and user data are retained on uninstall. Remove the cache folder yourself only when the app is closed and you no longer need that data.

Installation failures keep a bounded, sanitized diagnostic tail in `logs/local-setup.log` inside the cache directory. Completed downloads are retained for retry.

Builds are unsigned unless your distributor adds signing. Windows SmartScreen or organizational policy may warn or block them. Only run a build you trust; do not bypass organizational security policy.

## Prerequisites And Install

- The source workflow needs Node.js 22+ and npm. Windows x64 app setup manages its own voice runtimes; initial setup needs network access to the listed model/release sources, PyPI and the PyTorch CPU index.
- Coding sessions still need Git, an installed and authenticated GitHub Copilot CLI, and access to your repositories. Agency requires its own installation and authentication. VS Code is needed to open worktrees there. These tools, accounts and permissions are not provisioned by voice setup.

From this directory, install dependencies and create `.env` only when it is absent:
```powershell
npm ci
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath example.env -Destination .env
}
```
The copy never overwrites `.env`. Put provider keys and local paths there; do not commit them.

## Build And Run

Quick path (release mode):
```powershell
npm start
```
`npm start` builds current frontend production assets, then starts the supervisor at the printed loopback URL, normally `http://127.0.0.1:4317`. Built assets are served directly with accurate MIME types and security headers.

Debug mode (live Vite middleware, no second process needed):
```powershell
npm start -debug
# or
npm run dev
```
Debug mode mounts Vite dev middleware directly on the backend loopback server (`http://127.0.0.1:4317`). Frontend and backend share the exact same port and origin, preventing routing, API, and WebSocket drift.

Explicit preflight and test path:
```powershell
npm run build
npm test
npm start
```
`npm run build` explicitly builds `dist/`; `npm test` runs deterministic backend, provider, startup, and browser tests.

### Startup Command Contract

The unified startup flow (`scripts/start.mjs`) handles lifecycle, modes, and clean shutdown (SIGINT/SIGTERM):

| Command / Flag | Mode | Description |
| --- | --- | --- |
| `npm start` | Release | Default production flow; rebuilds and serves current `dist/` assets. |
| `npm start -debug` | Debug | Mounts Vite dev middleware on backend server; instant HMR and live modules. |
| `npm start -- -debug` | Debug | Alternative syntax for debug mode via npm flag forwarding. |
| `npm run dev` | Debug | Shortcut for debug mode (`scripts/start.mjs --debug`). |
| `npm run local` | Release + Local | Starts or connects to `llama-server` for Ling, then launches supervisor. |
| `npm start -local` | Release + Local | Starts unified supervisor with local voice stack. |
| `npm start -debug -local` | Debug + Local | Vite live middleware with local `llama-server` and speech stack. |
| `npm run local:check` | Local Check | Validates Ling local LLM generation (`READY`) and exits. |
| `--port <num>`, `-p <num>` | Any | Binds to custom port (defaults to `PORT` env or 4317). |
| `--build` | Release | Forces frontend rebuild even if `dist/index.html` already exists. |

## Local Voice

Start the source app with `npm start`, then use the opt-in setup in Settings. Setup only accepts `POST /api/setup` with `{"consent":true}`; `GET /api/setup` is a local, non-network snapshot. Extra command, URL and path fields are rejected. `ready` means the installed runtimes passed startup checks in this server process, not just that files exist.

For individual model/runtime downloads instead of full setup:
```powershell
npm run models -- all
npm run models -- runtimes
```
`all` installs Ling, Moonshine Q4_K, its tokenizer and Silero VAD. `runtimes` installs pinned Windows x64 CPU llama.cpp, CrispASR and uv. These commands alone do not install or validate the complete voice stack. `ling` and `moonshine` select a single model group.

Setup pins Hugging Face revisions plus SHA-verified native archives: CrispASR 0.8.32, llama.cpp b10970 CPU and uv 0.8.17. uv installs Python 3.12.11 privately, or uses an explicitly configured existing Python 3.12 only as the base for a separate environment. Kokoro 0.9.4 requirements come from [`requirements-local.txt`](requirements-local.txt), with CPU Torch 2.8.0 and the English spaCy 3.8.0 model. Transitive Python dependencies are resolved from trusted indexes, not a fully hash-locked environment. Unsupported Windows architectures need a separately maintained manual runtime setup.

The paths in [`example.env`](example.env) can point to sibling `..\LocalVoiceStack` or absolute local files. `MODEL_DIR`, `RUNTIME_DIR`, `CRISPASR_BIN`, `VAD_MODEL` and `PYTHON_BIN` remain source configuration overrides. Setup verifies existing models and refuses to overwrite mismatched external files. Normal Kokoro startup is offline; missing English dependencies or weights require explicit setup. Managed Kokoro uses the pinned `af_heart` English voice.

Check Ling, then start local llama.cpp and the supervisor:
```powershell
npm run local:check
npm run local
```
After provisioning, `local:check` proves only that Ling returns text. `local` starts or reuses a loopback llama.cpp server, then starts the supervisor. CrispASR 0.8.32 requires canonical Moonshine Small Q4_K; the known Q8_0 override falls back to sibling or cached Q4_K when available, and `/api/config` preserves requested/effective paths.

## Hosted Providers

Set relevant keys in `.env` using [`example.env`](example.env), then choose a provider in the UI or with `DEFAULT_PROVIDER` and `DEFAULT_VOICE_MODE`. Hosted text and realtime voice adapters are configured there; Anthropic, Azure OpenAI, and custom OpenAI-compatible endpoints are text-only. Local transcripts reach hosted text only when **Allow Cloud Hybrid** is enabled.

## Development And Desktop

Unified debug workflow (single PowerShell session):
```powershell
npm start -debug
# or
npm run dev
```
`npm start -debug` runs the backend and mounts Vite dev middleware directly on the loopback server (`http://127.0.0.1:4317`). Live source updates, HMR, and direct backend APIs run on one origin with zero configuration.

Standalone Vite dev server (optional):
If running Vite independently, `npm run build` once, then `npx vite --host 127.0.0.1` proxies to `PORT` (default 4317).

Electron desktop:
```powershell
npm run desktop
```
Electron builds first and starts its own loopback supervisor. After app setup, it also owns the local llama and speech runtimes. No external server or Node executable is needed for the installed app.

Build the unsigned per-user Windows x64 installer from source:
```powershell
npm run dist:win
```
The installer and unpacked app are written to `release/`. Only built frontend files, backend code, required scripts and production dependencies are packaged. Models, `.env`, credentials, state, tests and development artifacts are excluded. The backend and Python script run from physical `app.asar.unpacked` files; writable config and logs stay in app data.

Focused packaging/setup checks, then the real unpacked executable check:
```powershell
node --test test/setup.test.mjs test/desktop.test.mjs
$env:SUPERVISOR_PACKAGED_EXE = (Resolve-Path '.\release\win-unpacked\Voice Work Supervisor.exe').Path
node --test test/desktop.test.mjs
Remove-Item Env:SUPERVISOR_PACKAGED_EXE
```
The executable check uses a fresh temporary data directory, no voice downloads and a PATH without external Node. Full first-time voice setup, microphone/speaker checks and installer behavior must also be verified on a clean Windows machine before distribution.

## Architecture Map

- [`scripts/start.mjs`](scripts/start.mjs): unified startup coordinator owning flags, builds, local LLM lifecycle, and shutdown.
- [`src/server.mjs`](src/server.mjs): loopback HTTP, Vite middleware, SSE, WebSocket, provider config, and persisted state.
- [`src/llm.mjs`](src/llm.mjs), [`src/local-voice.mjs`](src/local-voice.mjs), [`src/realtime.mjs`](src/realtime.mjs): text, local voice, and realtime adapters.
- [`scripts/start-local.mjs`](scripts/start-local.mjs), [`desktop.cjs`](desktop.cjs): local and Electron launch.
- [`public/main.js`](public/main.js), [`public/app.js`](public/app.js): UI plus app-scoped transport/audio state.
- [`public/themes.js`](public/themes.js), [`public/VoiceSprite.js`](public/VoiceSprite.js): shared theme registry and presentation-only sprite.

## Add A Theme

Add one entry to `themes` in [`public/themes.js`](public/themes.js). Tokens, assets, animations, and preferences inherit shared defaults; keep transport/audio state in [`public/app.js`](public/app.js):
```js
{ id: 'forest', label: 'Forest',
  tokens: { '--cp-accent': '#25734d', '--cp-accent-hover': '#1b583a' },
  sprite: new URL('./forest.webp', import.meta.url).href,
  background: new URL('./forest-background.webp', import.meta.url).href,
  sounds: { navigation: new URL('./forest-tap.wav', import.meta.url).href },
  preferences: { soundVolume: 0.2 } },
```
Use real assets under `public`; `background: null` removes the image. Optional `animations` override individual voice states. Sound files are optional: `navigation` and `action` are shared event slots, and extra buttons can opt in with `data-theme-sound="action"`. Built-in themes stay silent; custom sounds are opt-in and local, theme audio is muted during calls, and choices persist locally.

Use native `<select>` controls; progressive `appearance: base-select` CSS is allowed, but do not add wrappers or mirrored state for theme edits.

See [`example.env`](example.env) for the complete configuration surface.