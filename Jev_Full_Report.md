# Jevify: Implementation and CPU Evaluation

Date: 2026-09-22. Status: experimental implementation; **accuracy and safety gates failed**. Raw-scored is the fresh-install default at the user's subsequent request, not a validated release-gate outcome.

## Executive Decision

The benchmark recommendation was to keep the existing Gemma structured planner as the default. Jevify demonstrates real latency savings, but **neither tested model meets the accuracy or safety gates in [Jevify_PRD.md](Jevify_PRD.md)**. Unthresholded choice execution trades correctness for speed. During evaluation the feature defaulted to `LOCAL_ROUTER=off`; no saved user setting, installed model, consent, or release was changed. The subsequent user-requested default change is documented below; the measured limitations remain unchanged.

The simplest useful architecture remains one resident model, a small contract-derived choice adapter, and the existing executor. A second backbone, custom C++ branch engine, new tool broker, or proprietary RLCD reproduction is not necessary to test this mechanism. Reducing output tokens does not confer the reasoning needed to route safely.

- Gemma's current planner passed 41/54 workflow probes (75.9%). One-token choice passed 37/54 (68.5%); raw-scored choice passed 36/54 (66.7%). These are automated synthetic probe results, not production success rates.
- Natural-cache median local-turn time fell from 5.789 s to 2.273 s for one-token choice and 1.122 s for scored choice. Paired cache reuse materially affects these results; retrieving scores is not intrinsically twice as fast.
- With prompt reuse disabled on the same eight requests, both candidate modes still reduced latency, but failed three requests versus one baseline failure.
- MiniCPM5-2B Q6_K did not outperform Gemma: its baseline passed 30/54 and either candidate passed 22/54.
- Wrong actions, named-task misrouting, multi-action collapse, and following an injected output label occurred. High relative scores did not guarantee safety.
- WorkIQ already provides the useful aggregation boundary. Jevify forwards standalone questions to the existing read-only `search_work(query, source)` tool; it does not authorize WorkIQ `ask` under read-only consent.

## Implementation

### One Adapter, One Executor

[src/llm/choice-router.mjs](src/llm/choice-router.mjs) compiles bounded choices from the supplied tool contract: `answer`, `clarify`, `fallback`, complete valid preference tuples, general task listing, hang-up, standalone WorkIQ searches, verbatim new-work delegation, and request-note creation. The current voice catalog with direct work access has 21 choices, below the 32-candidate cap.

Named task IDs, deletion targets, dynamic MCP arguments, and worker-follow-up arguments are not synthesized by this adapter. Such requests are instructed to use the existing planner. **The models did not reliably choose fallback**, a release blocker rather than a handled corner case. No keyword intent classifier or prose-repair regex conceals these failures.

The native adapter applies the actual model template through `/apply-template`, tokenizes the prefix and every prefix-plus-label, and verifies that every distinct label adds exactly one token at the assistant boundary. It checks the actual prompt against the configured per-slot context budget, then calls `/completion` with a one-label grammar and `n_predict:1`.

Sampling is explicitly greedy, with penalties and truncating samplers disabled. `post_sampling_probs:false` retains pre-sampling log probabilities rather than a misleading greedy probability of one. The returned label, token ID/count, stop marker, and truncation flag must agree. A one-token native `limit` finish is valid only in this adapter; existing JSON-stream completeness rules remain unchanged.

Scored mode requires every legal label among the top-512 returned log probabilities and checks that selection agrees with the raw ranking. Missing scores or incompatible endpoints cause abstention. Probabilities are normalized over allowed labels: **relative model preferences, not calibrated probabilities of correct execution**. Sanitized timing/decision metadata is available through an internal observer; production code does not log private utterances or tool contents.

The adapter currently expects llama.cpp native endpoints at the configured URL's origin; servers exposing only OpenAI-compatible routes or native routes under a custom path prefix fall back. Unsupported token boundaries and oversized decision context also fall back. Such fallback can add latency before the planner; there is no promise that every local-provider implementation supports this experiment.

[src/llm.mjs](src/llm.mjs) converts accepted choices into the existing call representation. Batch/schema validation, cancellation, request identity, three routing rounds/six executed calls, deduplication, and downstream consent checks remain authoritative. Current voice-tool availability is rechecked before dispatch. Accepted calls go directly to a receipt-grounded summary; the legacy planner never reruns after a choice-selected action, including an error receipt. Conversation and clarification use a tool-free text pass with zero reasoning budget.

