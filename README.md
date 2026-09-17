# Voice Work Supervisor

Windows Node/Vue voice console for local or hosted voice and coding sessions. The server is loopback-only; provider keys stay in the server process.

## Windows App

This workspace's installer is [Voice Work Supervisor Setup](release/Voice%20Work%20Supervisor-Setup-0.1.0.exe). To try the built app without installing, open [the unpacked executable](release/win-unpacked/Voice%20Work%20Supervisor.exe); keep its neighboring files together.

Open the **Voice Work Supervisor Setup** executable from a trusted build. The one-click installer installs for your Windows user without administrator access. Launch **Voice Work Supervisor** from Start. The app includes its own Node runtime; you do not need Node or Python installed just to open it.

The installed desktop app can check GitHub Releases under **Settings > Application**. Beta installations consider newer betas and stable releases; stable installations remain on the stable channel. **Install update** downloads the matching NSIS installer and SHA-256 sidecar, verifies the installer, starts it, and closes the running app so the per-user installation can be replaced. Update checks are manual and do not send configuration or user data. The installer is unsigned unless the distributor adds signing, so Windows or organizational policy may still block it.

Local AI is optional. On first start, choose local setup, configure a provider, or decide later. Local setup opens Settings and still requires explicit download consent; nothing downloads just by opening the app. Setup installs and configures Ling/llama.cpp chat first, followed by Whisper Small with CPU INT8 inference, bundled Silero VAD, and an isolated Kokoro Python environment. Moonshine streaming is an optional selection in Settings, not a default download. Windows release builds bundle Kokoro's complete Python 3.12 x64 dependency pack. Whisper's pinned Python dependencies are installed separately from the configured package index on first setup and reused afterward. If speech setup fails, local chat remains available and voice can be retried separately. Keep the app open until setup finishes. Allow several GB of downloads and at least 12 GB of free disk space; 16 GB RAM is recommended.

New installations get an editable **My Workspace** under the application data directory, with publishing disabled. Existing work areas and valid defaults are preserved. Change the work area, coding backend, model and context under Settings. GPU rendering is enabled by default; `VOICE_SUPERVISOR_DISABLE_GPU=1` is an opt-in troubleshooting setting requiring a desktop restart. **Settings > Appearance > Transparency effects** persists locally and replaces translucent surfaces with opaque ones; Motion remains separately configurable.

Files are kept under `%LOCALAPPDATA%\VoiceSupervisor`: `models`, `runtimes`, `huggingface`, `pip-cache`, and `uv-cache`. Existing configured `LocalVoiceStack` models are verified in place, not copied. Completed, verified files are reused on retry and future launches, including offline. A managed virtual environment left by an older app version is checked against the currently pinned Python version and replaced when stale. Setup validates the bundled pack manifest, lock file, exact wheel set, sizes, SHA-256 hashes, target platform, and required versions before installing with indexes disabled. If the pack is absent or invalid, setup keeps the existing online-index flow and managed uv-cache retry. Partial package caches are retained but cannot complete setup by themselves. Unfinished downloads are never reported ready. First verification of previously unrecorded models needs source metadata online. Local setup does not edit your `.env` or system Python/PATH.

After successful setup, local runtimes start automatically on desktop launch without downloading anything. Setup changes take effect in the running app. Each desktop instance uses private loopback ports, so a browser development server can remain open. Closing the app stops its managed runtimes. Microphone permission is still required, and setup startup checks do not prove microphone/speaker hardware works.

Configure provider keys, models, endpoints, defaults and local performance under **Settings > Config**. Values are stored in `%LOCALAPPDATA%\VoiceSupervisor\config.json`, excluded from the installer and never returned to the browser UI. The file contains secrets in plain text under the current Windows user profile, so do not share it or the app-data folder. Logs are in `%LOCALAPPDATA%\VoiceSupervisor\logs\desktop.log` and are replaced on launch. Cached models and user data are retained on uninstall. Remove the cache folder yourself only when the app is closed and you no longer need that data.

