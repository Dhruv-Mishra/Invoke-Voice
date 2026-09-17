# Browser UI

- Read [the design guide](../design_guide.md) before frontend edits; it is the shared source for visual and interaction decisions.
- Use Vue 3/Vite for reactive presentation and preserve DOM IDs and server contracts used by `app.js`.
- Keep transport/audio ownership outside component mount cycles so theme changes cannot restart live sessions.
- Render model Markdown only through `renderSafeMarkdown`; keep user text, logs, IDs, and JSON plain.
- Use `--cp-*` tokens, native controls, keyboard access, responsive layouts, and reduced motion.
- Prefer one state transition path; avoid mirrored UI state and stacked style overrides.