# Voice Work Supervisor

Windows Node/Vue voice console for local or hosted voice and coding sessions. The server is loopback-only; provider keys stay in the server process.

## Windows App

This workspace's installer is [Voice Work Supervisor Setup](release/Voice%20Work%20Supervisor-Setup-0.1.0.exe). To try the built app without installing, open [the unpacked executable](release/win-unpacked/Voice%20Work%20Supervisor.exe); keep its neighboring files together.

Open the **Voice Work Supervisor Setup** executable from a trusted build. The one-click installer installs for your Windows user without administrator access. Launch **Voice Work Supervisor** from Start. The app includes its own Node runtime; you do not need Node or Python installed just to open it.

Local AI is optional. On first start, choose local setup, configure a provider, or decide later. Local setup opens Settings and still requires explicit download consent; nothing downloads just by opening the app. Setup installs and configures Ling/llama.cpp chat first, followed by Moonshine, Silero VAD, CrispASR, and an isolated Kokoro Python environment. If speech setup fails, local chat remains available and voice can be retried separately. Keep the app open until setup finishes. Allow several GB of downloads and at least 12 GB of free disk space; 16 GB RAM is recommended.

Files are kept under `%LOCALAPPDATA%\VoiceSupervisor`: `models`, `runtimes`, `huggingface`, `pip-cache`, and `uv-cache`. Existing configured `LocalVoiceStack` models are verified in place, not copied. Completed, verified files are reused on retry and future launches, including offline. Unfinished downloads are never reported ready. First verification of previously unrecorded models needs source metadata online. Local setup does not edit your `.env` or system Python/PATH.

After successful setup, local runtimes start automatically on desktop launch without downloading anything. Setup changes take effect in the running app. Each desktop instance uses private loopback ports, so a browser development server can remain open. Closing the app stops its managed runtimes. Microphone permission is still required, and setup startup checks do not prove microphone/speaker hardware works.

Configure provider keys, models, endpoints, defaults and local performance under **Settings > Config**. Values are stored in `%LOCALAPPDATA%\VoiceSupervisor\config.json`, excluded from the installer and never returned to the browser UI. The file contains secrets in plain text under the current Windows user profile, so do not share it or the app-data folder. Logs are in `%LOCALAPPDATA%\VoiceSupervisor\logs\desktop.log` and are replaced on launch. Cached models and user data are retained on uninstall. Remove the cache folder yourself only when the app is closed and you no longer need that data.

Installation failures keep a bounded, sanitized diagnostic tail in `logs/local-setup.log` inside the cache directory. Completed downloads are retained for retry. The Kokoro `https://pypi.org/project/kokoro/0.9.4/` link is the genuine human-readable PyPI release page; installation uses the package index and artifact hosts, normally `pypi.org/simple`, `files.pythonhosted.org`, and `download.pytorch.org`. If policy blocks those public services, set **Python package index** and **PyTorch package index** under **Settings > Config > Local setup network** to IT-approved HTTPS mirrors. Do not disable TLS verification or bypass organizational policy.

Builds are unsigned unless your distributor adds signing. Windows SmartScreen or organizational policy may warn or block them. Only run a build you trust; do not bypass organizational security policy.

## Prerequisites And Install

- The source workflow needs Node.js 22+ and npm. Windows x64 app setup manages its own voice runtimes; initial setup needs network access to the listed model/release sources, PyPI and the PyTorch CPU index.
- Coding sessions still need Git, an installed and authenticated GitHub Copilot CLI, and access to your repositories. Agency requires its own installation and authentication. VS Code is needed to open worktrees there. These tools, accounts and permissions are not provisioned by voice setup.

From this directory, install dependencies:
```powershell
npm ci
```
Start the app and use **Settings > Config** for normal configuration. `.env` remains an optional source-development and automation override for settings not exposed in the UI; never commit it.

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