Public tools, HTTP/SSE/WebSocket formats, persisted state, audio, hosted routing, and managed model/download lifecycle were not changed. There is no new daemon, second loaded model, or persistent decision cache. Repeated per-turn token verification avoids stale model/template/authorization caches at the cost of several loopback requests.

### Modes

| Mode | Behavior | Use |
| --- | --- | --- |
| `off` | Existing structured planner | Regular option and rollback |
| `shadow` | Scores a candidate; planner owns execution | Development observation, adds latency |
| `choice` | Executes a valid label without confidence rejection | Synthetic benchmark candidate; unsafe for real work |
| `scored` | Requires all scores and configured probability/margin limits | Experimental fresh-install default, zero rejection thresholds |

Fresh application startup with no saved or environment-specified router selects `scored` with probability and margin 0, preserving explicit threshold overrides. Explicit environment-only modes retain their diagnostic behavior: supplying `LOCAL_ROUTER=scored` without thresholds or a saved selection still uses the low-level probability 1 and margin 1 fallback. There is no validated shipping threshold. [example.env](example.env) explicitly selects the permissive policy and documents the diagnostic controls. Settings and `.env` were not edited during the benchmark phase.

### User Opt-In After Evaluation

At the user's subsequent request, the source `.env` was enabled with `scored` and zero thresholds. Settings now exposes **Keys and config > Local performance > Local routing**, using the existing Regular / Raw-scored (experimental) segmented control. Saving Raw-scored explicitly selects the permissive benchmark policy (probability and margin 0), overriding diagnostic environment thresholds; saving Regular disables the candidate. Saved Settings override the environment and survive relaunch. Explicit environment-only diagnostic controls remain unchanged.

The user then requested Raw-scored as the default for new installs. Runtime initialization now applies that policy when no router is configured, and Settings displays the same default. Existing installations with no explicit selection also inherit this default; saved Regular and explicit `LOCAL_ROUTER=off` remain Regular. This changes source defaults only: no installer or release was built or published.

The switch applies to the next text or local-LLM voice turn without reconnecting the call, reloading the model, or restarting the app. An in-progress turn retains its starting mode and thresholds; live consent checks remain authoritative. Hosted LLM routing is unaffected. This opt-in does not change the failed release-gate conclusion above, and the installed desktop package has not been rebuilt or updated.

Switch validation: production build passed; provider/frontend suites 70/70; full application suite 260 passed and two optional skips. Real HTTP/WebSocket tests permit only routing-only saves during an active call and retain cross-origin, invalid-value and mixed-configuration guards. Playwright verified keyboard selection, persistence after reload, no restart indicator, and unclipped controls at 1440x960, 390x844, 320x740 and 900x500. No new CSS, model reload, download, or live inference was needed for this UI change.

### WorkIQ

Existing `search_work` selects `all`, `email`, `teams`, `calendar`, `files`, or `people` through WorkIQ read-only retrieval aggregation. The candidate preserves the complete standalone question, including names, dates, exclusions, and constraints. Context-dependent questions should fall back, but semantic enforcement is unproven.

Both existing read-only consent flags remain necessary for direct voice tools. `find_work_tools`/`call_work_tool` retain their existing full-schema path. Installed WorkIQ `ask` is marked non-read-only/potentially destructive; aggregation does not make it read-only-authorized. No private Teams, Outlook, calendar, or file content was read. Synthetic receipts do not establish retrieval quality, tenant authorization, citation quality, or network latency.

## Methodology

### Runtime

| Item | Configuration |
| --- | --- |
| Hardware | AMD Ryzen Threadripper PRO 5955WX, 16 cores / 32 logical CPUs, 127.9 GiB RAM |
| OS / Node | Windows x64 / v22.18.0 |
| llama.cpp | b10970-bfdc32183 |
| Inference | CPU-only, GPU layers 0; eight decode/prefill threads |
| Context / slots | 4,096 tokens / one slot |
| KV / batches | F16 K/V; batch and microbatch 256 |
| Baseline | Existing JSON planner; temperature 0.2, seed 42, routing reasoning cap 256 |
| Candidate | One greedy label, decision reasoning budget 0; existing tool-free text/summary model |
| Lifecycle | Installed weights, owned runtime, private loopback port, no downloads |

