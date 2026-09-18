# Voice Work Supervisor

Local-first Windows voice console for delegated tasks. The Vue/Vite UI connects to a loopback-only Node server and supports local models, hosted voice providers, GitHub Copilot CLI, and Agency.

## Requirements

- Node.js 22+ and npm for source development.
- Windows x64 for the packaged desktop app and managed local voice setup.
- Git, VS Code, and an authenticated GitHub Copilot CLI for Copilot coding sessions.
- A separately installed and authenticated [Agency client](https://aka.ms/agency) for Agency sessions (the fresh-install default).
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

## Agency Tasks

New installations default to Agency; saved backend choices are unchanged. The existing `start_work` tool delegates coding, skills, research, and work-data questions using the original request. External questions use its optional `readOnly: true` flag and always run through Agency. The worker chooses its tools; answers, notifications, and follow-ups use the same task flow. Status reads never start another investigation. The voice model still has seven task tools, with no MCP catalog or scenario-specific tools.

At startup, the app launches Bluebird, WorkIQ, and Teams through `agency mcp --transport http --port 0`. Task sessions reuse these loopback listeners; the app stops owned task processes and proxies on shutdown. Startup does not wait for authentication or query work data. Missing Agency does not block the app; task launches fall back to Agency's native STDIO proxies when a shared listener is unavailable. Listening status is not proof of account access. Coding sessions enable these servers plus Microsoft Learn and any repository MCPs, letting Agency select tools without another coordinator session.

Read-only tasks allow public Microsoft Learn by default. Enable enterprise research in **Settings > Config > Coding tools > Agency work data** with **Allow WorkIQ, Teams, calendar and people reads** (`AGENCY_WORK_DATA_ACCESS=read-only`). Fresh installations default to Off. Confirm the intended account is signed in to Agency and your organization permits this processing. This setting governs the restricted research profile, not the ordinary coding session's tools or shell permissions.

Research runs in an isolated app-data directory with an automatically registered task-local Agency profile, exact 24-operation read allowlist, and no shell, filesystem, URL, repository, or mutation tools. WorkIQ contributes `retrieve`, `fetch`, `search_paths`, and `get_schema`; its `ask` tool can delegate mutations and is deliberately excluded. Teams, calendar, people, and public Learn reads remain available. Shared WorkIQ/Teams connections retain the same filters. Other default MCPs and plugins are excluded from research; coding retains its worktree and publishing boundaries.

A question such as "What is my latest message on the PDF group from yesterday?" needs no special flow. Agency receives the original request, UTC time and local timezone, instructions to clarify ambiguous identities, distinguish missing access from no matches, and return a short answer first with sources afterward. Source scope and a five-page retrieval limit are prompt instructions, not enforced authorization or an evidence-validation system. Account/tenant binding and per-resource consent are not implemented. Turning access Off affects subsequent launches; sessions prepared under different access settings cannot resume. It does not cancel an in-flight read or erase retained history.

Read-only tasks hide raw tool progress from app observations/logs and do not request Hub reporting, but the question and final answer remain in task history, and Agency retains its own session data. Answers may be spoken aloud. Local voice does not make delegated Agency processing local-only. Read sessions have a three-minute execution deadline.

`send_work_message` resumes finished tasks or queues up to ten messages while work runs. Messages persist and execute FIFO in the original session, which evaluates natural-language conditions against its prior results. Queuing acknowledges receipt, not completion. Failure, shutdown, or restart pauses pending messages; nothing automatically replays after restart. Send a corrective follow-up to recover, then the remaining queue drains after success, or delete the inactive task to discard its queue. Task details show pending messages. No condition parser or extra Luna coordinator is involved.

Run `npm run agency:read:check` to verify shared HTTP connections, rejected shell/write/WorkIQ `ask` calls, a public Learn read, WorkIQ path metadata, and queued same-session follow-up using a local synthetic model. It reads no business content. `npm run agency:check` checks a real hosted coding session and a queued conditional follow-up on a disposable repository, with short context by default.

## Local Voice

Local setup is opt-in and requires explicit download consent. It provisions:

- Ling through llama.cpp for local chat and tool calls.
- Moonshine Streaming Tiny Q4_K through CrispASR with Silero VAD by default (English).
- Whisper Small with CPU INT8 inference as an optional multilingual recognizer.
- Kokoro in an isolated Python 3.12 environment for speech synthesis.

Files are stored under `%LOCALAPPDATA%\VoiceSupervisor` in `models`, `runtimes`, and cache directories. Verified files are reused; partial or mismatched downloads are never reported ready. Setup does not edit `.env`, system Python, or `PATH`. If speech setup fails, verified local chat remains available.

Moonshine uses JSON streaming, 500 ms steps, a 4-second rolling window/partial cadence, 800 ms end silence, and full-utterance final redecoding. Existing saved provider choices and explicit environment overrides still win; source users upgrading from Small should update `MOONSHINE_MODEL` and stale streaming overrides to match [example.env](example.env). Partial text is provisional. The Tiny model and tokenizer share a pinned, verified upstream revision.

For individual source-workflow downloads:

```powershell
npm run models -- all
npm run models -- runtimes
npm run models -- whisper
npm run models -- moonshine
npm run models -- task-search
```

Pinned URLs, revisions, sizes, and SHA-256 values are owned by [scripts/models.mjs](scripts/models.mjs). Python package inputs are in [requirements-local.txt](requirements-local.txt), [requirements-whisper.txt](requirements-whisper.txt), and [requirements-kokoro-pack.in](requirements-kokoro-pack.in).

Windows releases use the same pinned, hash-verified Kokoro and faster-whisper dependency pack. **Bundled** includes the pack for environments where Python package sources are blocked. **Online** downloads it after setup consent. Both still download selected models and native runtimes; neither is a fully offline installer.

Setup reuses verified files before downloading. Set `LOCAL_VOICE_PACK_FILE` in the app's `.env` to a matching offline release pack, or `LOCAL_VOICE_PACK_URL` to an HTTPS mirror. The mirror and release URL must provide identical pinned bytes; TLS and SHA-256 verification remain mandatory. Interrupted pack downloads resume when the source supports ranges. If every source fails, setup reports an error and preserves working chat. Source builds without a pack keep their existing package-index fallback.

First-time voice setup adds pack extraction time and several GB of temporary disk use. Expanded wheels are removed after successful setup; Online retains the compressed pack for recovery. Model downloads, later launches, and inference are unchanged.

Use trusted HTTPS sources and keep TLS verification enabled. An existing Python 3.12 x64 path and package mirrors can be configured in Settings. Setup reports the sanitized startup failure without guessing its cause; an installed component is not necessarily a running component.

## Calls And Notifications

Idle calls check in after 40 seconds and end after 60 seconds by default. Settings > Idle calls changes either value or disables automatic hang-up. User speech or Stay connected resets the timer; an active reply is allowed to finish. A resumed window always leaves time to answer the check-in.

Task announcements are queued and deduplicated; simultaneous completions do not speak over each other. The notification bell keeps the latest 100 updates across restarts, independently of whether they were spoken. Open an update to inspect its task, or mark the displayed updates read. New arrivals remain unread. Quiet mode suppresses spoken task updates without removing inbox history.

All call-ending paths share the current theme's end-call cue, subject to sound and volume settings. Copilot and Baymax share the new action cue. Local runtime shutdown after a call is intentional, not an installation failure.

## Data And Security

- HTTP, SSE, and WebSocket listeners bind to loopback only.
- Provider keys stay in the server process and local config file.
- Runtime state, models, caches, and logs stay under `%LOCALAPPDATA%\VoiceSupervisor`.
- Logs are replaced or bounded; setup diagnostics are sanitized before presentation.
- Models, credentials, state, tests, and generated installers are excluded from packaged builds.
- Uninstall retains user data and model caches unless the user removes them while the app is closed.

The installer is unsigned unless the distributor adds signing. Windows SmartScreen or organizational policy may block it; do not bypass those controls.

## Desktop Builds And Releases

Build both unsigned per-user Windows x64 installers (requires Python 3.12 x64):

```powershell
npm run dist:win
```

Outputs under `release/`: `Voice Work Supervisor-Setup-<version>.exe` (Bundled), `Voice Work Supervisor-Setup-<version>-Online.exe`, the shared dependency pack, and SHA-256 sidecars. Use `npm run dist:win:bundled` or `npm run dist:win:online` for one edition. Both use the Copilot sprite as the app icon and run packaged startup checks.

Compression preserves dependency contents and excludes only other-platform ONNX binaries. Changed packs require recompression and a clean offline-install check; unchanged packs are reused. Building both editions takes longer, but smaller uploads offset some publishing time. Generated assets remain ignored.

From a clean `master` branch, publish a beta either locally or through GitHub Actions:

```powershell
npm run release:beta:local
npm run release:beta
```

Both flows run validation and publish both installers, the matching dependency pack, and their SHA-256 sidecars. The local flow requires an authenticated GitHub CLI. The in-app updater preserves the installed edition; older installations remain Bundled. Do not publish an Online installer without its pinned dependency archive.

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