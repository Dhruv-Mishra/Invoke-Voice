# Captions

- `controller.js` owns caption rendering, timing, dismissal, and accessibility announcements.
- `voice-bridge.js` translates voice transcript events into caption and conversation actions.
- Keep card dimensions in CSS; do not measure text, width, or height in JavaScript.
- Preserve separate user/assistant lifecycles and ignore non-conversation roles.
- Validate with `node --test test/frontend.test.mjs` after `npm run build`.