| Model | File Bytes | SHA-256 |
| --- | ---: | --- |
| Gemma 4 E2B IT QAT Q4_0 | 3,349,516,256 | `fa401b55b07ee70a54c6dae3903c783a6e65064312529ea57175cb5f8dec6634` |
| MiniCPM5-2B Q6_K | 2,107,305,184 | `c9f424852aa737b3f5f2f83096a6214d86a8ea2516f3a0fbaa04a3b4feba477d` |

Template SHA-256: Gemma `603a42db292c25278e9b23d94c7abbe77453f13e26a053c43c5c2f900b4136f7`; MiniCPM `6e54652d84d698ebb3b7b2172204b6eeafd7f27533e006c8c1ebf8e743a7fd99`. Templates come from the loaded GGUF, not hardcoded chat delimiters. The native choice output is exactly one label, so it cannot hide an autoregressive reasoning sequence. The baseline retains its established reasoning cap; hiding thinking is not counted as disabling it. MiniCPM Q4, Qwen2.5-1.5B, trained decision heads, and ARM runtimes were not downloaded or tested.

### Corpus and Scoring

[scripts/jev-cases.mjs](scripts/jev-cases.mjs) contains 54 fixed requests: conversation, reasoning, translation, conversational context, status, app controls, M365 sources, delegation, named tasks, multi-action/conditional requests, negation, injection, ambiguity, missing tasks, and typed ASR-like disfluencies. Final corpus hash: `d24e9858a03f462fc219694d6175a0c9c9072fe8b0ff36d90339aba9fb58f89d`.

The harness records actual model-selected calls against synthetic callbacks. Tool checks require expected operations/counts, exact enums, task selectors, and selected constraint-bearing fragments; limited equivalent phrasings are accepted. These are **tool-and-argument probes, not exhaustive semantic equivalence grading**. Valid paraphrases/date syntax can fail fragments; subtle meaning changes can pass. One verified false negative, "without changing production code," was corrected before the final runs.

Workflow pass requires completion, expected calls/arguments, case-specific text probes, required fallback behavior, and spoken-output hygiene. Most summaries lack exhaustive factuality grading. A pass does not prove complete answer quality; fabricated details can escape these checks.

This is a **development corpus, not an independent held-out 500-case release set**. Earlier prompts and several cases were inspected during development. No generalization claim is made. Wilson intervals quantify binomial sampling uncertainty, not selection bias or correlated templates.

### Timing and Fairness

- Total turn measures `streamReply` through completion, including fallback, synthetic callbacks, and final text. Startup, STT/TTS, microphone endpointing, real retrieval, and delegated worker completion are excluded.
- Routing includes native adapter time plus structured planner rounds. In baseline conversation, the planner also generates the answer, so this is not a pure classifier comparison.
- First tool is callback entry. First text is the first published completed text event, not an internal decode token or audible speech.
- Native prefill/decode/cache counts come from timing fields. `timings.cache_n` measures reuse; `tokens_cached` is not assumed to equal cache hits.
- Natural-cache modes share a resident runtime and server cache. Case order rotates; the two choice modes share prompts and benefit from each other. Results are order/workload-specific.
- Cache-disabled runs set `cache_prompt:false` on every measured generation. Weights remain resident: cold prompt processing is not a cold machine/process/filesystem or thermal state.
- Weights and user evidence match across modes; routing prompts/catalog representations differ. Savings combine compact prompting, one-token decoding, zero decision reasoning, and skipping the post-action planner round. They cannot all be attributed to logits selection alone.

## Main Results

Each row is 54 requests, one observation per request/mode. Failures remain in latency totals. Scored candidates here use zero thresholds to expose classifier behavior, not the abstaining default.

| Model / Mode | Workflow Pass | 95% Wilson | Median Turn | p95 Turn | Mean Turn | Total Time | Median Routing |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| Gemma current JSON | 41/54 (75.9%) | 63.1-85.4% | 5.789 s | 12.135 s | 6.037 s | 326.010 s | 4.723 s |
| Gemma one-token | 37/54 (68.5%) | 55.3-79.3% | 2.273 s | 3.709 s | 2.403 s | 129.765 s | 1.470 s |
| Gemma raw-scored | 36/54 (66.7%) | 53.4-77.8% | 1.122 s | 4.047 s | 1.854 s | 100.128 s | 0.146 s |
| MiniCPM current JSON | 30/54 (55.6%) | 42.4-68.0% | 3.696 s | 6.395 s | 3.723 s | 201.061 s | 2.151 s |
| MiniCPM one-token | 22/54 (40.7%) | 28.7-54.0% | 1.577 s | 2.948 s | 1.682 s | 90.811 s | 0.223 s |
| MiniCPM raw-scored | 22/54 (40.7%) | 28.7-54.0% | 1.638 s | 3.620 s | 1.759 s | 94.987 s | 0.100 s |

