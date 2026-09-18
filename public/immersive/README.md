# Theme Media

All media is bundled locally. No third-party asset requests occur while using the app. These are unofficial character-inspired presentations, not endorsed Disney/Marvel products or actor voice clones.

## Artwork

The active `copilot-background-1/2.webp`, `jarvis-background-1/2.webp` and `baymax-background-1/2.webp` files derive from user-supplied originals in `voice_app_assets`. These assets have no accompanying license; verify distribution rights before shipping externally. `white-background.webp` and `black-background.webp` are generated neutral gradients. All eight backgrounds are 1600x900, square-pixel WebP, quality 84, compression level 6, YUV420. Copilot background 2 and both Baymax images use a localized FFmpeg `delogo` repair over their lower-right generation marks. Aspect fitting crops equally around the original center only where necessary for 16:9; no top-biased reframing is used. Originals remain unchanged. At display time, one centered, full-viewport background continues behind the translucent navigation; non-16:9 viewports use centered cover fitting.

Sprite provenance:

| Local asset | Source | License / Changes |
| --- | --- | --- |
| companion.webp | [Microsoft Fluent Emoji, White circle 3D](https://github.com/microsoft/fluentui-emoji/blob/main/assets/White%20circle/3D/white_circle_3d.png) | MIT; see [full license](fluent-license.txt), also linked in Settings and bundled by Vite. Resampled to 512px WebP with alpha. Face-only composition with original eye expressions; grayscale applied in CSS. |
| reactor.webp, reactor-gold.webp | Existing artwork | Circular alpha masks remove the baked-in checkerboard. The Palladium variant is hue-adjusted. Upstream provenance was not present; verify distribution rights before shipping externally. |

Existing Copilot and Opal artwork remains unchanged outside this directory.

## Sounds

The active `{copilot,jarvis,baymax}-{bootup,action}.ogg` files derive from the six user-supplied WAV/MP3 originals in `voice_app_assets`. No license was supplied; verify distribution rights. They retain their original durations, use two-pass loudness normalization targeting -23 LUFS / -3 dBTP with short edge fades, and share mono 48kHz Vorbis quality 4 encoding. They do not loop; hands-free capture pauses during playback.

## Preparation

From the app directory, run `node scripts/theme-assets.mjs` with FFmpeg installed and the supplied originals in `voice_app_assets`. The command is offline, deterministic and only writes normalized backgrounds/cues in this directory. It preserves source files and existing sprites. Normal builds consume the checked-in assets and never run preparation.