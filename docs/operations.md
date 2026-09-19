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

Local setup is opt-in and requires explicit download consent. It provisions Gemma through llama.cpp, multilingual Whisper Small with CPU INT8 inference by default, and Kokoro in an isolated Python 3.12 environment. Moonshine Streaming Tiny Q4_K with Silero VAD is an explicit alternative. Saved recognizer choices are preserved.

The managed language model is **Gemma 4 E2B IT QAT Q4_0**, from Google's official GGUF repository at revision `675cff42a74c774d6cb76f76d8eacb49b48c9b93`. Its verified size is 3,349,516,256 bytes and SHA-256 is `fa401b55b07ee70a54c6dae3903c783a6e65064312529ea57175cb5f8dec6634`. Only text weights are needed; no multimodal projector is downloaded. It is smaller on disk than Ling Quality (5.77 GB), but slower in the measured CPU tool workflow below. Keep at least 18 GB free for setup and dependencies, plus space for retained models. Internal asset key `ling` and endpoint alias `ling-local` remain compatible; they do not identify the loaded model's architecture.

On startup, a completed managed Ling Compact or Quality setup with a matching verification receipt downloads and verifies Gemma under the existing setup lock. Fresh installs still require consent; explicit `LOCAL_LLM_PATH` and other custom files are not upgraded. The saved selection changes only after the new model starts successfully. Old files remain, including on download failure; there is no silent fallback or deletion. Setup reports failures, and retry/restart can resume provisioning. Set an explicit custom path to retain Ling.

Verified files are reused. Partial or mismatched downloads are never reported ready. Setup does not modify system Python, `PATH`, or `.env`; if speech setup fails, verified local chat remains available.

Older configurations can still select the larger Moonshine Small model. In **Settings > Providers & keys > Local speech**, clear **Moonshine model path** to select managed Tiny, save, and restart. This overrides an old `MOONSHINE_MODEL` value without editing `.env` or replacing a custom model. Run consented local setup if Tiny is not installed. The portable CPU runtime and CPU-scaled threads remain the defaults; target-device latency and recognition accuracy vary.

For existing Moonshine installations, choose **Whisper** under **Local speech** and complete setup. Whisper transcribes complete utterances rather than streaming partial words. `WHISPER_END_SILENCE_MS` and `END_SILENCE_MS` default to 1400 ms and are editable in Settings; saved or environment overrides are preserved. With Whisper, push-to-talk starts an explicit segment and releases it on commit, so an internal pause does not submit a partial request. Hands-free mode still uses VAD endpointing. Moonshine retains its own endpointing during push-to-talk. Clear **Local GGUF path** in Settings to override a legacy environment path and use managed Gemma after restart.

Whisper **early decoding** overlaps recognition with the existing hands-free silence window. After 480 ms of silence, an idle decoder may begin one provisional transcription per utterance, using the same INT8 model, automatic language detection, beam size 5 and trailing padding as the final decode. The result stays private until the normal endpoint accepts exactly the same PCM and utterance metadata. Resumed speech cancels reuse; the complete request is decoded normally. There is no earlier endpoint, provisional tool execution or provisional spoken answer. Push-to-talk and Moonshine are unchanged, and no additional model or dependency is needed.

Early decoding defaults to On. Set **Settings > Providers & keys > Local speech > Whisper early decoding** to Off, or `WHISPER_PREDECODE_MS=0`, then restart to restore endpoint-only decoding. Native inference already in progress cannot be forcibly preempted; cancellation is checked between stages/segments. Speculation is skipped while the decoder is busy, limited to one attempt per utterance, and cannot displace queued confirmed work. Mid-sentence pauses can waste CPU, and slower or heavily loaded devices may see higher latency. No learned endpoint detector or early LLM speech streaming is enabled: those require separate cutoff and answer-completion quality validation.

Local generation disables thinking both in the request (`enable_thinking: false`) and managed llama.cpp startup (`--reasoning off`). Warm-up uses the same voice tool schema as live calls. Prompt caching, a 4096-token context and one slot remain the defaults. Kokoro now defaults to at most eight threads, leaving one logical CPU available; explicit `KOKORO_THREADS`/`LOCAL_THREADS` overrides win. Existing saved settings are never silently retuned. Streaming chat rendering is coalesced to one update per animation frame.

