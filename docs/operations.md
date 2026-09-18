# Operations Reference

This document holds operational detail that is useful to maintainers and distributors but too specialized for the main README.

## Runtime Data

The desktop app stores configuration, task state, logs, models, runtimes, and caches under `%LOCALAPPDATA%\VoiceSupervisor` by default. Source runs can override the location with `SUPERVISOR_DATA_DIR`, `SUPERVISOR_CACHE_DIR`, and `SUPERVISOR_CONFIG_DIR`.

Use **Settings > Config** for supported provider, model, endpoint, default, and local-performance values. Secrets stay in the server process and are never returned to the browser. A source-only `.env` file remains available for automation and settings not exposed in the UI; never commit it.

Provider changes apply to new sessions. Fields marked **Restart required** need an app restart, not a rebuild.

## Voice Routes

- **Native Voice** uses OpenAI Realtime or Google Gemini Live.
- **Dedicated Models** independently select Local, OpenAI, or Google for speech recognition, language generation, and speech synthesis.
- Cloud stages require **Allow cloud processing**.

Local setup is opt-in and requires explicit download consent. It provisions Ling through llama.cpp, Moonshine Streaming Tiny Q4_K with Silero VAD, optional multilingual Whisper Small with CPU INT8 inference, and Kokoro in an isolated Python 3.12 environment.

Verified files are reused. Partial or mismatched downloads are never reported ready. Setup does not modify system Python, `PATH`, or `.env`; if speech setup fails, verified local chat remains available.

Older configurations can still select the larger Moonshine Small model. In **Settings > Config > Local speech**, clear **Moonshine model path** to select managed Tiny, save, and restart. This overrides an old `MOONSHINE_MODEL` value without editing `.env` or replacing a custom model. Run consented local setup if Tiny is not installed. The portable CPU runtime and CPU-scaled threads remain the defaults; target-device latency and recognition accuracy vary.

Windows releases share a pinned, hash-verified Python dependency pack:

- **Bundled** carries the pack for environments where package sources are blocked.
- **Online** downloads the same pack after consent.

Both editions still download selected models and native runtimes. For an approved offline source, set `LOCAL_VOICE_PACK_FILE`; for an approved HTTPS mirror, set `LOCAL_VOICE_PACK_URL`. TLS, size, and SHA-256 checks remain mandatory. The app resumes interrupted downloads when the server supports ranges.

Source-only downloads:

```powershell
npm run models -- all
npm run models -- runtimes
npm run models -- whisper
npm run models -- moonshine
npm run models -- task-search
```

Pins and checksums live in [scripts/models.mjs](../scripts/models.mjs). Python inputs live in [requirements-local.txt](../requirements-local.txt), [requirements-whisper.txt](../requirements-whisper.txt), and [requirements-kokoro-pack.in](../requirements-kokoro-pack.in).

## Agency Delegation

Fresh installations default to Agency; existing saved choices remain unchanged. Coding sessions run in isolated worktrees and may use the Agency MCPs available to the signed-in client.

Read-only questions always use Agency. Public Microsoft Learn access is available by default. Enterprise research is opt-in under **Settings > Config > Coding tools > Agency work data** (`AGENCY_WORK_DATA_ACCESS=read-only`). It permits a fixed read-only set for WorkIQ, Teams, calendar, and people; WorkIQ `ask`, shell, filesystem, URL, repository, and mutation tools are excluded from the research profile.