Gemma accepted 52/54 in both candidate modes, but only 35/52 accepted decisions had correct tool/argument and routing behavior (67.3%; Wilson 53.8-78.5%). MiniCPM scored accepted 50/54, with 20/50 correct (40.0%; Wilson 27.6-53.8%). This is not near 99% accepted accuracy.

The historical 21/21 result used different prompts, enabled tools, checks, cases, and cache state; it was never a broad reliability guarantee. Existing planner failures were not silently fixed to improve the baseline.

### Conversation and Tool Accuracy

Workflow passes by category; denominators are requests, not individual calls. The same probes apply to all six modes.

| Category | Requests | Gemma JSON | Gemma Choice | Gemma Scored | MiniCPM JSON | MiniCPM Choice | MiniCPM Scored |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Conversation | 8 | 8 | 8 | 8 | 1 | 7 | 7 |
| Safety / ambiguity | 10 | 8 | 5 | 5 | 5 | 3 | 4 |
| Recent status | 5 | 5 | 5 | 5 | 4 | 1 | 1 |
| App controls | 10 | 8 | 9 | 9 | 9 | 8 | 8 |
| WorkIQ searches | 8 | 5 | 8 | 8 | 6 | 1 | 1 |
| Delegation / note | 3 | 2 | 1 | 1 | 1 | 2 | 1 |
| Named / all-task operations | 6 | 4 | 1 | 0 | 3 | 0 | 0 |
| Complex / conditional | 4 | 1 | 0 | 0 | 1 | 0 | 0 |

Gemma conversation median total: JSON 1.736 s, choice 2.177 s, scored 0.774 s. The extra classification pass can make simple conversation slower, and cache placement can make the same architecture look faster. MiniCPM's choice conversation improves over its own JSON planner but still loses remembered context on one probe. There is no demonstrated reason to replace Gemma's conversational model.

Across the 37 cases explicitly requiring tools, tool-and-argument checks passed Gemma 26/37 baseline, 24/37 choice, 23/37 scored; MiniCPM 26/37, 13/37, 12/37. Including requests that correctly require no tools, the corresponding checks were Gemma 43/54, 37/54, 36/54 and MiniCPM 32/54, 25/54, 25/54. These checks omit some text and fallback requirements, so they can exceed workflow accuracy.

On the declared initially eligible categories (conversation, status, control, WorkIQ and delegation; 34 requests), Gemma accepts all 34 but gets only 31 correct: 91.2%, not 99%. MiniCPM accepts 34/34 with 20 correct in choice mode, or 32/34 with 18 correct in scored mode. Coverage does not rescue poor correctness even after excluding named-task and complex workflows.

### Where Time Goes

Phase counters aggregate every generation, including answer/summary generations and failed turns. They are not solely classifier costs. `prompt_n` is newly processed prompt tokens, `cache_n` is reused tokens, and decoded tokens include the baseline reasoning/output as reported by the runtime.

| Model / Mode | First Text p50 | First Tool p50 | Text Stage p50 | Generations | Processed / Cached / Decoded Tokens | Prefill / Decode Total |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Gemma JSON | 5.750 s | 4.050 s | 1.000 s | 111 | 4,638 / 94,559 / 7,351 | 35.298 / 289.138 s |
| Gemma choice | 2.273 s | 1.464 s | 1.034 s | 110 | 11,335 / 37,921 / 1,608 | 68.824 / 57.033 s |
| Gemma scored | 1.122 s | 0.146 s | 0.961 s | 109 | 5,800 / 42,160 / 1,623 | 38.404 / 57.630 s |
| MiniCPM JSON | 3.696 s | 1.348 s | 1.251 s | 131 | 5,345 / 107,014 / 3,118 | 52.952 / 146.307 s |
| MiniCPM choice | 1.576 s | 0.224 s | 1.372 s | 108 | 2,158 / 42,310 / 1,554 | 21.218 / 66.592 s |
| MiniCPM scored | 1.638 s | 0.099 s | 1.479 s | 112 | 2,065 / 49,668 / 1,643 | 21.024 / 70.731 s |

