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

Early decoding defaults to On. Set **Settings > Providers & keys > Local speech > Whisper early decoding** to Off, or `WHISPER_PREDECODE_MS=0`, then restart to restore endpoint-only decoding. Native inference already in progress cannot be forcibly preempted; cancellation is checked between stages/segments. Speculation is skipped while the decoder is busy, limited to one attempt per utterance, and cannot displace queued confirmed work. Mid-sentence pauses can waste CPU, and slower or heavily loaded devices may see higher latency. No learned endpoint detector is enabled.

When a provisional transcript completes, the worker emits a private `provisional` event. With a local language model, Regular routing and **Early reply preparation** On (default), the voice session sends the exact first-round request for that transcript with `max_tokens: 1`, so llama.cpp has the prompt cached when the normal endpoint confirms the same utterance. The provisional text is never shown, spoken or used for tools; resumed speech aborts the preparation request, and a changed final transcript simply reuses the cached prefix up to the user turn. Scored routing, Moonshine and push-to-talk skip it. Measured on the reference machine, the following request processed 1-4 prompt tokens instead of 19-26, saving about 0.1 s (Gemma) to 0.3 s (Qwen) of prompt time; that is below the run-to-run noise of the six-turn end-to-end voice harness, so treat it as a small saving for short utterances.

Structured local answers stream: once the JSON grammar has emitted `{"answer":"`, decoded answer text is published to captions and Kokoro incrementally, so speech begins on the first phrase instead of after the envelope closes. Tool envelopes and post-tool routing markers are never published. A later stream failure can still follow already-spoken text.

Local routing uses a **256-token reasoning budget**, with zero reasoning tokens for tool-free summaries. The existing `enable_thinking: false` and `--reasoning off` flags did not prevent Gemma from generating hidden reasoning in llama.cpp b10970; request-level `reasoning_budget` is required to bound it. **Local LLM thinking tokens** in Settings controls `LLAMA_REASONING_BUDGET` (-1 unlimited, 0 disabled, up to 512); restart after changing it. Zero and smaller budgets caused tool-routing regressions in the checks below. Model weights and quantization are unchanged.

Warm-up uses the same structured voice tool contract as live calls. Prompt caching, 4096-token context, one slot and F16 KV cache remain the Gemma defaults. The Gemma thread default is now the estimated physical core count (half the logical CPUs, capped at 16); on the reference Threadripper this raised llama-bench prompt processing from 181 to 293 tokens/s and generation from 27.0 to 36.5 tokens/s versus the previous cap of eight. Explicit `LLAMA_THREADS` values are unchanged. The loader uses `auto` instead of forcing `mmap`; GPU layers and flash attention remain automatic where supported. Advanced environment overrides `LLAMA_THREADS_BATCH`, `LLAMA_BATCH_SIZE` and `LLAMA_UBATCH_SIZE` independently control prompt processing (defaults: decode thread count, 256 and 256). Benchmark on the target device before changing them. Kokoro also defaults to at most eight threads, leaving one logical CPU available; explicit thread overrides win. Existing saved settings are not overwritten. Streaming chat rendering is coalesced to one update per animation frame.

Raw-scored routing sends its prompt through `/completion`, which lacks chat message spans. The router now passes the template's user-turn opener as `message_delimiters`, so llama.cpp creates a context checkpoint at user boundaries and a new call can reuse the cached policy prefix on SWA and hybrid-recurrent models instead of reprocessing it.

### Opt-in Qwen3.6 35B-A3B

