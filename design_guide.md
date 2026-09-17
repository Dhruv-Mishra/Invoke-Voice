# Design Guide

## Direction

A quiet workspace, not a dashboard or a marketing page. Borrow Apple's restraint: neutral surfaces, precise type, one action accent, and room around the assistant. Keep the existing bitmap artwork. Prefer removing chrome or copy over adding decoration.

## Ownership

- [public/themes.js](public/themes.js): all `--cp-*` colors, type, spacing, radii, motion and assets. Immersive themes may vary the surface palette, Lucide icons, display font, sprite motion and short sound cues while preserving labels, navigation and control geometry. Copilot remains the original default.
- [public/theme.css](public/theme.css): responsive layout and component presentation. Edit the owning rule instead of appending competing overrides.
- [public/index.html](public/index.html): semantic structure, baseline controls and first-paint fallback. Preserve DOM IDs used by the application.
- [public/main.js](public/main.js): reactive home and local appearance/sidebar preferences.
- [public/VoiceSprite.js](public/VoiceSprite.js): visual state only. Transport and audio remain app-scoped in [public/app.js](public/app.js).

## Type And Surfaces

| Use | Rule |
| --- | --- |
| Font | Segoe UI Variable / Segoe UI / Aptos / Calibri. Display variant for headings. No external font dependency. |
| Scale | 15px body and form fields, 13px buttons and labels, 12px metadata, 18px dialog content headings, 24px page titles, 32px home title (24px mobile). |
| Weight | 400 for reading and controls, 600 for headings and selection. Never bold every label. |
| Rhythm | 1.5 body leading, 1.25 heading leading, zero letter spacing. No viewport-based font sizing. |
| Color | Neutral ink and pearl surfaces; `--cp-accent` for actions. Status colors only for actual success, warning or failure. |
| Shape | 8px controls/repeated items, 16px dialogs, circular icon controls. The voice dock uses theme-specific radii without changing control positions. No cards inside cards. |
| Depth | Hairlines and surface contrast. No decorative gradients or chrome shadows. Blur only on overlays and persistent chrome. |

## Spacing

Use the existing `--cp-space-*` tokens, not one-off form padding or inline styles. The 4px base supports an 8/12/16/24/32px structural rhythm adapted from the Apple reference for a working app.

| Relationship | Spacing |
| --- | --- |
| Single-line inputs and selects | `--cp-control-height` (44px minimum); 8px vertical and 12px horizontal padding. Native select fallbacks reserve additional arrow space. |
| Label to field | 8px (`--cp-space-2`), including generated tool/config fields. |
| Between fields | 16px (`--cp-space-4`). |
| Section separation and desktop dialog/card padding | 24px (`--cp-space-6`). |
| Desktop page padding | 32px (`--cp-space-8`). |
| Mobile page/dialog/card padding | 16px (`--cp-space-4`). |

- All text, URL, number and password inputs, textareas and dropdowns use 15px text on desktop and 16px on mobile. Placeholder text and open dropdown options inherit the same UI font and size as their field.
- Multiline fields grow with their rows. The chat composer intentionally uses 16px text and a 48px minimum height, with the same internal padding as other fields.
- Keep icon hit targets, switch tracks, sprite artwork and caption geometry independent of form spacing; their fixed dimensions are functional, not extra spacing variants.

## Interaction Rules

