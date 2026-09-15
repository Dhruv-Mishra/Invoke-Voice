# Browser UI

- Keep plain HTML, CSS, and JavaScript; no build step or framework.
- Preserve DOM IDs and server contracts used by `app.js`.
- Render model Markdown only through `renderSafeMarkdown`; keep user text, logs, IDs, and JSON plain.
- Use `--cp-*` tokens, native controls, keyboard access, responsive layouts, and reduced motion.
- Prefer one state transition path; avoid mirrored UI state and stacked style overrides.