The system prompt and tool definitions are rebuilt in full on every local routing request, including tool continuations; the isolated final summary uses its own answer-only system prompt. There is no timed context reset. Before each request, the app estimates the prompt against `LLAMA_CONTEXT / LLAMA_PARALLEL`, reserving 512 tokens for the answer and 256 for overhead. It drops oldest complete conversation turns first, then compacts tool payloads while retaining current-turn exchanges. If the latest instruction and required evidence still cannot fit, it reports an error instead of truncating them or the system prompt. Managed llama.cpp explicitly disables context shifting; externally managed servers must use `--no-context-shift` too. Token estimates are not exact, so the server can still reject an oversized request. Prompt caching reuses computation, not additional conversational memory.

Local voice retains at most 12 user/assistant messages, roughly six exchanges, within a voice session; a new session starts fresh. Typed chat has no fixed turn-count reset, but each local request is fitted as above; Clear Chat resets its conversation. Discarded history is not automatically summarized. Saved tasks remain available through fresh tool lookups independently of conversational history.

Generating reasoning tokens delays the first answer and consumes the same local compute budget. Invoke keeps thinking disabled for the voice coordinator; complex work remains delegated. Hiding reasoning text alone would not eliminate that generation cost.

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

### Local Acceptance Checks

Run `node scripts/bench-local.mjs llm compact-f16` for real-model synthetic task scenarios and `node scripts/bench-local.mjs stt whisper` for synthesized English speech through the production recognizer. Set `PYTHON_BIN` to the provisioned environment for the standalone speech benchmark. These checks do not operate on real tasks or read private business data; they are separate from deterministic `npm test`. The LLM benchmark exits unsuccessfully when any scenario fails. `BENCH_SEED` changes its generation seed; `BENCH_NATIVE=1` compares native tool calling through the existing custom-provider adapter without changing production routing.

September 19 comparison: llama.cpp b10970 CPU, Threadripper PRO 5955WX, 128 GB RAM, eight threads, 4096-token context, one slot, F16 KV, thinking off, temperature 0.2, seed 42. The same initial tightened protocol and 16 synthetic cases produced:

| Model | Passed | Median Whole Turn |
| --- | --- | --- |
| Gemma 4 E2B IT QAT Q4_0 | 16/16 | 6.07 s |
| Ling APEX-I Quality | 15/16 | 1.74 s |
| MiniCPM5-2B Q6_K | 5/16 | 3.11 s |

After receipt-grounded task-ID grammar, exact-ID query lookup and subject-to-ID receipt reuse, the final Gemma run passed **21/21** at seed 73 (median **6.69 s**, range **1.33-18.36 s**). It adds stop/open, coding delegation, a VS Code note and an explicit no-delete conversation. The original gate covers status/search/ambiguity, delegation/follow-up, single/bulk deletion, preferences, inbox and hang-up. All actions use synthetic callbacks. Intermediate runs exposed duplicate follow-ups and invalid IDs; deterministic regressions cover those fixes. The older 8/11 Ling result predates this API and is superseded, not evidence of a model-only improvement.

These are small acceptance samples, not general accuracy scores. Even minor catalog wording changed routing. The checks validate action/receipt contracts and basic spoken-output constraints, not complete semantic correctness. They do not cover noisy speech, arbitrary paraphrases, physical audio, sustained load or laptop performance. The compared models were not rerun on every final refinement. MiniCPM's publisher recommends different native parsing/sampling (including `min_p:0` for llama.cpp); these results describe this app's non-thinking schema protocol, not its maximum capability. Use explicit task controls for consequential actions.