- One clear primary action per surface. Utility actions use Lucide icons with accessible names and hover titles; commands may use icon + short text.
- Use stable 44px utility targets. Never hide essential actions behind hover alone.
- Use native `details` for advanced options, logs, provider settings and metadata; closed by default. Keep results, errors, consent and download costs visible.
- Use native `popover` for transient appearance selection. Escape and outside click dismiss it. Share the same theme cards with Settings.
- Theme selection has a Theme heading and three rectangular, lightly elevated preview cards with actual wallpapers and centered sprites. Each card has a theme name, selected outline/check, side wallpaper arrows and a bottom sprite-swap icon when alternatives exist. Controls are 44px native buttons with hover titles; never nest buttons. Customizing an inactive card only changes its preview until selected. Cards stack on mobile. Opal belongs to Copilot's sprite choices. Baymax is face-only.
- The assistant button delegates to the microphone action. Never implement another session lifecycle in the sprite or theme UI.
- The sidebar collapses to a 76px rail on desktop and becomes bottom navigation on mobile. Persist its preference without hiding mobile navigation.
- Settings use unframed sections and one label per control. Fixed option sets use the shared pillbar below the heading, with native buttons, radio semantics and arrow-key selection. Keep checkbox switches; the label and Space must both work. Dynamic lists such as work areas and discovered agents retain native selects.
- Settings sections use 18px headings and 32px separation; subgroups use 15-16px headings and 24px field spacing. Appearance, sound and session defaults are separate unframed groups. Theme previews remain 16:9.
- Voice routing uses one Native Voice / Dedicated Models pillbar. Native providers are OpenAI and Google; dedicated speech-to-text, LLM and text-to-speech stages each offer Local, OpenAI and Google. Use a Lucide Browser icon for online choices and Folder icon for local choices. Keep API keys and advanced model identifiers in Settings.
- The route dialog shows configured model names, never a second editable model field. Text defaults are Ling (`ling-local`), GPT-5.6 Sol (`gpt-5.6-sol`) and Gemini 3.8 Flash (`gemini-3.8-flash`); saved provider settings take precedence. Identifiers must be available in the user's provider account; live cloud availability is not validated by the UI tests.
- The dock keeps options, mute, microphone, interrupt and chat in fixed positions. Its ring uses real captured/playback levels from the app-scoped audio graph, resets on disconnect/interruption and pauses when the document is hidden. Captions remain the primary conversational feedback.
- Dropdowns use the shared UI font: 15px desktop, 16px mobile, regular weight, 44px control/option targets and 8px corners. Style `::picker(select)` where supported; retain native fallback behavior. Use a quiet chevron, accent selection and no menu shadow. Verify the open menu, not just the closed control.
- Task cards show title, state, a bounded summary and compact metadata. Full results, paths and activity live in the detail view. Titles must be keyboard-operable.
- Render assistant Markdown only with `renderSafeMarkdown`; user text, logs and JSON remain plain text.
- Use sentence case and literal labels. Avoid explanatory slogans, redundant subtitles, implementation terminology and repeated headings.

## Motion And Acceptance

- `--cp-duration-fast`: 160ms for press/selection; `--cp-duration-enter`: 280ms for entry; `--cp-duration-layout`: 320ms for sidebar layout. Use `--cp-ease`.
- Prefer opacity, small translation and a 0.96 press scale. Do not animate text size or change hit-target dimensions. Keep the dock, sprite and captions aligned during sidebar movement.
- Respect `data-motion` and the device reduced-motion preference; keep status understandable without animation. Theme changes must not remount audio or reconnect SSE/WebSocket.
- Idle artwork loops indefinitely with theme-specific tilt, translation and breathing. A separate container plays one invocation on session activation and the reverse on deactivation, then returns to idle. Keep image DOM identity stable across voice states.
- Remember wallpaper and sprite variants per theme. Each theme has two supplied images and shared white/black gradients. Use local alpha WebP artwork and still-image backgrounds; pause hidden sprite motion and never preload interface audio. Boot cues play on microphone start and actual theme changes; action cues share the tool edge pulse. Suppress hands-free capture during cues. Keep persona and voice opt-outs independent and apply them only at new-session boundaries.
- Run `npm run build`, `node --test test/frontend.test.mjs`, then `npm test`.
- Inspect Home, Settings, task detail and appearance at 1440px and 390px; also check 320px and short windows. Verify focus return, Escape, switches, assets, overflow and safe dock clearance.