First-tool medians include only requests that actually invoked a callback. Text-stage medians include zero for baseline requests answered within the planner; first-text medians exclude requests with no text event. Phase medians cannot be added to reconstruct a median total. Native durations exclude JS/template/tokenization/transport overhead; wall-clock totals include it.

For Gemma, per-request median turn ratios are 2.526x for choice and 3.687x for scored; routing ratios 4.302x and 15.708x. Among the 31 paired requests passing both workflows, median turn ratios are 1.711x and 3.086x. These are distributions of paired ratios, not ratios of medians and not a target-device guarantee.

### Cache Controls and Repetition

The controlled slice is `hello,arithmetic,latest,theme-baymax,teams,coding,named-open,multi-control`. Cold means prompt caching disabled with already resident weights. Warm means natural server caching, three repetitions of each request, with every mode occupying every ordering position. Repetitions are not independent accuracy samples.

| Control / Mode | Workflow Pass | Median Turn | p95 Turn | Median Routing | Mean Turn | Total Time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Cache-disabled JSON | 7/8 | 17.854 s | 21.108 s | 16.131 s | 16.255 s | 130.043 s |
| Cache-disabled choice | 5/8 | 5.440 s | 5.858 s | 3.923 s | 5.429 s | 43.432 s |
| Cache-disabled scored | 5/8 | 5.493 s | 5.908 s | 3.963 s | 5.481 s | 43.845 s |
| Warm repeated JSON | 21/24 | 7.450 s | 11.430 s | 6.364 s | 6.811 s | 163.466 s |
| Warm repeated choice | 15/24 | 1.202 s | 2.549 s | 0.143 s | 1.489 s | 35.728 s |
| Warm repeated scored | 15/24 | 1.145 s | 2.834 s | 0.141 s | 1.375 s | 32.999 s |

The two candidate modes have near-identical routing medians once ordering is counterbalanced. Cold candidates both process 6,740 prompt tokens and decode 195 tokens over 16 generations; baseline processes 14,973 and decodes 1,202 over 17 generations. All cold `cache_n` totals are zero. This separates prompt-cache luck from the real reduction in prompt/decode work, but does not isolate compact prompting from decision format.

Warm candidate coding, named-open and multi-control fail on every repetition; baseline only named-open fails. On the 15 paired observations both get correct, choice and scored median turn gains are 5.879x and 5.813x. Even the valid speed benefit does not satisfy the accuracy gate. Warm arithmetic is an example where the existing planner already answers quickly without a second text call.

### Option-Order Robustness

Reversing all labels while retaining the same complete choice tuples produces 35/54 workflow passes (64.8%) and 54/54 acceptance, versus 36/54 and 52/54 in normal scored order. Eligible accuracy falls to 30/34 (88.2%). Coding becomes correct, but conversation context and a cross-source search regress; named-task and complex cases remain wrong. One reverse-order run is not exhaustive permutation testing. It also lacks paired baseline and cross-mode cache sharing, so its 2.642 s median is not a clean latency comparison.

## Confidence and Abstention

Post-hoc threshold sweep on the Gemma scored run:

| Minimum Relative Score | Accepted | Correct Accepted | Coverage |
| --- | ---: | ---: | ---: |
| 0 | 52/54 | 35/52 (67.3%) | 96.3% |
| 0.80 | 38/54 | 32/38 (84.2%) | 70.4% |
| 0.90 | 35/54 | 30/35 (85.7%) | 64.8% |
| 0.95 | 26/54 | 23/26 (88.5%) | 48.1% |
| 0.98 | 18/54 | 17/18 (94.4%) | 33.3% |
| 0.99 | 12/54 | 12/12 (100%) | 22.2% |
| 0.995 | 4/54 | 4/4 (100%) | 7.4% |

Twelve successes do not establish 99% reliability: their Wilson lower bound is 75.8%. MiniCPM still has errors at 0.99 (8/10 correct, 18.5% coverage). No universal threshold is justified.

Binary chosen-decision correctness Brier/ECE: Gemma 0.170/0.170; MiniCPM 0.328/0.393, using 10 equal-width ECE bins and accepted scored decisions. This is not full multiclass calibration. Rejected and shadow choices lack independently graded candidate outcomes; the analyzer excludes them instead of attributing the fallback planner's result to the rejected candidate. Threshold sweeps on selective runs cannot recover unexecuted decisions.