Install and sign in to [Agency](https://aka.ms/agency), or set its executable in **Coding tools**. Save the work-data choice, then use **Settings > Integrations > Check connections**. Checks read tool catalogs only, report missing tools or sign-in/connectivity failures, and never enable private access themselves. Failed proxies retry on the next attempt. Follow-ups refresh the restricted profile from current consent and retain the same task/session, so an access repair does not require duplicate work. A supervisor research task already exists before its worker starts; its read-only boundary prevents external mutations, not local task creation.

Important boundaries:

- A listening local MCP endpoint does not prove account access or tenant identity.
- Account binding, per-resource authorization, and evidence validation are not implemented by this app.
- Disabling work-data access affects subsequent launches, not an in-flight read.
- Questions and answers remain in app task history; Agency may retain its own session data.
- Answers may be spoken aloud, so local voice does not make delegated research local-only.
- Read sessions have a three-minute deadline.

`send_work_message` queues up to ten messages for an active task and resumes the same session in FIFO order. Failure, shutdown, or restart pauses the queue. A corrective follow-up can resume it; deleting an inactive task discards its pending queue.

Checks:

```powershell
npm run agency:read:check
npm run agency:check
```

The first uses a local synthetic model and reads no business content. The second uses an authenticated hosted coding session on a disposable repository.

## Calls And Notifications

Idle calls check in after 40 seconds and end after 60 seconds by default. Both values can be changed or automatic hang-up can be disabled. User speech and **Stay connected** reset the timer; active generation and playback are allowed to finish.

Task announcements are queued and deduplicated. The inbox keeps the latest 100 heading-only updates across restarts; full answers stay in task details. Clear/read actions remove pending announcements for those entries. Quiet mode suppresses spoken announcements without deleting inbox history.

Calls greet once after connection unless **Settings > Calls > Greet when a call connects** is off. Local greetings use speech synthesis without an LLM request. Text chat and local/hybrid voice retain tool-round text as internal context, publishing only the final completed tool-free response; incomplete streams fail without speaking an unverified answer. This trades some first-audio latency for evidence-backed outcomes. Native hosted realtime speech remains provider-controlled.

The compact `control_app` tool allows theme changes, clearing/reading notifications, and enabling/disabling spoken updates. It cannot change credentials, Agency consent, or download consent.

## Security Boundaries

- HTTP, SSE, and WebSocket listeners bind to loopback only and enforce same-origin requests.
- Provider keys remain in local server configuration and are not sent back to the renderer.
- Logs are bounded or replaced, and setup errors are sanitized before display.
- Models, credentials, mutable state, tests, and generated installers are excluded from packaged app files.
- Uninstall retains user data and model caches until the user removes them while the app is closed.
- Installers are unsigned unless the distributor adds code signing. Do not bypass SmartScreen or organizational policy.

## Windows Distribution

Build both unsigned per-user Windows x64 installers with Python 3.12 x64 available:

```powershell
npm run dist:win
```

Use `npm run dist:win:bundled` or `npm run dist:win:online` for one edition. Outputs are written to `release/` with SHA-256 sidecars. The in-app updater preserves the installed edition.

From a clean `master` branch with a committed stable package version and matching release notes:

```powershell
npm run release:stable:local
```

The local publisher audits runtime dependencies, builds and tests the UI, builds both installers, smoke-tests packaged runtimes, checks archives, then atomically pushes the version tag and publishes a non-prerelease. It also publishes `invoke-update.json` for API-independent update checks. Electron networking uses the system proxy; downloads still require trusted URLs and matching checksums. No GitHub token is stored by the application. Beta installs require a manual Invoke install.

To publish a beta instead:

```powershell
npm run release:beta:local
npm run release:beta
```

Both flows validate and publish both installers, the matching dependency pack, and checksums. The local flow requires an authenticated GitHub CLI. Never publish the Online installer without its pinned dependency archive.

## Release Checks

```powershell
npm run build
npm test
node --test test/setup.test.mjs test/desktop.test.mjs
```

To check an already-built executable:

```powershell
$env:SUPERVISOR_PACKAGED_EXE = (Resolve-Path '.\release\win-unpacked\Invoke.exe').Path
node --test test/desktop.test.mjs
Remove-Item Env:SUPERVISOR_PACKAGED_EXE
```

Target-device validation is still required for physical microphone/speaker behavior, first-time downloads, provider quotas, Windows policy, and code signing.
