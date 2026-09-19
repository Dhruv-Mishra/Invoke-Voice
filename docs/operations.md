# Operations Reference

This document holds operational detail that is useful to maintainers and distributors but too specialized for the main README.

## Runtime Data

The desktop app stores configuration, task state, logs, models, runtimes, and caches under `%LOCALAPPDATA%\VoiceSupervisor` by default. Source runs can override the location with `SUPERVISOR_DATA_DIR`, `SUPERVISOR_CACHE_DIR`, and `SUPERVISOR_CONFIG_DIR`.

Applied settings survive normal app restarts. Desktop appearance, sound, sidebar, and voice-route choices are saved immediately in `preferences.json` inside the application data folder, independently of the local server's changing port. Only known non-secret preference keys are accepted; provider keys/configuration and coding defaults keep their existing server-side storage. Browser-only use retains per-origin browser storage. Clear application data removes these preferences too; an ordinary restart does not. Agency is the fresh-install coding default, while an explicitly saved Copilot CLI choice is preserved.

Use **Settings > Providers & keys** for supported provider, model, endpoint, default, and local-performance values. Secrets stay in the server process and are never returned to the browser. A source-only `.env` file remains available for automation and settings not exposed in the UI; never commit it.

Provider changes apply to new sessions. Settings prompts to save edited values when you leave; unchanged values are not resaved. Only saved changes that differ from the running configuration are marked **Restart to apply**.

### Clear Application Data

In the installed desktop app, open **Settings > Application data > Clear application data**. Cancel is focused by default. **Delete data and close** stops owned services, closes the app and removes `%LOCALAPPDATA%\VoiceSupervisor`. Reopen Invoke to set it up again; automatic restart is not guaranteed. This removes saved keys/configuration, task history, managed worktrees including uncommitted changes, downloaded models/runtimes, setup receipts, logs, browser storage and update caches. Legacy temporary updater installers are removed too. The application remains installed and local setup requires fresh download consent.

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

Local generation disables thinking both in the request (`enable_thinking: false`) and managed llama.cpp startup (`--reasoning off`). Warm-up uses the same voice tool schema as live calls. Prompt caching, a 4096-token context and one slot remain the defaults. Kokoro now defaults to at most eight threads, leaving one logical CPU available; explicit `KOKORO_THREADS`/`LOCAL_THREADS` overrides win. Existing saved settings are never silently retuned. Streaming chat rendering is coalesced to one update per animation frame.

The system prompt and tool definitions are rebuilt in full on every local routing request, including tool continuations; the isolated final summary uses its own answer-only system prompt. There is no timed context reset. Before each request, the app estimates the prompt against `LLAMA_CONTEXT / LLAMA_PARALLEL`, reserving 512 tokens for the answer and 256 for overhead. It drops oldest complete conversation turns first, then compacts tool payloads while retaining current-turn exchanges. If the latest instruction and required evidence still cannot fit, it reports an error instead of truncating them or the system prompt. Managed llama.cpp explicitly disables context shifting; externally managed servers must use `--no-context-shift` too. Token estimates are not exact, so the server can still reject an oversized request. Prompt caching reuses computation, not additional conversational memory.

Local voice retains at most 12 user/assistant messages, roughly six exchanges, within a voice session; a new session starts fresh. Typed chat has no fixed turn-count reset, but each local request is fitted as above; Clear Chat resets its conversation. Discarded history is not automatically summarized. Saved tasks remain available through fresh tool lookups independently of conversational history.

Ling supports hybrid thinking, but producing reasoning tokens delays the first answer and consumes the same local compute budget. Invoke keeps it off for the short voice coordinator; complex work remains delegated to the existing agents. Hiding reasoning text alone would not eliminate that generation cost.

Windows releases share a pinned, hash-verified Python dependency pack:

- **Bundled** carries the pack for environments where package sources are blocked.
- **Online** downloads the same pack after consent.

Both editions still download selected models and native runtimes. For an approved offline source, set `LOCAL_VOICE_PACK_FILE`; for an approved HTTPS mirror, set `LOCAL_VOICE_PACK_URL`. TLS, size, and SHA-256 checks remain mandatory. The app resumes interrupted downloads when the server supports ranges.

Verified dependency packs install with Python's bundled `pip` and `--no-index --require-hashes`, without contacting PyPI. Managed Python bootstraps pip through `ensurepip`, also offline. This avoids uv 0.8.17 rejecting the large recompressed PyTorch wheel. uv still provisions managed Python; the pack format and verification are unchanged.

Inactive calls have Off, 30s and 1 minute presets. Existing custom durations are retained. The timer pauses while speech or generation is active; there is no spoken presence check.

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

Coding and research prompts, including follow-ups, share a concise-reply default: answer first in at most two short sentences and 320 characters, followed only when needed by at most three short evidence or validation bullets. Preambles, progress recaps and repeated summaries are discouraged; explicit requests for detail can expand the answer. This is source-generation guidance, not truncation or rewriting of agent output.

Invoke launches Agency with a task-local `--profile-only` profile. This excludes ambient global Copilot MCP sources, whose server names may be incompatible with the installed CLI, without editing the user's MCP configuration. Coding sessions retain explicitly configured Invoke MCPs and repository `.github/mcp.json` or `.mcp.json`; research retains its restricted read profile. Personal/global MCPs and implicit profile plugins are not automatically inherited.

Read-only questions always use Agency. Public Microsoft Learn access is available by default. To enable Teams and calendar:

