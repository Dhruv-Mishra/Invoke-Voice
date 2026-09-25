# Captions

- `controller.js` owns caption rendering, timing, dismissal, and accessibility announcements. It forwards thinking lines as `voice-supervisor:thinking` events; `VoiceHome` in `public/main.js` renders the thought cloud.
- `voice-bridge.js` translates voice transcript events into caption and conversation actions.
- Keep card dimensions in CSS; do not measure text, width, or height in JavaScript.
- Streamed prefix updates append only the new words (`.caption-words`, fade-in); revisions replace the text. `.caption-text` uses column-reverse so the newest line stays in view without scroll code.
- Preserve separate user/assistant lifecycles and ignore non-conversation roles.
- Validate with `node --test test/frontend.test.mjs` after `npm run build`.