[scripts/report-jev.mjs](scripts/report-jev.mjs) additionally fits temperature on a deterministic name-hash subset and evaluates the remainder, explicitly labeled a post-hoc synthetic diagnostic. Gemma fits T=2 on 20 cases; on the remaining 32, Brier worsens 0.095 -> 0.167 and ECE 0.091 -> 0.262. MiniCPM fits T=4 on 17 cases; on the remaining 33, Brier improves 0.319 -> 0.187 and ECE 0.349 -> 0.216. Neither establishes deployment calibration. Temperature changes confidence, not ranking; it cannot repair wrong actions.

### Measured Strict Fallback Policy

A separate complete 54-case Gemma run used probability >=0.99 and margin >=0.5. It accepted 12 choices, all passing their workflow probes, and returned 42 requests to the planner. Overall workflow pass was 42/54 (77.8%; Wilson 65.1-86.8%), compared with 41/54 in the separate baseline run. This one-case difference is not evidence of a quality improvement.

Coverage is only 22.2% overall, or 35.3% of the 34 declared eligible requests. Total-turn p50/p95 is **7.238/13.554 s**, mean 7.042 s, cumulative 380.256 s. The original baseline is 5.789/12.135 s, mean 6.037 s, cumulative 326.010 s. The strict run is not interleaved with that baseline, so cache/sampling variation remains, but it clearly does not demonstrate the rollout speed gate.

Accepted p50 is 2.449 s; rejected-turn p50/p95 is 9.022/13.787 s. Routing p50 is 6.008 s. There are 150 generations, 19,268 processed prompt tokens, 93,822 cached tokens and 6,653 decoded tokens. Rejected requests pay the candidate's prefill and may evict the planner's useful cache. Reporting only accepted latency would hide this cost.

## Failure Analysis

1. Multiple requests collapse into a single action. Grammar validity cannot ensure fulfillment of the whole request.
2. Named-task requests can select request-note creation, M365 search, or generic listing instead of fallback. Omitted target choices do not guarantee abstention.
3. A user-supplied output-label instruction can override semantic matching, even with "do not change settings." The synthetic callback exposes the unwanted mutation although the spoken answer may only say hello.
4. Coding constrained to test files can select read-only research. Verbatim objective preservation does not fix the wrong operation.
5. Summary truthfulness remains independent: the text model can add unsupported details or claim an outcome inconsistent with receipts. No prose rewrite conceals this.
6. The baseline sometimes lists tasks and stops instead of opening/cancelling, or summarizes ambiguous tasks without asking. These are separate owning-contract issues.

Earlier development evidence is retained locally. A verbose initial policy produced confidently wrong theme/source decisions. Compact tuples fixed three spike cases but did not generalize. An empty sampler chain also allowed stochastic selection; the final code explicitly applies greedy sampling and checks raw-score ranking. Final tables exclude those earlier implementations.

## Acceptance Gates

| PRD Gate | Result |
| --- | --- |
| Native adapter and same-model comparison | Implemented and measured |
| Existing executor/contracts retained | Implemented; focused regressions pass |
| Shadow candidate cannot execute | Implemented and unit-tested, not enabled in user's app |
| 500 held-out realistic requests with frozen splits | Not met: 54 synthetic development probes |
| 99% accepted accuracy at 80% eligible coverage | Not met |
| Zero unintended safety-suite mutations | Not met for unthresholded candidates |
| No full-workflow accuracy regression | Not met |
| 2x routing / 30% turn gain on named 16 GB laptop | Not certified; workstation results only |
| No p95 regression including fallback | Not demonstrated; strict policy p95 exceeds separately measured baseline |
| Choice-order / unseen schema robustness | One reverse-order diagnostic fails; new descriptions not tested |
| 8 GB low-power x64, ARM64, RAM peaks, speech contention, 15-minute thermals | Not measured |
| 256/1,024/4,096-token and 1/4/8-field matrix | Not measured; no multi-field engine claimed |
| Dynamic nested MCP/staged receipt-grounded targets | Existing planner retained; no new stage claimed |

These local-turn metrics are not speech-end-to-first-audio or delegated-work completion times. No physical microphone validation, installer, release, commit, or push was performed.

## Engineering Validation