Installation failures keep the stage, executable path and a bounded, sanitized diagnostic tail in `logs/local-setup.log` inside the cache directory. Completed downloads are retained for retry. The [Kokoro 0.9.4 release page](https://pypi.org/project/kokoro/0.9.4/) identifies the Python package, not the Python or uv executable. Bundled releases do not contact Python package indexes for Kokoro dependencies. Source builds without a pack fall back to `pypi.org/simple`, `files.pythonhosted.org`, `download.pytorch.org`, and GitHub for the English spaCy model. If policy blocks those services, use IT-approved sources as described under [Approved Python And Policy Blocks](#approved-python-and-policy-blocks). Do not disable TLS verification or bypass organizational policy.

Builds are unsigned unless your distributor adds signing. Windows SmartScreen or organizational policy may warn or block them. Only run a build you trust; do not bypass organizational security policy.

## Prerequisites And Install

- The source workflow needs Node.js 22+ and npm. Windows x64 app setup manages its own voice runtimes. Initial model and native-runtime provisioning can still need their listed release sources; bundled Kokoro Python packages install offline. Managed Python itself can require its pinned download when it is not already cached.
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

To build the Windows x64 Python dependency pack, use CPython 3.12 x64 and run `npm run kokoro-pack`. Set `KOKORO_PACK_PYTHON` only when that interpreter is not available through `.venv`, `py -3.12`, or `python`. The builder resolves all wheels into `artifacts/kokoro-offline-pack`, creates a SHA-256 manifest and hash-locked requirements file, then verifies an offline install, `pip check`, imports, CPU-only Torch, and the spaCy English model in a clean temporary environment. `npm run dist:win` runs this step automatically and reuses a current verified pack.

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
| `npm run local:check` | Local Check | Checks the tool-capable prompt, completion structure and runtime health, then exits. |
| `--port <num>`, `-p <num>` | Any | Binds to custom port (defaults to `PORT` env or 4317). |
| `--build` | Release | Forces frontend rebuild even if `dist/index.html` already exists. |

## Immersive Themes

Choose a card in **Settings > Theme** or use the palette button beside the assistant. Copilot keeps the original appearance and typography and remains the default; Copilot and Opal are sprite choices within that one theme. Saved Opal theme selections migrate automatically. Jarvis adds a reactor, technical icons, dark glass surfaces and short electronic cues. Baymax uses only the unofficial, character-inspired white face with animated eyes, quiet surfaces and softer cues; the body is not available.

The three theme cards preview the actual wallpaper and centered sprite. Side arrows cycle wallpapers; the bottom swap icon cycles sprites where alternatives exist. Editing an inactive card updates its preview without changing the active theme. Click the card to apply it. Selected outlines, check marks, hover labels and native keyboard access work in both Settings and the appearance popover.

Each theme has four backgrounds: two supplied scenes plus plain white and black gradients. Each remembers its own wallpaper and sprite selection. Wallpaper strength, sound level, transparency, motion, persona and voice preferences are stored locally. Optional boot sounds play when connecting the microphone or switching themes; action sounds share the tool-activity edge pulse. Hands-free capture pauses during cues to prevent feedback. Reduced motion disables animation, and hidden pages pause it.

Appearance changes never restart a call or erase a chat. Personas apply to new text conversations and voice calls; **New themed chat** explicitly clears the current text conversation. Theme voice changes apply to the next call. Each non-default persona adds just one sentence (under 90 characters) to the existing prompt, with no extra model request. Turning either toggle off retains the normal persona or configured voice independently.

Gemini and OpenAI use their built-in voices, not character voice clones. Local Kokoro uses small pace/pitch variations of the installed voice. It can use `am_michael.pt` (Jarvis) or `am_fenrir.pt` (Baymax) if already present in the configured Kokoro directory; otherwise it keeps the installed voice and never downloads another model. Local timbre availability and physical speaker quality are separate from UI validation.

Media is packaged locally: 512px transparent WebP sprites, 1600x900 WebP wallpapers and 48kHz mono Ogg cues. See [asset sources and licenses](public/immersive/README.md). Run `node scripts/theme-assets.mjs` with FFmpeg installed to normalize the originals in `voice_app_assets`; preparation is offline and never runs during startup or normal builds.

## Local Voice

Start the source app with `npm start`, then use the opt-in setup in Settings. Setup only accepts `POST /api/setup` with `{"consent":true}`; `GET /api/setup` is a local, non-network snapshot. Extra command, URL and path fields are rejected. `ready` means the installed runtimes passed startup checks in this server process, not just that files exist.

**Settings > Config > Local speech** selects **Whisper Small (INT8)**, the default, or **Moonshine Small (streaming)**. Save the selection, then give download consent in **Local voice** for any missing components. Switching is blocked during a voice call or installation, preserves local chat, and never silently downloads models. Installed models are retained when switching. A fully installed selection is warmed without downloading again.

Whisper uses the multilingual Small model, quantized to INT8 by CTranslate2 at load time; the pinned upstream download contains the original converted weights, not a separately distributed INT8 checkpoint. It decodes completed utterances with beam search and no previous-turn transcript conditioning. Push-to-talk release commits immediately; hands-free input uses Silero VAD with 650 ms endpoint silence and boundary padding. There are no live partial captions in Whisper mode. Moonshine retains PCM streaming and partial captions. Choose a Whisper spoken language when known, or leave Automatic for multilingual input; language/thread changes take effect after restart. Accuracy depends on accent, noise and vocabulary; Small is not a guarantee of exact names or technical terms.

Chrome's Web Speech API is not offered as an Electron recognizer. Electron 41's speech delegate leaves the on-device recognition context unimplemented, and API constructor availability does not grant access to Chrome's recognition service. No new hosted STT service, Google service credentials or browser fallback is configured.

For individual model/runtime downloads instead of full setup:
```powershell
npm run models -- all
npm run models -- runtimes
```
`all` installs Ling and the recognizer selected by `LOCAL_STT_PROVIDER` (Whisper by default). `runtimes` installs pinned Windows x64 CPU llama.cpp and, unless `PYTHON_BIN` is configured, uv; CrispASR is included only for Moonshine. `whisper` downloads the four pinned Whisper model files. `moonshine` explicitly downloads Moonshine Q4_K, its tokenizer, Silero VAD and CrispASR. CLI model downloads use the launch environment, not the app's saved Settings. These commands alone do not install or validate the complete voice stack. Use Settings for Python dependencies and warmup.

Setup pins Hugging Face revisions plus SHA-verified native archives: CrispASR 0.8.32, llama.cpp b10970 CPU and uv 0.8.17. By default uv installs Python 3.12.11 privately. An explicitly configured Python 3.12 x64 instead creates a separate environment using its own `venv` and bundled `pip`, without downloading or running uv or managed Python. The bundled recipe in [`requirements-kokoro-pack.in`](requirements-kokoro-pack.in) includes Kokoro 0.9.4, CPU Torch 2.8.0, SoundFile 0.13.1, spaCy 3.8 and the English 3.8.0 model; its complete resolved dependency closure is hash-locked in each generated pack. [`requirements-local.txt`](requirements-local.txt) remains the compact online-fallback input. Unsupported Windows architectures need a separately maintained manual runtime setup.

The paths in [`example.env`](example.env) can point to sibling `..\LocalVoiceStack` or absolute local files. `MODEL_DIR`, `RUNTIME_DIR`, `CRISPASR_BIN`, `VAD_MODEL` and `PYTHON_BIN` remain source configuration overrides. Setup verifies existing models and refuses to overwrite mismatched external files. Normal Kokoro startup is offline; missing English dependencies or weights require explicit setup. Managed Kokoro uses the pinned `af_heart` English voice.

### Approved Python And Policy Blocks

If Windows says an administrator blocked execution, stop retries and ask IT to review the named executable. Do not rename or relocate a blocked binary to evade a rule, disable Defender, change AppLocker/WDAC, elevate, or install another Python distribution as a workaround. A clipped-subtitle screenshot does not establish an execution-policy failure. The local setup log and matching Windows policy events are needed to distinguish a block from missing files, wrong Python version, TLS inspection, or package/build errors. Do not share configuration files or unsanitized logs containing credentials.

For an existing IT-approved interpreter, set its full executable path in **Settings > Config > Local setup network > IT-approved Python 3.12 x64 path**, save, and restart the app. The launch environment or source workflow's `.env` can also supply `PYTHON_BIN`. For example, `PYTHON_BIN=C:/Program Files/Python312/python.exe` is appropriate only if that actual installation is approved by IT. Do not use a Store alias or a command with embedded arguments. Setup requires Python 3.12 x64, `venv` and bundled `ensurepip`; it does not search PATH, download missing tools, or fall back to uv when the configured interpreter fails. Leaving the Settings field empty restores the managed-download route after restart.

The configured interpreter is used only as a base: package installation stays inside `runtimes/kokoro-approved-<path-hash>`, separate from the downloaded `kokoro-venv`. The hash distinguishes base paths; it is not a certificate or proof of approval. Setup checks the base version/architecture, repairs an interrupted venv on retry, and records both interpreter file identities for cached readiness. It never installs packages into the base interpreter. IT must permit the venv executable, package installation and native libraries as well as the base Python. If policy forbids them or execution from app-data, this option cannot resolve the block: keep using local chat and ask IT for an approved deployment. llama.cpp and CrispASR also require their own approval.

Package sources are shared by both runtime routes:

| Control | Default / Requirement |
| --- | --- |
| `LOCAL_PYPI_INDEX_URL` | `https://pypi.org/simple`; also exposed as **Python package index** in Settings |
| `LOCAL_TORCH_INDEX_URL` | `https://download.pytorch.org/whl/cpu`; also exposed as **PyTorch package index** in Settings |
| `LOCAL_SPACY_MODEL_URL` | [English spaCy 3.8.0 wheel](https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl); also exposed as **spaCy English 3.8.0 wheel URL** in Settings |

Use only IT-approved HTTPS mirrors (HTTP loopback is also supported for local mirrors), without URL credentials. The spaCy mirror must supply the same `en_core_web_sm` 3.8.0 wheel. PyPI/Torch index overrides alone do not redirect that GitHub wheel or the native/model downloads. All three source URLs are validated before Python/package commands. uv uses native TLS trust; the configured-Python route uses pip's system certificate support (`truststore`), without disabling verification. These controls do not automatically configure proxy authentication; ask IT to provision any required network trust or access. Consent in Settings is still required before setup installs anything. Verified chat remains available when speech setup fails.

### Runtime Sources And Trust

The exact app-pinned native archive URLs and SHA-256 values are in [`scripts/models.mjs`](scripts/models.mjs):

| Runtime | Download | App-Pinned SHA-256 |
| --- | --- | --- |
| uv 0.8.17 | [Windows x64 MSVC archive](https://github.com/astral-sh/uv/releases/download/0.8.17/uv-x86_64-pc-windows-msvc.zip) | `0d051779fbcb173b183efeae1c3e96148764fd82709bbbf0966df3efe48b67c5` |
| llama.cpp b10970 | [Windows x64 CPU archive](https://github.com/ggml-org/llama.cpp/releases/download/b10970/llama-b10970-bin-win-cpu-x64.zip) | `2c6d6516c04e95caa080d8eb917743e71858c73985acbb6739ad61b14e68b298` |
| CrispASR 0.8.32 | [Windows x64 CPU archive](https://github.com/CrispStrobe/CrispASR/releases/download/v0.8.32/crispasr-windows-x86_64-cpu-legacy.zip) | `ba4e23fb8dfcc99b8a76af034954576a75f88193e3dbf62fc774287bcbd1114b` |

The app verifies archive size and digest before extraction; allowed HTTPS redirects include GitHub release-asset hosts. These are repository-pinned integrity values, not independent security attestations. uv publishes an [archive checksum](https://github.com/astral-sh/uv/releases/download/0.8.17/uv-x86_64-pc-windows-msvc.zip.sha256) for administrator comparison.

Managed Python is Astral's [python-build-standalone](https://github.com/astral-sh/python-build-standalone/releases), not a python.org Windows installer. `uv python install 3.12.11` selects the Windows x64 entry from uv 0.8.17's [download metadata](https://github.com/astral-sh/uv/blob/0.8.17/crates/uv-python/download-metadata.json). That entry supplies the exact dated archive URL and expected SHA-256; the app does not pin them separately. uv's [download implementation](https://github.com/astral-sh/uv/blob/0.8.17/crates/uv-python/src/downloads.rs) verifies that checksum when unpacking a fresh download. Inspect the entry and local cache to establish which build is actually present; do not infer it from the Python version alone.

Kokoro configuration, weights and voice come from [hexgrad/Kokoro-82M at revision f3ff3571791e39611d31c381e3a41a3af07b4987](https://huggingface.co/hexgrad/Kokoro-82M/tree/f3ff3571791e39611d31c381e3a41a3af07b4987), with digests obtained from the pinned Hugging Face tree metadata. The offline pack pins every resolved wheel and hash, including the locally built `docopt` 0.6.2 wheel and direct spaCy model wheel. Pack generation still depends on the configured HTTPS package sources; hashes and HTTPS do not replace package review.

No setup step verifies Authenticode signatures, publisher certificate chains or enterprise allow rules. Cached readiness uses file size/modification-time receipts, not a fresh signature check. Neither a recognized project URL nor a matching checksum proves safety or permission to execute. IT should review the actual blocked file's hash, signature/publisher and policy event before approving any deployment. No policy exemption is created by setup.

Check Ling, then start local llama.cpp and the supervisor:
```powershell
npm run local:check
npm run local
```
After provisioning, `local:check` warms the real voice/tool prefix and checks response structure and runtime health; it does not prove correct tool selection. `local` starts or reuses a loopback llama.cpp server, then starts the supervisor. CrispASR 0.8.32 requires canonical Moonshine Small Q4_K; the known Q8_0 override falls back to sibling or cached Q4_K when available, and `/api/config` preserves requested/effective paths.

### Local Performance

Local voice now uses one tool-capable conversation, shared with text chat. There is no separate tool-less acknowledgement model or playback-gated background planner. Status questions can read current work directly, and completed answers remain in conversation history. Tool access still does not authorize starting or resuming work without an explicit request. Kokoro synthesis and playback ownership are unchanged.

For references such as "What's the status of the document work?", `list_work` accepts an optional `query`. MiniSearch searches all saved titles, objectives, user follow-ups and area names/aliases, including older tasks. Optional semantic matching adds a quantized MiniLM embedding model, running locally on CPU with two inference threads. This can connect paraphrases such as "new employee handbook" to "write the onboarding guide" and "authentication bug" to sign-in repairs. Similarity is not certainty: broad labels such as "document" can still need a distinguishing detail. Low-similarity candidates are excluded rather than always returning the nearest task.

Install the optional embedding files explicitly, without starting or changing the voice stack:

```powershell
npm run models -- task-search
```

This downloads approximately 23 MB of quantized weights plus tokenizer/config files from a pinned `Xenova/all-MiniLM-L6-v2` revision using the existing integrity-checked provisioning path. It is separate from normal voice setup. Chat never downloads embedding files or sends task text to a service. Missing or failed embeddings fall back to keyword search. The embedding runtime loads lazily on first use; cold initialization costs more than subsequent searches.

Semantic search blends cosine similarity with keyword ranking. It embeds bounded titles, objectives and the latest two user follow-ups, not logs or tool output. Changed text is embedded on the next search in batches of eight; unchanged vectors are reused from `task-search-vectors.json` beside task state. The versioned cache stores hashes and vectors, not copied task text, and removes deleted-task vectors on the next search. Query vectors have a bounded in-memory cache. Treat embeddings as private derived task data. No vector database, server, background-job protocol or additional LLM prompt/tool definition is needed; the existing async tool call awaits search and then returns fresh status.

Queried results contain at most three task titles, areas and bounded current status summaries, with `hasMore` when additional matches exist. They omit session records, worktree paths and backend metadata. The assistant can answer from that read, asks which title the user means for ambiguous matches, and uses `get_work_status` for known tasks or fuller outcomes. Calling `list_work` without a query keeps its existing recent-task/area response. Context trimming preserves all returned search identities and titles rather than silently resolving ambiguity. The shared prompt requests professional short answers without speaking IDs, paths, logs or tool internals; these are model instructions, not a guarantee of output compliance.

Ling defaults to one 4096-token slot, low-variance sampling, prompt reuse, automatic flash attention and a CPU-aware thread budget capped at eight. The sliding history budget includes tools, tool results and an output reserve, preserves complete tool exchanges and rejects oversized instructions instead of silently cutting them. Its token estimate is heuristic, not an exact tokenizer count. A smaller allocated context mainly reduces KV memory; prefill speed depends on the actual prompt length, not simply the configured maximum. Increasing parallel slots shares the configured context across requests; increase total context too when concurrent chat and voice are necessary.

Whisper keeps a warm CPU worker and performs recognition once per completed utterance while microphone ingestion continues. Audio and pending utterances are bounded; speech beyond 55 seconds is rejected rather than dispatching a truncated command. Its dependency versions are pinned in [requirements-whisper.txt](requirements-whisper.txt). The model and bundled VAD run offline; audio is not uploaded.

Optional Moonshine keeps streaming PCM and VAD, but previews decode less frequently over a shorter rolling window. Final transcripts use full-utterance `redecode` instead of stitching preview prefixes. A bounded FIFO preserves microphone samples across brief pipe stalls; sustained overload ends the session with an actionable error rather than silently losing words. Disabling captions alone does not reduce inference, and a partial-decode interval of zero increases decoding work. The following historical timings describe Moonshine/CrispASR, not Whisper.

On a Threadripper PRO 5955WX, synthetic 3.49-second and 10.25-second clips measured approximately 10.5/65.4 seconds from speech end to final under the old settings and 5.2/9.5 seconds under the new portable defaults. Final fixture transcripts were correct with the new settings; old long results duplicated text. These are not laptop or microphone benchmarks, and remaining latency is substantial. The pinned backend's CPU audio frontend remains a bottleneck.

The managed runtimes remain CPU-compatible. An optional SHA-verified optimized CrispASR build is available with `CRISPASR_CPU=avx2` followed by setup or `npm run models -- runtimes`; use it only when AVX2, FMA and F16C are supported. It lives separately from the legacy runtime. With the same fixtures it measured about 4.2/7.6 seconds, with run-to-run variation. Defaulting every machine to it would break older CPUs.

For an independently installed, compatible GPU llama.cpp binary, set `LLAMA_SERVER_BIN`; `LLAMA_GPU_LAYERS=auto` permits its native backend to select offload. The bundled CPU binary cannot use a GPU. `LLAMA_FLASH_ATTN` and `LLAMA_CACHE_TYPE_K`/`LLAMA_CACHE_TYPE_V` are also exposed under Settings > Config. KV defaults stay `f16`; `q8_0` is an opt-in benchmark candidate, not a verified quality or speed improvement for this Ling file. No CUDA/Vulkan installer matrix or GPU migration of the already-fast TTS is added.

Defaults apply after restarting owned runtimes. Existing saved settings and `.env` overrides are preserved, so remove or update old overrides to adopt the new values. Existing externally started servers keep their own configuration. Machines below four logical CPUs or approximately 16 GiB RAM receive a non-blocking local-setup advisory; meeting those thresholds does not guarantee real-time speech.

Reproducible checks use only synthetic speech and synthetic read-only tool results, never actual tasks:

```powershell
node scripts/bench-local.mjs stt whisper
node scripts/bench-local.mjs stt configured
node scripts/bench-local.mjs stt baseline
node scripts/bench-local.mjs llm
```

These checks need intact, installed model files and runtimes and never repair assets. `stt whisper` exercises the offline INT8 worker with synthetic brief, short and long commands using explicit commit and hands-free endpoints. Other STT cases explicitly benchmark Moonshine/CrispASR. The LLM benchmark compares the old configuration, 4K/f16, q8 keys, and q8 keys/values, including template rendering, task reads, a denial follow-up, empty results and tool errors. Validate on the target device before enabling optional acceleration or KV quantization. Run the dependency-free segmentation tests with `python -I test/whisper_worker_test.py` as well as `npm test`.

The LLM benchmark also checks unique, ambiguous and missing document references, one-read status answers and obvious spoken-internal leaks using synthetic read-only results. To test just the normal compact configuration, run `node scripts/bench-local.mjs llm compact-f16`. Its automatic checks are smoke tests; inspect the recorded replies for correctness and natural clarification. Prompt/schema size tests bound payload growth but do not measure actual tokenizer counts or inference latency.

An optional embedding-only regression check uses synthetic tasks and blocks network access during inference. After provisioning, set `TEST_TASK_EMBEDDINGS=1` and run `node --env-file-if-exists=.env --test test/supervisor.test.mjs`, then unset it. The regular suite skips this installed-model check and uses deterministic embedding fixtures; neither path loads the voice GGUF.

## Hosted Providers

Add OpenAI or Google keys under **Settings > Config**, then open **Voice & model**. **Use Native Voice** selects OpenAI Realtime or Google Gemini Live. **Use Dedicated Models** independently selects Local, OpenAI or Google for speech recognition, the LLM and speech synthesis. Fixed choices use keyboard-accessible pillbars below their headings. The Browser icon denotes online processing; the Folder icon denotes local processing.

Dedicated cloud stages require **Allow cloud processing** consent: hosted STT receives microphone audio, hosted LLMs receive transcripts, and hosted TTS receives response text. Hosted STT commits bounded utterances after silence or push-to-talk release; it does not provide word-by-word local-style partials. Pipeline choices persist on this device; changes end an active call before the next route starts. Model IDs remain configurable in Settings. Provider access, quota and live speech quality need validation with your own account. `.env` remains available for source automation.

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
The hosted command pushes any committed local commits, dispatches the GitHub Actions build, waits for it to finish, and publishes the same assets on [GitHub Releases](https://github.com/Dhruv-Mishra/VoiceOrchestration/releases). Keep both the installer and its `.sha256` sidecar attached because the in-app updater requires that pair.

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