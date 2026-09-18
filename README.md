# Voice Work Supervisor

Local-first Windows voice console for coding work. The Vue/Vite UI connects to a loopback-only Node server and supports local models, hosted voice providers, GitHub Copilot CLI, and Agency.

## Requirements

- Node.js 22+ and npm for source development.
- Windows x64 for the packaged desktop app and managed local voice setup.
- Git, VS Code, and an authenticated GitHub Copilot CLI for Copilot coding sessions.
- A separately installed and authenticated Agency client for Agency sessions.
- Several GB of free disk space for optional local models; 16 GB RAM is recommended.

The desktop package includes Node. Local setup manages its own runtimes and Python environment, so users do not need to modify system Python or `PATH`.

## Install And Run

```powershell
npm ci
npm start
```

The server prints its loopback URL, normally `http://127.0.0.1:4317`.

| Command | Purpose |
| --- | --- |
| `npm start` | Build and run the release server. |
| `npm run dev` | Run the backend with Vite middleware and HMR. |
| `npm run local` | Start the local LLM and supervisor. |
| `npm run local:check` | Check the local tool-capable LLM path, then exit. |
| `npm run desktop` | Build and launch Electron. |
| `npm run build` | Build production frontend assets. |
| `npm test` | Run deterministic backend and browser tests. |

`scripts/start.mjs` also accepts `--debug`, `--local`, `--check`, `--build`, and `--port <number>`.

## Configuration

Use **Settings > Config** for providers, models, endpoints, defaults, local performance, and local setup sources. Saved values live in `%LOCALAPPDATA%\VoiceSupervisor\config.json`; secrets are never returned to the browser. `.env` remains available for source automation and settings not exposed in the UI. Never commit it.

Voice routing supports:

- **Native Voice**: OpenAI Realtime or Google Gemini Live.
- **Dedicated Models**: independently choose Local, OpenAI, or Google for speech recognition, LLM, and speech synthesis.

Cloud stages require the **Allow cloud processing** setting. Provider changes apply to new sessions. Settings marked **Restart required** apply after restarting the app.

## Local Voice

Local setup is opt-in and requires explicit download consent. It provisions:

- Ling through llama.cpp for local chat and tool calls.
- Whisper Small with CPU INT8 inference and Silero VAD by default.
- Moonshine/CrispASR as an optional streaming recognizer.
- Kokoro in an isolated Python 3.12 environment for speech synthesis.

Files are stored under `%LOCALAPPDATA%\VoiceSupervisor` in `models`, `runtimes`, and cache directories. Verified files are reused; partial or mismatched downloads are never reported ready. Setup does not edit `.env`, system Python, or `PATH`. If speech setup fails, verified local chat remains available.

For individual source-workflow downloads:

```powershell
npm run models -- all
npm run models -- runtimes
npm run models -- whisper
npm run models -- moonshine
npm run models -- task-search
```

Pinned URLs, revisions, sizes, and SHA-256 values are owned by [scripts/models.mjs](scripts/models.mjs). Python package inputs are in [requirements-local.txt](requirements-local.txt), [requirements-whisper.txt](requirements-whisper.txt), and [requirements-kokoro-pack.in](requirements-kokoro-pack.in).

Use only approved HTTPS sources. Do not disable TLS verification, bypass application-control policy, or share configuration and unsanitized logs. An IT-approved Python 3.12 x64 path and package mirrors can be configured in Settings when organizational policy requires them.

## Data And Security

- HTTP, SSE, and WebSocket listeners bind to loopback only.
- Provider keys stay in the server process and local config file.
- Runtime state, models, caches, and logs stay under `%LOCALAPPDATA%\VoiceSupervisor`.
- Logs are replaced or bounded; setup diagnostics are sanitized before presentation.
- Models, credentials, state, tests, and generated installers are excluded from packaged builds.
- Uninstall retains user data and model caches unless the user removes them while the app is closed.

The installer is unsigned unless the distributor adds signing. Windows SmartScreen or organizational policy may block it; do not bypass those controls.

## Desktop Builds And Releases

Build the unsigned per-user Windows x64 installer:

```powershell
npm run dist:win
```

The command builds a verified offline Kokoro dependency pack, the frontend, and the NSIS package under `release/`. Generated release files remain ignored.

From a clean `master` branch, publish a beta either locally or through GitHub Actions:

```powershell
npm run release:beta:local
npm run release:beta
```

Both flows run validation, publish the installer and its SHA-256 sidecar, and create a prerelease. The local flow requires an authenticated GitHub CLI. The in-app updater requires both release assets.

## Themes

Copilot, Jarvis, and Baymax themes use local bitmap artwork and Ogg cues. Appearance changes do not restart active voice or text sessions. Media provenance and distribution warnings are documented in [public/immersive/README.md](public/immersive/README.md); implementation rules live in [design_guide.md](design_guide.md).

Run `node scripts/theme-assets.mjs` with FFmpeg to regenerate normalized backgrounds and cues from `voice_app_assets`. Normal builds consume checked-in assets and do not run this preparation step.

## Architecture

- [scripts/start.mjs](scripts/start.mjs): startup modes, builds, local LLM lifecycle, and shutdown.
- [desktop.cjs](desktop.cjs): Electron lifecycle and managed local runtimes.
- [src/server.mjs](src/server.mjs): loopback HTTP, Vite, SSE, WebSocket, config, and state APIs.
- [src/supervisor.mjs](src/supervisor.mjs): persisted work state and tool dispatch.
- [src/llm.mjs](src/llm.mjs): streaming and tool roundtrips.
- [src/local-voice.mjs](src/local-voice.mjs), [src/realtime.mjs](src/realtime.mjs), and [src/speech-pipeline.mjs](src/speech-pipeline.mjs): local and hosted voice adapters.
- [public/app.js](public/app.js): browser composition and app-scoped transport/audio state.
- `public/captions/`, `public/setup/`, `public/settings/`, and `public/tools/`: focused browser controllers and renderers.
- [public/themes.js](public/themes.js) and [public/theme.css](public/theme.css): themes, design tokens, and responsive presentation.

Follow the nearest `AGENTS.md` before changing an owned area. Preserve HTTP, SSE, WebSocket, persisted-state, tool-schema, prompt, and audio contracts.

## Validation

```powershell
npm run build
npm test
```

For a packaged executable check:

```powershell
node --test test/setup.test.mjs test/desktop.test.mjs
$env:SUPERVISOR_PACKAGED_EXE = (Resolve-Path '.\release\win-unpacked\Voice Work Supervisor.exe').Path
node --test test/desktop.test.mjs
Remove-Item Env:SUPERVISOR_PACKAGED_EXE
```

Physical microphone/speaker behavior, first-time model downloads, provider quotas, and installer policy must still be validated on the target machine.