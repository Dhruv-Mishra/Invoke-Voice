# Voice Work Supervisor

Windows Node/Vue voice console for local or hosted voice and coding sessions. The server is loopback-only; provider keys stay in the server process.

## Prerequisites And Install

- Windows PowerShell and Node.js 22 or newer.
- Local voice is optional; it additionally needs `llama-server`, Python 3.12, `tar`, and first-run network access for models and Kokoro.
- Coding sessions need an authenticated GitHub Copilot CLI; Agency is optional.

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

Provision the model assets and runtimes:
```powershell
npm run models -- all
npm run models -- runtimes
winget install --exact --id ggml.llamacpp
winget install --exact --id Python.Python.3.12
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-local.txt
```
`all` downloads Ling, Moonshine Q4_K, its tokenizer, and Silero VAD; `runtimes` downloads the CrispASR Windows runtime. Use `npm run models -- ling` or `npm run models -- moonshine` for one group.

Downloads go to `%LOCALAPPDATA%\VoiceSupervisor\models` and `%LOCALAPPDATA%\VoiceSupervisor\runtimes`. The checked-in [`example.env`](example.env) instead points `LOCAL_LLM_PATH` and `MOONSHINE_MODEL` to sibling `..\LocalVoiceStack`; keep that layout or change them to fully expanded absolute paths. `MODEL_DIR`, `RUNTIME_DIR`, `CRISPASR_BIN`, and `VAD_MODEL` override remaining paths.

Kokoro downloads its Hugging Face weights and voice on first use. After caching, `$env:HF_HUB_OFFLINE = '1'` enables offline voice startup.

Check Ling, then start local llama.cpp and the supervisor:
```powershell
npm run local:check
npm run local
```
`local:check` proves only that Ling returns text; it does not validate microphone, CrispASR, or Kokoro. `local` starts or reuses a healthy loopback llama.cpp server, then starts the supervisor. CrispASR 0.8.32 requires canonical Moonshine Small Q4_K; a Q8_0 override falls back to Q4_K when available and `/api/config` reports requested/effective paths.

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
Electron builds first and starts its own loopback supervisor. It does not start `llama-server`; for local desktop voice, start llama.cpp at `LOCAL_LLM_URL` first. Closing the window stops its supervisor.

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