1. Install and sign in to [Agency](https://aka.ms/agency) with your work account.
2. Open **Settings > Integrations > Private work sources**, choose **Read-only**, then **Save access**. This is Invoke's saved research permission (`AGENCY_WORK_DATA_ACCESS=read-only`), not an Agency setting or a Microsoft 365 tenant authorization grant.
3. Run **Check connections** in the same section. If sign-in fails, repair it in Agency, then retry.

Saving access applies immediately to the next research task or follow-up; no restart is needed. An already-running worker keeps its launch-time permissions, so stop it and retry or send a follow-up when it finishes.

Installing Agency alone does not start Teams MCP. Invoke's existing startup launcher explicitly runs `agency mcp --transport http --port 0 teams` (and corresponding WorkIQ/Bluebird commands), reuses the resulting loopback connections, and closes its owned proxies on exit. No separate scheduled task or global MCP configuration is needed. Calendar and people proxies start on demand or during enabled research checks. For manual STDIO clients, Agency exposes `agency mcp teams`; it stays running until the client disconnects. Private research consent is never enabled on startup. It permits a fixed read-only set for WorkIQ, Teams, calendar, and people; WorkIQ `ask`, shell, filesystem, URL, repository, and mutation tools are excluded from the research profile.

Install and sign in to [Agency](https://aka.ms/agency), or set its executable in **Coding tools**. Save the work-data choice, then use **Settings > Integrations > Check connections**. Checks read tool catalogs only, report missing tools or sign-in/connectivity failures, and never enable private access themselves. Failed proxies retry on the next attempt. Follow-ups refresh the restricted profile from current consent and retain the same task/session, so an access repair does not require duplicate work. A supervisor research task already exists before its worker starts; its read-only boundary prevents external mutations, not local task creation.

Important boundaries:

- A listening local MCP endpoint does not prove account access or tenant identity.
- Account binding, per-resource authorization, and evidence validation are not implemented by this app.
- Disabling work-data access affects subsequent launches, not an in-flight read.
- Questions and answers remain in app task history; Agency may retain its own session data.
- Answers may be spoken aloud, so local voice does not make delegated research local-only.
- Read sessions stop after three minutes without tool/answer progress or ten minutes total. Active source reads can continue past three minutes; timeouts report the last phase and retain the session for retry. Read-only reasoning uses low effort; coding reasoning settings are unchanged.

`send_work_message` queues up to ten messages for an active task and resumes the same session in FIFO order. Failure, shutdown, or restart pauses the queue. A corrective follow-up can resume it; deleting an inactive task discards its pending queue.

`cancel_work(taskId)` and the task Stop controls abort that task's preparation or owned worker process, cancel all queued follow-ups, and retain worktrees and history. State stays `cancelling` until execution settles, then becomes `cancelled`; late output cannot mark it successful. Stopping is not rollback: completed file edits and external actions remain. A prepared task can be continued explicitly afterward; its discarded queue does not replay.

One Agency process can use many model turns and source calls before producing its answer. Progress identifies the enabled source, read count, completion or failure, and answer preparation without recording private arguments or source contents. The worker is instructed to stop when evidence suffices, avoid identical failed reads, and use at most eight source calls; this instruction is not an enforced authorization boundary.

Checks:

```powershell
npm run agency:setup:check
npm run agency:read:check
npm run agency:check
```

`agency:setup:check` reuses the app launcher to verify all six tool catalogs, then closes its temporary proxies; it neither reads business content nor saves consent. `agency:read:check` uses a local synthetic model, public Learn content and WorkIQ schema metadata to verify permission rejection and same-session follow-ups. `agency:check` uses an authenticated hosted coding session on a disposable repository.

## Calendar

**Open Outlook** opens `https://outlook.office.com/calendar/` in the default browser, including from Electron. Outlook and Teams share the signed-in Microsoft 365 work calendar. **Check today** dispatches `start_work` with `backend: agency` and `readOnly: true`, using the existing calendar read tools and work-account timezone. The result stays in normal task details and can be followed up in the same session. With consent off, the button opens the exact consent control and makes no calendar request. Voice/chat calendar questions use the same tool; no extra model tool or background calendar polling is needed. Tool availability does not prove tenant authorization; failed access is not an empty schedule.

## Calls And Notifications

Idle calls end after 60 seconds by default, without a presence check. Choose Off, 30s or 1 minute in Settings; existing custom durations are retained. User speech resets the timer; active generation and playback are allowed to finish.

Task announcements are queued and deduplicated. Accepting an announcement marks its existing inbox entry read before acknowledging delivery, so reconnects and restarts cannot replay it. Busy sessions leave it unread. Acceptance is not proof that playback finished: interrupted announcements remain in the inbox but do not automatically replay. The inbox keeps the latest 100 heading-only updates across restarts; full answers stay in task details. Clear/read actions remove pending announcements for those entries. Quiet mode suppresses spoken announcements without deleting inbox history.

Calls greet once after connection unless **Settings > Calls > Greet when a call connects** is off. Local greetings use speech synthesis without an LLM request. Local chat and voice use schema-constrained JSON turns and publish only completed answers. Tool batches are validated before execution. After tools, an isolated answer-only request receives bounded results without task/session IDs or action lists; routing prose is not published. This costs an additional local generation pass. Model prose is not rewritten, and source-authored result text still relies on summary instructions to omit internal details. Incomplete streams publish no answer. Hosted text routes also buffer final answers; native hosted realtime speech remains provider-controlled.

The compact `control_app` tool allows theme changes, clearing/reading notifications, and enabling/disabling spoken updates. It cannot change credentials, Agency consent, or download consent.

Gemini Live uses its default blocking tools and receives one response for the entire tool batch; no per-result asynchronous speech scheduling is added. OpenAI Realtime executes completed tool batches and requests one continuation after all results, rather than one response per tool. Incomplete tool turns do not execute, and interrupted pending batches do not trigger late speech. The voice-only `end_call` tool remains available without an extra confirmation instruction.

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