Model research: [Google Gemma QAT](https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-gguf) is the chosen Apache-2.0 GGUF and works with the existing runtime. QAT quality preservation is a publisher claim, not a BF16 comparison performed here. [MiniCPM5-2B](https://huggingface.co/openbmb/MiniCPM5-2B) is also Apache-2.0, but its published tool scores did not transfer to this workflow. [Needle3](https://huggingface.co/Cactus-Compute/needle3) is a compact structured-output specialist using Cactus `.cact` assets, not a drop-in general-chat GGUF; adopting it needs another runtime/answer model. [LFM2.5-1.2B](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct) supports edge tool use and llama.cpp, but uses the LFM license and was not benchmarked here. Neither untested option replaces the measured default.

On a Threadripper PRO 5955WX, Whisper Small INT8 recognized all six clean synthetic English samples exactly (three lengths in two modes). Final recognition took about 1.9-2.3 seconds after push-to-talk release and 3.4-3.7 seconds after speech in hands-free mode, including its silence threshold. Segmenter regressions cover a one-second internal pause and a held push-to-talk pause longer than three seconds. These results do not validate physical microphone quality, accents, noisy rooms, or laptop performance.

For the early-decoding comparison, run `node scripts/bench-local.mjs stt whisper-scheduling`. The benchmark runs endpoint-only and 480 ms early decoding against identical synthesized PCM, with brief, short, long, 800 ms internal-pause and 1056 ms hesitation samples in both modes. Optional sample names are `brief`, `short`, `long`, `paused`, and `hesitation`; `BENCH_STT_REPEATS=1..5` repeats each sample. JSON output records PCM hashes, exact baseline/candidate transcript equality, expected-word equality, premature/duplicate finals, input pacing and speech-end-to-final latency. A failed quality check exits nonzero; timings are reported, not treated as portable performance guarantees. Deterministic worker checks run separately with `python -m unittest discover -s test -p whisper_worker_test.py -v`.

September 19 scheduling check on the same Threadripper, eight recognition threads, automatic language and 1400 ms endpoint: three repetitions each of `short`, `paused` and `hesitation`, across both modes and scheduling settings, produced 36 matching transcripts with no premature/duplicate finals. Short hands-free median latency fell from 3.50 s to 2.56 s (paired savings 0.92-0.94 s). Mid-sentence-pause cases retained complete requests with paired hands-free differences from 3 ms faster to 31 ms slower; push-to-talk remained about 2.1 s. These are recognition-stage measurements, not end-to-end spoken-response latency. Physical microphones, background noise, multilingual speech, sustained thermal load and low-end CPUs remain unvalidated.

### Compact Tool Contract

The manual HTTP API and Tool Lab retain advanced options. LLM text/voice catalogs omit worker `model`, `backend`, `agent` and `context`; Settings supplies them, and generated overrides are rejected before dispatch. Task controls accept `query` (subject or exact ID) or `taskId`, never both. Zero/multiple matches return clarification without mutation. Local grammar allows ID selectors only from current-turn receipts; query remains available without a lookup. Preferences use action-specific values; inbox actions take no value.

`delete_work({all:true})` processes all persisted task chats, not just the latest 25. It stops owned active work before deleting history, retains files/work areas, and reports deleted/failed/remaining counts. Unowned active work stays protected. This does not clear the separate typed conversation. Successful subject-based mutations reuse their receipt when retried with the returned ID. Failed calls remain retryable within the existing three-round/six-call budget.

Local envelopes contain either `calls` or `answer`. Read-only first batches cannot escalate to mutation; action batches may read results. This scope is derived from the model's selected calls, not an independent authorization classifier. Completed status reads return bounded outcomes directly, avoiding a second status call.

## Agency Delegation

Fresh installations default to Agency; existing saved choices remain unchanged. Coding sessions run in isolated worktrees and may use the Agency MCPs available to the signed-in client.

Omit the optional work model to use the selected default. The legacy value `default` resolves to the selected work model when creating a task; resumed legacy tasks never pass `--model default` to Agency or Copilot. Explicit model names are preserved and must be supported by the selected client.

The reported `Model "gpt-4" from --model flag is not available` is fatal model selection, separate from the ambient MCP-name warning. Generated model overrides are now blocked in text and realtime tools. Explicit manual settings and historical task models are not silently rewritten; select a supported work model for new tasks. Real hosted `agency:check` and the restricted synthetic/public-data `agency:read:check` both passed after these changes; no private business content was queried.

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

Task speech is session-scoped and latest-only. Starting a call records the existing notification IDs; they are never announced in that call, even if unread. New notifications replace the pending speech entry, so only the latest unread update received during the call is eligible. Both browser and server enforce this; stale/superseded requests are acknowledged without speech or changing old inbox read state. This is one pending announcement, not a one-announcement limit for the entire call. A pre-existing task can still produce a new update during a call.

Accepting the latest announcement marks its inbox entry read before acknowledgment. Busy sessions leave it unread. Acceptance is not proof that playback finished: interrupted announcements do not replay. Stopping/restarting clears the browser queue. The inbox keeps the latest 100 heading-only updates across restarts; full answers stay in task details. Quiet mode suppresses speech without deleting history.

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