`LOCAL_LLM_PROFILE=qwen` (**Settings > Local model**) selects [HauhauCS Qwen3.6-35B-A3B Uncensored Aggressive Q4_K_P](https://huggingface.co/HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive) at revision `f12a584fecbeb5f20001130d8ecd66c9327ae685` (23,424,536,704 bytes, SHA-256 `8d344a4336d8ea7da0cbfc12792d1471e568be7abe8930c52260698bfd01d731`). Path resolution tries `QWEN_MODEL_PATH`, `LocalVoiceStack/LLMs`, then the managed model directory; existing files outside the managed directory must match the pinned hash and are never replaced. The model is a hybrid Gated-DeltaNet/attention MoE with 256 experts, 8 routed plus one shared per token.

The release GGUF has no multi-token-prediction layer. With `QWEN_MTP=on` (default), setup range-downloads only the `blk.40` nextn layer (528,857,088 bytes, SHA-256 `4c55971b8e821de511c6c1b4dc0c5c91f4b0a64e8bd893ef5a172dd8ec90e422`) from [unsloth/Qwen3.6-35B-A3B-MTP-GGUF](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-MTP-GGUF) revision `5bc3e238d916f48a861bac2f8a1990a0e9b7e98d`, validates the source header (architecture, 40 blocks, no existing nextn layer), and writes `...-Q4_K_P-MTP.gguf` with `block_count=41` and `nextn_predict_layers=1`. The MTP layer comes from the base model, so abliteration may lower draft acceptance but cannot change verified output. The build needs the source size plus 1 GB free and is recorded with a size/mtime receipt; the source is untouched. `npm run models -- qwen` performs the same verification and build.

Qwen launches with its own settings instead of the Gemma `LLAMA_*` values: one slot (MTP requires it), `QWEN_CONTEXT` 8192, batch/ubatch 1024, flash attention on, `--load-mode none`, a 4 GB prompt-state cache and `--spec-type draft-mtp --spec-draft-n-max QWEN_DRAFT_TOKENS` (2) when the accelerated file is ready. `QWEN_THREADS` defaults to physical cores capped at 12 and `QWEN_THREADS_BATCH` to physical cores capped at 16: llama.cpp uses the batch thread count for MTP verification batches, and SMT oversubscription measurably slowed it. Memory-mapped loading kept a second resident copy of repacked weights (33.6 GB working set versus 24.2 GB). Fresh Qwen configurations default to Regular routing. The setup hardware advisory asks for 32 GB of RAM, and selecting Qwen in Settings shows a confirmation with the RAM, disk and first-load cost; cancelling restores the saved model.

For Qwen only, `localInstructions` appends five sentences to tool-round system prompts: keep the user's names, dates, exclusions and negative constraints in arguments; complete every part of a request; read before acting on a condition; say so when no tool fits; and ask when a target is ambiguous or missing. Gemma, hosted providers and text-only rounds are unchanged. In the seed-42 Jev suite this raised Qwen Regular routing from 47/54 to 49/54 with no new failures and no measurable latency change.

`LLAMA_BACKEND=vulkan` switches managed llama.cpp to the pinned b10970 Vulkan build (31,675,940 bytes, SHA-256 `f17091a433feb686d9e17378a8a2fc53a1437d64c1bf302ab6fb3072b4afcf0d`) for partial GPU offload on either model; `LLAMA_GPU_LAYERS=auto` lets llama.cpp fit layers and expert tensors to available VRAM. Small GPUs can be slower than CPU: on a 4 GB NVIDIA T400 with Qwen, Vulkan prompt processing fell from about 145 to 27-55 tokens/s while decode stayed at 16-21 tokens/s, so CPU remains the default. Measure before enabling it.

The system prompt and tool definitions are rebuilt in full on every local routing request, including tool continuations; the isolated final summary uses its own answer-only system prompt. There is no timed context reset. Before each request, the app estimates the prompt against `LLAMA_CONTEXT / LLAMA_PARALLEL`, reserving 512 tokens for the answer and 256 for overhead. It drops oldest complete conversation turns first, then compacts tool payloads while retaining current-turn exchanges. If the latest instruction and required evidence still cannot fit, it reports an error instead of truncating them or the system prompt. Managed llama.cpp explicitly disables context shifting; externally managed servers must use `--no-context-shift` too. Token estimates are not exact, so the server can still reject an oversized request. Prompt caching reuses computation, not additional conversational memory.

Local voice retains at most 12 user/assistant messages, roughly six exchanges, within a voice session; a new session starts fresh. Typed chat has no fixed turn-count reset, but each local request is fitted as above; Clear Chat resets its conversation. Discarded history is not automatically summarized. Saved tasks remain available through fresh tool lookups independently of conversational history.

Generating reasoning tokens delays the first answer and consumes the same local compute budget. Hiding reasoning text alone does not eliminate that cost. After tool results, local routing generates either the next calls or an empty completion marker, not prose that would be discarded. At the call/round limit or a deduplicated stop, it proceeds directly to the grounded summary. Dependent tool rounds, failed-call retries and receipt reuse remain intact; a successful mutation does not blindly end a multi-step request.

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
npm run models -- qwen
npm run models -- task-search
```

Pins and checksums live in [scripts/models.mjs](../scripts/models.mjs). Python inputs live in [requirements-local.txt](../requirements-local.txt), [requirements-whisper.txt](../requirements-whisper.txt), and [requirements-kokoro-pack.in](../requirements-kokoro-pack.in).

### Local Acceptance Checks

Run `node scripts/bench-local.mjs llm configured` for real-model synthetic task scenarios using current environment/default settings, or `compact-f16` to pin eight threads, 4096 context and F16 KV. Run `node scripts/bench-local.mjs stt whisper` for synthesized English speech through the production recognizer. Set `PYTHON_BIN` to the provisioned environment for the standalone speech benchmark. These checks do not operate on real tasks or read private business data; they are separate from deterministic `npm test`. The LLM benchmark exits unsuccessfully when any scenario fails. `BENCH_SEED` changes its seed; `BENCH_TURN=name[,name]` selects cases; `BENCH_TRACE=1` records synthetic output and hidden reasoning. `BENCH_NATIVE=1` compares native tool calling through the custom-provider adapter without changing production routing. Enabling both direct/private read-only flags adds three synthetic M365 source-selection cases, still with no real MCP calls. The diagnostic warm-up uses a native template, so the first structured case includes a cold prompt; case order and cache state affect later results.

September 19 comparison: llama.cpp b10970 CPU, Threadripper PRO 5955WX, 128 GB RAM, eight threads, 4096-token context, one slot, F16 KV, thinking-off flags (subsequently found ineffective for Gemma), temperature 0.2, seed 42. The same initial tightened protocol and 16 synthetic cases produced:

| Model | Passed | Median Whole Turn |
| --- | --- | --- |
| Gemma 4 E2B IT QAT Q4_0 | 16/16 | 6.07 s |
| Ling APEX-I Quality | 15/16 | 1.74 s |
| MiniCPM5-2B Q6_K | 5/16 | 3.11 s |

After receipt-grounded task-ID grammar, exact-ID query lookup and subject-to-ID receipt reuse, the final Gemma run passed **21/21** at seed 73 (median **6.69 s**, range **1.33-18.36 s**). It adds stop/open, coding delegation, a VS Code note and an explicit no-delete conversation. The original gate covers status/search/ambiguity, delegation/follow-up, single/bulk deletion, preferences, inbox and hang-up. All actions use synthetic callbacks. Intermediate runs exposed duplicate follow-ups and invalid IDs; deterministic regressions cover those fixes. The older 8/11 Ling result predates this API and is superseded, not evidence of a model-only improvement.

Current tuning check on the same CPU/runtime and unchanged Gemma weights:

| Seed 42, same 21-case order | Passed | Model Generations | Total Turn Time | Median Turn |
| --- | --- | --- | --- | --- |
| Before tuning | 19/21 | 53 | 134.06 s | 5.35 s |
| 256-token cap + reduced routing | 19/21 | 48 | 123.96 s | 5.41 s |

That single paired run saved five generations and about 7.5% total time, not median latency. Both runs failed task opening and leaked an internal task ID in one follow-up response. Final defaults passed 21/21 at seed 73, but a later six-case subset missed opening again: seed alone does not make cached CPU inference deterministic. The three direct M365 tests selected email, Teams and calendar correctly at seed 73. These are routing tests against synthetic receipts, not validation of private search relevance or full calendars.

Rejected defaults: zero reasoning passed only 15/21 at seed 42; 64/128-token experiments introduced other failures at seed 73. Q8 KV and four-thread six-case runs showed no consistent speed benefit and each failed a follow-up action. A 512-token batch experiment did not establish an advantage. Keep F16 and existing portable thread/batch defaults; do not trade reliable tool behavior for a single fast sample.

These are small acceptance samples, not general accuracy scores or proof that intelligence is unchanged. Even minor catalog wording changed routing. The checks validate action/receipt contracts and basic spoken-output constraints, not complete semantic correctness. They do not cover noisy speech, arbitrary paraphrases, physical audio, sustained load or laptop performance. The compared models were not rerun on every final refinement. MiniCPM's publisher recommends different native parsing/sampling (including `min_p:0` for llama.cpp); these results describe this app's schema protocol, not its maximum capability. Use explicit task controls for consequential actions. See [llama.cpp server options](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) for runtime controls.

Model research: [Google Gemma QAT](https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-gguf) is the chosen Apache-2.0 GGUF and works with the existing runtime. QAT quality preservation is a publisher claim, not a BF16 comparison performed here. [MiniCPM5-2B](https://huggingface.co/openbmb/MiniCPM5-2B) is also Apache-2.0, but its published tool scores did not transfer to this workflow. [Needle3](https://huggingface.co/Cactus-Compute/needle3) is a compact structured-output specialist using Cactus `.cact` assets, not a drop-in general-chat GGUF; adopting it needs another runtime/answer model. [LFM2.5-1.2B](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct) supports edge tool use and llama.cpp, but uses the LFM license and was not benchmarked here. Neither untested option replaces the measured default.

On a Threadripper PRO 5955WX, Whisper Small INT8 recognized all six clean synthetic English samples exactly (three lengths in two modes). Final recognition took about 1.9-2.3 seconds after push-to-talk release and 3.4-3.7 seconds after speech in hands-free mode, including its silence threshold. Segmenter regressions cover a one-second internal pause and a held push-to-talk pause longer than three seconds. These results do not validate physical microphone quality, accents, noisy rooms, or laptop performance.

For the early-decoding comparison, run `node scripts/bench-local.mjs stt whisper-scheduling`. The benchmark runs endpoint-only and 480 ms early decoding against identical synthesized PCM, with brief, short, long, 800 ms internal-pause and 1056 ms hesitation samples in both modes. Optional sample names are `brief`, `short`, `long`, `paused`, and `hesitation`; `BENCH_STT_REPEATS=1..5` repeats each sample. JSON output records PCM hashes, exact baseline/candidate transcript equality, expected-word equality, premature/duplicate finals, input pacing and speech-end-to-final latency. A failed quality check exits nonzero; timings are reported, not treated as portable performance guarantees. Deterministic worker checks run separately with `python -m unittest discover -s test -p whisper_worker_test.py -v`.

September 19 scheduling check on the same Threadripper, eight recognition threads, automatic language and 1400 ms endpoint: three repetitions each of `short`, `paused` and `hesitation`, across both modes and scheduling settings, produced 36 matching transcripts with no premature/duplicate finals. Short hands-free median latency fell from 3.50 s to 2.56 s (paired savings 0.92-0.94 s). Mid-sentence-pause cases retained complete requests with paired hands-free differences from 3 ms faster to 31 ms slower; push-to-talk remained about 2.1 s. These are recognition-stage measurements, not end-to-end spoken-response latency. Physical microphones, background noise, multilingual speech, sustained thermal load and low-end CPUs remain unvalidated.

### Compact Tool Contract

The manual HTTP API and Tool Lab retain advanced options. LLM text/voice catalogs omit worker `model`, `backend`, `agent` and `context`; Settings supplies them, and generated overrides are rejected before dispatch. Task controls accept `query` (subject or exact ID) or `taskId`, never both. Zero/multiple matches return clarification without mutation. Local grammar allows ID selectors only from current-turn receipts; query remains available without a lookup. Preferences use action-specific values; inbox actions take no value.

`delete_work({all:true})` processes all persisted task chats, not just the latest 25. It stops owned active work before deleting history, retains files/work areas, and reports deleted/failed/remaining counts. Unowned active work stays protected. This does not clear the separate typed conversation. Successful subject-based mutations reuse their receipt when retried with the returned ID. Failed calls remain retryable within the existing three-round/six-call budget.

Local envelopes contain either `calls` or `answer`. Read-only first batches cannot escalate to mutation; action batches may read results. This scope is derived from the model's selected calls, not an independent authorization classifier. Completed status reads return bounded outcomes directly, avoiding a second status call.

## Direct Work Tools

Direct access is off by default. Enable both **Settings > Integrations > Private work sources > Read-only** and **Direct work tools > Read-only** to let typed chat and voice calls read M365 through WorkIQ, or public Microsoft Learn, without creating an Agency task. The saved key remains `VOICE_DIRECT_MCP_ACCESS` for compatibility. The same dynamic contract serves typed chat and local, hybrid, OpenAI Realtime and Gemini Live voice; ending a call remains voice-only. Disabling either setting removes the feature from subsequent chat turns and voice sessions; an active voice session retains its launch-time contract, but every direct invocation rechecks consent.

`list_work` searches only Invoke task history, never Teams or other M365 data. Empty local tasks are not evidence of empty or inaccessible Teams messages. With direct access disabled, external questions need `start_work` with `readOnly:true`. Raw-scored routing can still choose the wrong tool, and adding access is not an accuracy guarantee. Whisper defaults to English (`WHISPER_LANGUAGE=en`); explicit Automatic or other language selections remain supported and require a restart.

Raw-scored direct searches forward the current request and prior user requests in a structured query when conversation context exists, preserving the subject for follow-ups such as retrying. Only user text is carried, not assistant claims or tool results. The complete query must fit the existing 1,000-character limit; otherwise direct search is not a fast candidate and the regular planner remains available. This adds no model generation and does not change routing thresholds or mutation arguments.

Raw-scored is not reliable for contextual task-status follow-ups. A September 22 Gemma QAT synthetic reproduction returned the completed task result for five of five status follow-ups in Regular mode, versus two of five in Raw-scored; both Raw-scored successes came from its existing Regular fallback. Accepted fast choices included notification mutations and VS Code notes instead of task reads. Empty or saved notification receipts do not establish a task result. Prompt-description and user-only-history experiments did not reliably fix this without regressions and were discarded. Use Regular for task conversations; a selective fallback policy would trade additional planning latency on affected turns for reliability. This small development check is not a general accuracy or latency guarantee and did not read private work content.

The model receives three compact definitions: `search_work`, `find_work_tools` and `call_work_tool`. `search_work` accepts a bounded query and source (`all`, `email`, `teams`, `calendar`, `files`, `people`), invokes WorkIQ `retrieve` with a query array, `strategy:grounding` and the matching capability filter, and avoids a schema-discovery model turn. Grounding searches indexed M365; it deliberately excludes federated external connectors and agent delegation. Structured grounding/citations are returned once, rather than duplicating text and structured content. Provider compaction can still truncate large results; a small response does not prove exhaustive coverage.

Exact reads use `find_work_tools` then `call_work_tool`: WorkIQ `search_paths` takes `filter`, `get_schema` describes a selected path, and `fetch` reads `entityUrls`. The installed catalog exposes calendarView, chats/messages, Teams channel messages/replies and users, so the default does not need separate Teams/calendar/people servers. Discovery returns at most twelve complete matching approved schemas within 5,000 characters; `hasMore` reports omissions. The full upstream retrieve schema alone exceeds that budget, another reason for the compact search adapter. Invocation enforces the fixed read allowlist through app-owned loopback proxies. Upstream catalogs are not put in the default prompt or cached into later sessions.

This path avoids the Agency worker, model turn, task record, worktree, and resumable session. It is intended for short reads where lower latency matters; use an Agency research task for multi-source synthesis, durable follow-ups, or background work. WorkIQ `ask`, writes, shell, filesystem, URL, repository, and unrecognized tools remain unavailable. A discovered schema or listening proxy does not establish account, tenant, or resource authorization, and private results may be spoken aloud.

The installed WorkIQ tool definitions mark `ask` as `readOnlyHint:false`, `destructiveHint:true` and `idempotentHint:false`. It accepts a question and optional conversation/agent identity and can delegate work; it is not a safe replacement for a read-only tool catalog. The approved four reads are `retrieve`, `fetch`, `search_paths`, `get_schema`. Other advertised reads (`call_function`, `fetch_blob`, `list_agents`) were inspected but are not added to the allowlist. Create/update/delete/action tools remain excluded. Metadata and public Learn were checked live; no private business content was fetched. Tool versions vary; the [WorkIQ repository](https://github.com/microsoft/work-iq-mcp) describes stable and preview variants.

## Agency Delegation

Fresh installations default to Agency; existing saved choices remain unchanged. Coding sessions run in isolated worktrees and may use the Agency MCPs available to the signed-in client.

Omit the optional work model to use the selected default. The legacy value `default` resolves to the selected work model when creating a task; resumed legacy tasks never pass `--model default` to Agency or Copilot. Explicit model names are preserved and must be supported by the selected client.

The reported `Model "gpt-4" from --model flag is not available` is fatal model selection, separate from the ambient MCP-name warning. Generated model overrides are now blocked in text and realtime tools. Explicit manual settings and historical task models are not silently rewritten; select a supported work model for new tasks. Real hosted `agency:check` and the restricted synthetic/public-data `agency:read:check` both passed after these changes; no private business content was queried.

Coding and research prompts, including follow-ups, share a concise-reply default: answer first in at most two short sentences and 320 characters, followed only when needed by at most three short evidence or validation bullets. Preambles, progress recaps and repeated summaries are discouraged; explicit requests for detail can expand the answer. This is source-generation guidance, not truncation or rewriting of agent output.

Invoke launches Agency with a task-local `--profile-only` profile. This excludes ambient global Copilot MCP sources, whose server names may be incompatible with the installed CLI, without editing the user's MCP configuration. Coding sessions retain explicitly configured Invoke MCPs and repository `.github/mcp.json` or `.mcp.json`; research retains its restricted read profile. Personal/global MCPs and implicit profile plugins are not automatically inherited.

Delegated read-only questions use Agency; opt-in direct chat and voice reads bypass that worker. Public Microsoft Learn access is available by default. To enable M365 reads:

1. Install and sign in to [Agency](https://aka.ms/agency) with your work account.
2. Open **Settings > Integrations > Private work sources**, choose **Read-only**, then **Save access**. This is Invoke's saved research permission (`AGENCY_WORK_DATA_ACCESS=read-only`), not an Agency setting or a Microsoft 365 tenant authorization grant.
3. Run **Check connections** in the same section. If sign-in fails, repair it in Agency, then retry.

Saving access applies immediately to the next research task or follow-up; no restart is needed. An already-running worker keeps its launch-time permissions, so stop it and retry or send a follow-up when it finishes.

Invoke starts app-owned WorkIQ and Bluebird proxies with `agency mcp --transport http --port 0 NAME`, reuses their loopback connections and closes them on exit. Redundant Teams startup is removed. Default coding retains WorkIQ, Bluebird and public Learn plus explicit repository MCPs; its existing broader permissions are unchanged, so `ask` is not globally removed. No separate scheduled task or global MCP configuration is needed.

**Microsoft 365 tools** (`AGENCY_M365_TOOLS`) defaults to **WorkIQ**: private research has four approved WorkIQ reads plus three Learn reads. **Expanded** additionally enables the existing dedicated Teams, calendar and people read tools (24 total MCP reads) for compatibility; their proxies start on demand. This setting is not consent and does not add those servers to default coding. Research follow-ups refresh the selected profile; running workers keep their launch-time permissions. Private research consent remains off by default. WorkIQ `ask`, shell, filesystem, URL, repository and mutation tools are excluded from research in either mode.

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

`agency:setup:check` reuses the app launcher to verify the configured tool catalogs, then closes its temporary proxies; it neither reads business content nor saves consent. `agency:read:check` uses a local synthetic model, public Learn content and WorkIQ schema metadata to verify the consolidated profile, permission rejection, same-session follow-ups and consent revocation/restoration. `agency:check` uses an authenticated hosted coding session on a disposable repository.

## Calendar

**Open Outlook** opens `https://outlook.office.com/calendar/` in the default browser, including from Electron. Outlook and Teams share the signed-in Microsoft 365 work calendar. **Check today** dispatches `start_work` with `backend: agency` and `readOnly: true`, using WorkIQ exact calendar reads by default and the work-account timezone. The result stays in normal task details and can be followed up in the same session. With consent off, the button opens the exact consent control and makes no calendar request. Chat and voice delegate similarly unless direct work tools are enabled; opt-in direct access may search meetings or discover an exact calendar read. There is no background polling. Tool availability does not prove tenant authorization, indexed meeting search is not an exhaustive schedule, and failed access is not an empty calendar.

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
