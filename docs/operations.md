# Operations Reference

This document holds operational detail that is useful to maintainers and distributors but too specialized for the main README.

## Runtime Data

The desktop app stores configuration, task state, logs, models, runtimes, and caches under `%LOCALAPPDATA%\VoiceSupervisor` by default. Source runs can override the location with `SUPERVISOR_DATA_DIR`, `SUPERVISOR_CACHE_DIR`, and `SUPERVISOR_CONFIG_DIR`.

Use **Settings > Providers & keys** for supported provider, model, endpoint, default, and local-performance values. Secrets stay in the server process and are never returned to the browser. A source-only `.env` file remains available for automation and settings not exposed in the UI; never commit it.

Provider changes apply to new sessions. Fields marked **Restart required** need an app restart, not a rebuild.

### Clear Application Data

In the installed desktop app, open **Settings > Application data > Clear application data**. Cancel is focused by default. **Delete data and restart** stops owned services, closes the app and removes `%LOCALAPPDATA%\VoiceSupervisor` before the new renderer starts. This removes saved keys/configuration, task history, managed worktrees including uncommitted changes, downloaded models/runtimes, setup receipts, logs, browser storage and update caches. Legacy temporary updater installers are removed too. The application remains installed and local setup requires fresh download consent.

External repositories and custom paths outside that data folder, source `.env`, system Python, Agency credentials/session storage and cloud-provider records are not removed. Directory links are not followed into external files. Source/browser runs cannot invoke desktop reset. If Windows prevents deletion, startup reports failure instead of claiming completion; close other processes holding the data folder and retry the reset launch. The reset marker is retained while contents are removed. External Git repositories may retain stale worktree registrations until `git worktree prune` is run in those repositories.

## Voice Routes

- **Native Voice** uses OpenAI Realtime or Google Gemini Live.
- **Dedicated Models** independently select Local, OpenAI, or Google for speech recognition, language generation, and speech synthesis.
- Cloud stages require **Allow cloud processing**.

Local setup is opt-in and requires explicit download consent. It provisions Ling through llama.cpp, Moonshine Streaming Tiny Q4_K with Silero VAD, optional multilingual Whisper Small with CPU INT8 inference, and Kokoro in an isolated Python 3.12 environment.

The managed language model is **Ling APEX-I Quality**, pinned at repository revision `b923d16fcf28261f12be9ece2b520ed442403f70`. Its published size is 5,767,290,976 bytes and SHA-256 is `946e158b7876f0d0044a2d11f0ae5fa0d15e947597a5109649e1c584aaa8d8bf`. The publisher describes it as the highest-accuracy variant; it is slightly smaller than Balanced (5.96 GB), but larger than Compact (3.99 GB). No independent comparison was performed. More memory use can reduce throughput on constrained machines. Plan for about 7-8 GB of downloads plus Python dependencies and at least 18 GB free disk, with extra space for retained models.

On startup, a completed managed Compact setup with a matching verification receipt automatically downloads and verifies Quality under the existing setup lock. No new consent is needed for this update to a previously consented installation. Fresh installs still require consent; explicit `LOCAL_LLM_PATH` and other custom files are not upgraded. The saved selection changes only after Quality starts successfully. The old file is retained, including on download failure; there is no silent fallback or deletion. Setup reports failures, and retry/restart can resume provisioning. Use an explicit custom model path to retain Compact on memory-constrained machines.

Verified files are reused. Partial or mismatched downloads are never reported ready. Setup does not modify system Python, `PATH`, or `.env`; if speech setup fails, verified local chat remains available.

Older configurations can still select the larger Moonshine Small model. In **Settings > Providers & keys > Local speech**, clear **Moonshine model path** to select managed Tiny, save, and restart. This overrides an old `MOONSHINE_MODEL` value without editing `.env` or replacing a custom model. Run consented local setup if Tiny is not installed. The portable CPU runtime and CPU-scaled threads remain the defaults; target-device latency and recognition accuracy vary.

Local generation disables thinking both in the request (`enable_thinking: false`) and managed llama.cpp startup (`--reasoning off`). Warm-up uses the same nine-tool voice schema as live calls. Prompt caching, a 4096-token context and one slot remain the defaults. Kokoro now defaults to at most eight threads, leaving one logical CPU available; explicit `KOKORO_THREADS`/`LOCAL_THREADS` overrides win. Existing saved settings are never silently retuned. Streaming chat rendering is coalesced to one update per animation frame.

Ling supports hybrid thinking, but producing reasoning tokens delays the first answer and consumes the same local compute budget. Invoke keeps it off for the short voice coordinator; complex work remains delegated to the existing agents. Hiding reasoning text alone would not eliminate that generation cost.

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

Read-only questions always use Agency. Public Microsoft Learn access is available by default. To enable Teams and calendar:

1. Install and sign in to [Agency](https://aka.ms/agency) with your work account.
2. Open **Settings > Integrations > Private work sources**, choose **Read-only**, then **Save config**. This opens **Providers & keys > Coding tools > Private work sources** (`AGENCY_WORK_DATA_ACCESS=read-only`).
3. Return to **Integrations > Check connections**. If sign-in fails, repair it in Agency, then retry.

The app starts its Teams MCP connection automatically; private research consent is never enabled on startup. It permits a fixed read-only set for WorkIQ, Teams, calendar, and people; WorkIQ `ask`, shell, filesystem, URL, repository, and mutation tools are excluded from the research profile.

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

## Calendar

**Open Outlook** opens `https://outlook.office.com/calendar/` in the default browser, including from Electron. Outlook and Teams share the signed-in Microsoft 365 work calendar. **Check today** dispatches `start_work` with `backend: agency` and `readOnly: true`, using the existing calendar read tools and work-account timezone. The result stays in normal task details and can be followed up in the same session. With consent off, the button opens the exact consent control and makes no calendar request. Voice/chat calendar questions use the same tool; no extra model tool or background calendar polling is needed. Tool availability does not prove tenant authorization; failed access is not an empty schedule.

## Calls And Notifications

Idle calls check in after 40 seconds and end after 60 seconds by default. Both values can be changed or automatic hang-up can be disabled. User speech and **Stay connected** reset the timer; active generation and playback are allowed to finish.

Task announcements are queued and deduplicated. The inbox keeps the latest 100 heading-only updates across restarts; full answers stay in task details. Clear/read actions remove pending announcements for those entries. Quiet mode suppresses spoken announcements without deleting inbox history.

Calls greet once after connection unless **Settings > Calls > Greet when a call connects** is off. Local greetings use speech synthesis without an LLM request. Local-model chat and voice stream text immediately rather than waiting for generation to finish. The prompt requires silent tool use, receipt-backed outcomes, brief answers, and task titles rather than internal IDs; it is guidance, not a guarantee that a model will comply. Reasoning tags remain suppressed; model prose is not rewritten. Truncated tools never execute, and incomplete streams still report failure, although already-streamed text may have been displayed or spoken. Non-local text-model routes retain completed-final-answer buffering. Native hosted realtime speech remains provider-controlled.

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