- Seven focused choice tests passed: legal tuples/tool availability, actual-boundary token checks, complete raw scores, one execution/no post-action planner, shadow/abstention/malformed fallback, loopback/context/finish/collision rejection, cancellation/consent revocation, and verbatim free-text constraints.
- Full provider suite: **58 passed**. Full application suite: **257 passed, two optional skips, zero failures** (259 tests, 68.0 s). Skips do not establish packaged or installed-embedding behavior.
- Analyzer regression verifies that strict calibration includes only its 12 accepted choices and leaves unrestricted Gemma calibration at 52 decisions/Brier 0.170.
- `npm run build` passed (Vite production build, 5.29 s). No dependency or package-version changes were needed.
- Editor diagnostics are clean for the touched runtime, benchmark, tests, and environment example.

Passing deterministic unit tests validates plumbing and guards, not the real model's semantic reliability. The model benchmarks intentionally exit 1 because their behavior gates fail.

## Reproduction

Run from the app root with installed assets. The harness owns its loopback runtime and every tool callback is synthetic. It never saves consent or Settings.

```powershell
$env:LLAMA_GPU_LAYERS = '0'
$env:VOICE_DIRECT_MCP_ACCESS = 'read-only'
$env:AGENCY_WORK_DATA_ACCESS = 'read-only'
$env:BENCH_SUITE = 'jev'
$env:BENCH_ROUTERS = 'off,choice,scored'
$env:LOCAL_ROUTER_MIN_PROBABILITY = '0'
$env:LOCAL_ROUTER_MIN_MARGIN = '0'
$env:BENCH_TRACE = '1'
$env:BENCH_OUTPUT = 'artifacts/jev-new-run.jsonl'
node scripts/bench-local.mjs llm compact-f16
node scripts/report-jev.mjs artifacts/jev-new-run.jsonl
```

Exit code 1 means a behavior check failed; measurements remain recorded. Use a new filename because output is append-only. Set `LOCAL_LLM_PATH` to installed MiniCPM for its comparison, then remove that shell override. `BENCH_TURN` selects case names; `BENCH_REPEATS=3` rotates every mode through each position; `BENCH_CACHE=cold` disables prompt reuse; `LOCAL_ROUTER_REVERSE=1` reverses candidates.

Evidence: [Gemma](artifacts/jev-final-gemma.jsonl), [MiniCPM](artifacts/jev-final-minicpm.jsonl), [cache-disabled Gemma](artifacts/jev-final-gemma-cold.jsonl), [strict Gemma](artifacts/jev-final-gemma-strict.jsonl), [three-repeat warm Gemma](artifacts/jev-final-gemma-warm.jsonl), [reversed-label Gemma](artifacts/jev-final-gemma-reversed.jsonl), [benchmark](scripts/bench-local.mjs), [corpus](scripts/jev-cases.mjs), [analyzer](scripts/report-jev.mjs), [regressions](test/providers.test.mjs). These six final files contain 528 measured turns. Raw artifacts are local generated evidence and may be Git-ignored; preserve them for review. The analyzer reports each input file's SHA-256. The earlier incomplete `jev-final-gemma-repeated.jsonl` attempt is excluded; the correctly configured repeat artifact is `jev-final-gemma-warm.jsonl`.

Reverse order is recorded here and in the invocation, not as a dedicated header field in the current JSONL format. Runtime arguments, build/template hashes, corpus/cache mode, repeat indices, model identity, requests, receipts and stage timings are retained. There is no independently signed run manifest; results depend on the source implementation from this working tree.

After reproducing, remove benchmark-only process overrides before running normal application commands:

```powershell
Get-ChildItem Env: | Where-Object {
	$_.Name -match '^(BENCH_|LOCAL_ROUTER)' -or
	$_.Name -in @('LLAMA_GPU_LAYERS', 'VOICE_DIRECT_MCP_ACCESS', 'AGENCY_WORK_DATA_ACCESS', 'LOCAL_LLM_PATH')
} | Remove-Item
```

These process overrides were cleared after the experiments. This does not edit saved user consent or configuration. Restore pre-existing shell values instead of removing them when adapting the recipe to another environment.

## Recommendation

Do not build a larger inference framework to compensate for poor classification. Keep Gemma and the current executor, retain this adapter for shadow evaluation, and create a human-reviewed train/calibration/test dataset before training a small decision LoRA/head. Re-evaluate after quantization, option permutations, and schema-description changes. Add staged receipt-grounded targets only after their accuracy is established.

Investigate baseline task-action and ambiguity failures separately. Jevify's next gate is **better decisions at useful coverage**, not a faster confidently wrong one-token answer.