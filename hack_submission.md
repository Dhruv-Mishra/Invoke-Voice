# Invoke

## Description

**From Voice to Agency**

Invoke is a voice-first orchestration platform that transforms spoken intent into action, routing tasks across local and cloud models and initiating agentic sessions on the user's behalf.

Most assistants end at an answer. Invoke connects the conversation to ongoing work: describe an objective, delegate it to Agency or GitHub Copilot CLI, queue a follow-up, and receive an outcome without losing the original session. Coding tasks use isolated Git worktrees. Research tasks use a restricted read-only tool profile, with enterprise data access explicitly opt-in.

The Windows desktop experience brings together local voice models, hosted voice, persistent task history, a concise notification inbox, and voice-controlled app preferences. Setup and connection checks distinguish installed components, reachable tools, and access that still requires user action. Users can mix local, OpenAI, and Google stages, or keep the conversation pipeline local while deliberately delegating selected work externally.

Repository and downloads: https://github.com/Dhruv-Mishra/VoiceOrchestration

## Keywords

Invoke, voice-first, agent orchestration, Agency, GitHub Copilot, local AI, human-agent interaction, developer productivity, accessibility, task automation, Electron, Vue, Model Context Protocol, speech recognition, text-to-speech

## Potential Microsoft Product Integration

**Visual Studio Code and GitHub Copilot** are the closest fit: a voice-first control surface for starting agent sessions, following progress, and continuing coding work across repositories.

**Microsoft 365 Copilot** is a complementary direction for consented work-data research through WorkIQ and Teams integrations. Invoke is an independent project, not an official Microsoft product or an announced product integration.

## What We Made And How

I built Invoke as a Windows desktop application using Electron, a Vue 3/Vite interface, and a loopback-only Node.js service. The service owns task persistence, tool execution, voice sessions, and realtime UI updates over HTTP, SSE, and WebSocket.

The local speech pipeline combines NVIDIA Parakeet (or Whisper Small / Moonshine Tiny) for recognition, Gemma 4 E2B or the opt-in Qwen3.6 35B-A3B through llama.cpp for language and tool reasoning, and Kokoro for speech synthesis. Hosted OpenAI and Google routes are configurable alternatives. Managed setup provisions pinned, verified assets and an isolated Python environment with explicit download consent.

Agency and GitHub Copilot CLI perform delegated work. Persistent FIFO follow-up queues preserve session context, pause after failures, and avoid replaying receipted actions. Compact tool contracts conserve local-model context. Text chat and local/hybrid voice separate tool rounds from final conversational output; native hosted realtime speech remains provider-controlled. Background outcomes use a deduplicated announcement queue.

Testing includes deterministic runtime contracts, security boundaries, queue races, responsive Electron browser workflows, and packaged Windows smoke tests. Installers include checksum verification and edition-preserving updates.

## Scope And Limitations

Local conversation does not make delegated cloud work local. Provider access, Agency sign-in, enterprise permissions, and hardware performance remain environment-dependent. Installers are unsigned. Theme media supplied for this personal project has unverified redistribution rights; the project does not claim endorsement from Microsoft, Disney, or Marvel. A stable version label is not a claim of enterprise certification.