Add relevant keys under **Settings > Config**, then choose a provider and voice route in the UI. Hosted text and realtime voice adapters read saved changes for new sessions immediately; Anthropic, Azure OpenAI, and custom OpenAI-compatible endpoints are text-only. Local transcripts reach hosted text only when **Allow Cloud Hybrid** is enabled. `.env` remains available for source automation.

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

### Test On Another Windows Machine

You do not need to push the repository to GitHub to test the installed app. Build the installer on the development machine, transfer only `release\Voice Work Supervisor-Setup-0.1.0.exe` through a trusted channel, and run it on the test machine. Choose repository visibility based on who may access the source and releases; never commit `.env`, `%LOCALAPPDATA%\VoiceSupervisor`, models, caches or generated installers.

### Publish A GitHub Beta

GitHub Releases is the distribution channel for installers; generated `release/` files remain ignored and should not be committed. This repository is public, so anyone with the release URL can download its assets. A private repository uses the same workflow, but downloaders must be authenticated collaborators.

Install and authenticate the GitHub CLI once (`gh auth login`). From a clean, committed `master` branch, validate and build on this Windows machine, then upload the installer directly to GitHub Releases with:
```powershell
npm run release:beta:local
```
This local path runs the full test suite and `npm run dist:win`, smoke-tests the packaged executable, writes a SHA-256 checksum, commits the generated version, atomically pushes the commit and tag, and uploads both files with `gh release create`. It does not consume GitHub Actions minutes.

To run the same release entirely on a GitHub-hosted Windows runner instead, use:
```powershell
npm run release:beta
```
The hosted command pushes any committed local commits, dispatches the GitHub Actions build, waits for it to finish, and publishes the same assets on [GitHub Releases](https://github.com/Dhruv-Mishra/VoiceOrchestration/releases).

The default `prerelease` increment advances `0.1.1-beta.0` to `0.1.1-beta.1`; from the current stable `0.1.0`, it starts `0.1.1-beta.0`. Start a fresh patch or minor beta line explicitly:
```powershell
npm run release:beta:local -- prepatch
npm run release:beta:local -- preminor

# Or use the GitHub-hosted runner
npm run release:beta -- prepatch
npm run release:beta -- preminor
```
GitHub marks every such release as a prerelease rather than `Latest`. The installer is currently unsigned, so Windows SmartScreen or organizational policy may still warn or block it. The beta workflow scopes its GitHub token to `contents: write` for the version commit, tag and release; other workflows retain the repository's read-only default.

For a repeatable full end-to-end test:

1. On the development machine, run `npm ci`, `npm test`, then `npm run dist:win`.
2. Transfer the generated installer to a Windows x64 test machine and launch it. The current build is unsigned, so organizational policy may block it.
3. Open **Settings > Config**, add hosted-provider keys if needed, and save. Runtime provider changes apply to new sessions immediately. Options marked **Restart required** are persisted but apply after closing and reopening the app; no rebuild is required.
4. Choose **Set up local**, consent to the 5-6 GB download, and wait for the desired capabilities to become ready. The machine needs HTTPS access to GitHub, Hugging Face, PyPI artifacts, and the PyTorch CPU index, or equivalent IT-approved mirrors configured under **Local setup network**.
5. Allow microphone access and verify local voice, hosted voice, text chat, interruption and reconnect behavior.
6. For coding tasks, separately install Git, VS Code and an authenticated GitHub Copilot CLI, then confirm `git --version`, `code --version` and `copilot --version` in PowerShell. Install and authenticate Agency only when testing that backend.
7. Register a disposable repository as a work area, dispatch a task, continue it, open its worktree and verify notifications.

A private GitHub remote is recommended once multiple machines or testers need the source because it gives you versioned branches and release artifacts. It is not required for running the installer.

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
- [`src/runtime-config.mjs`](src/runtime-config.mjs): allowlisted persisted app configuration, secret redaction and runtime/restart behavior.

See [`design_guide.md`](design_guide.md) before changing visual tokens or adding a theme.

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