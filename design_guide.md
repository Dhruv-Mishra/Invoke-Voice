# Design Guide

## Sources Of Truth

- `public/themes.js`: colors, typography, spacing, radii, opacity, timing, theme assets and motion preferences.
- `public/theme.css`: layout and component rules. Consume `--cp-*` tokens; do not add theme-specific colors here.
- `public/index.html`: semantic structure and the small first-paint fallback theme.
- `public/VoiceSprite.js`: avatar state animations only. Audio and transport stay in `public/app.js`.

## Token Families

| Family | Purpose |
| --- | --- |
| `--cp-bg*`, `--cp-surface*`, `--cp-panel*`, `--cp-sidebar` | Page, control and elevated surfaces. |
| `--cp-text*` | Primary, secondary and low-emphasis copy. |
| `--cp-accent*`, `--cp-success`, `--cp-warning`, `--cp-danger`, `--cp-link` | Actions and semantic status. Do not repurpose status colors. |
| `--cp-border*`, `--cp-sheen`, `--cp-shadow*`, `--cp-overlay` | Boundaries, elevation and modal focus. |
| `--cp-font*`, `--cp-type-*`, `--cp-leading-*`, `--cp-weight-*` | Shared typefaces, type ramp, line heights and emphasis. |
| `--cp-space-*`, `--cp-radius-*` | Four-pixel spacing rhythm and stable control/surface shapes. |
| `--cp-opacity-disabled`, `--cp-duration-fast` | Disabled emphasis and short control transitions. |
| `--cp-wave`, `--cp-listening-hue`, `--cp-mic-glow`, `--cp-voice-glass` | Voice-specific presentation. |

## Typography

- Use Segoe UI Variable on Windows with Segoe UI, Aptos and Calibri fallbacks.
- Body text is 14px with a 1.5 line height. Use 11-13px only for captions and compact metadata.
- Use semibold headings and sentence case. Reserve 24-30px type for page and home titles.
- Keep labels stable, left aligned and unitalicized. Use Consolas only for paths, IDs, logs and tool names.
- Do not scale font size with viewport width or use negative letter spacing.

## Components

- Binary settings use a native checkbox inside `.toggle-control` with `.toggle-track`; the full visible label is clickable and Space remains supported.
- Use native selects, inputs and textareas. Keep their DOM IDs stable because transport code and browser automation depend on them.
- Desktop view dialogs are centered in the viewport with equal clearance for the persistent voice dock. Mobile views become unframed regions.
- Controls use `--cp-radius-control`; reserve `--cp-radius-surface` for true dialogs and major surfaces.
- Respect `data-motion` and `prefers-reduced-motion`. Motion must communicate state, not decorate idle screens.

## Theme Workflow

1. Add or edit a theme in `public/themes.js`.
2. Override the smallest token set possible; defaults fill the rest.
3. Use real bitmap assets under `public` and keep avatar images square.
4. Run `npm run build`, `npm test`, then inspect Settings and Home at 390px and 1440px.

References: [Fluent 2 typography](https://fluent2.microsoft.design/typography), [Windows typography](https://learn.microsoft.com/windows/apps/design/signature-experiences/typography), and [WAI switch pattern](https://www.w3.org/WAI/ARIA/apg/patterns/switch/).