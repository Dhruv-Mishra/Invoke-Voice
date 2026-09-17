# Design Guide

## Direction

A quiet workspace, not a dashboard or a marketing page. Borrow Apple's restraint: neutral surfaces, precise type, one action accent, and room around the assistant. Keep the existing bitmap artwork. Prefer removing chrome or copy over adding decoration.

## Ownership

- [public/themes.js](public/themes.js): all `--cp-*` colors, type, spacing, radii, motion and assets. Appearance choices change artwork, not the interaction language.
- [public/theme.css](public/theme.css): responsive layout and component presentation. Edit the owning rule instead of appending competing overrides.
- [public/index.html](public/index.html): semantic structure, baseline controls and first-paint fallback. Preserve DOM IDs used by the application.
- [public/main.js](public/main.js): reactive home and local appearance/sidebar preferences.
- [public/VoiceSprite.js](public/VoiceSprite.js): visual state only. Transport and audio remain app-scoped in [public/app.js](public/app.js).

## Type And Surfaces

| Use | Rule |
| --- | --- |
| Font | Segoe UI Variable / Segoe UI / Aptos / Calibri. Display variant for headings. No external font dependency. |
| Scale | 15px body, 13px controls, 12px metadata, 18px dialog content headings, 24px page titles, 32px home title (24px mobile). |
| Weight | 400 for reading and controls, 600 for headings and selection. Never bold every label. |
| Rhythm | 1.5 body leading, 1.25 heading leading, zero letter spacing. No viewport-based font sizing. |
| Color | Neutral ink and pearl surfaces; `--cp-accent` for actions. Status colors only for actual success, warning or failure. |
| Shape | 8px controls/repeated items, 16px dialogs, circular icon controls and voice dock. No cards inside cards. |
| Depth | Hairlines and surface contrast. No decorative gradients or chrome shadows. Blur only on overlays and persistent chrome. |

## Interaction Rules

- One clear primary action per surface. Utility actions use Lucide icons with accessible names and hover titles; commands may use icon + short text.
- Use stable 44px utility targets. Never hide essential actions behind hover alone.
- Use native `details` for advanced options, logs, provider settings and metadata; closed by default. Keep results, errors, consent and download costs visible.
- Use native `popover` for transient appearance selection. Escape and outside click dismiss it. Image choices have names for assistive technology, not visible captions.
- The assistant button delegates to the microphone action. Never implement another session lifecycle in the sprite or theme UI.
- The sidebar collapses to a 76px rail on desktop and becomes bottom navigation on mobile. Persist its preference without hiding mobile navigation.
- Settings use unframed sections and one label per control. Retain native selects and checkbox switches; the label and Space must both work.
- Task cards show title, state, a bounded summary and compact metadata. Full results, paths and activity live in the detail view. Titles must be keyboard-operable.
- Render assistant Markdown only with `renderSafeMarkdown`; user text, logs and JSON remain plain text.
- Use sentence case and literal labels. Avoid explanatory slogans, redundant subtitles, implementation terminology and repeated headings.

## Motion And Acceptance

- `--cp-duration-fast`: 160ms for press/selection; `--cp-duration-enter`: 280ms for entry; `--cp-duration-layout`: 320ms for sidebar layout. Use `--cp-ease`.
- Prefer opacity, small translation and a 0.96 press scale. Do not animate text size or change hit-target dimensions. Keep the dock, sprite and captions aligned during sidebar movement.
- Respect `data-motion` and the device reduced-motion preference; keep status understandable without animation. Theme changes must not remount audio or reconnect SSE/WebSocket.
- Run `npm run build`, `node --test test/frontend.test.mjs`, then `npm test`.
- Inspect Home, Settings, task detail and appearance at 1440px and 390px; also check 320px and short windows. Verify focus return, Escape, switches, assets, overflow and safe dock clearance.