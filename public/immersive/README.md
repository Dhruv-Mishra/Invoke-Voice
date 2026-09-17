# Theme Media

All media is bundled locally. No third-party asset requests occur while using the app. These are unofficial character-inspired presentations, not endorsed Disney/Marvel products or actor voice clones.

## Artwork

The active `copilot-background-1/2.webp`, `jarvis-background-1/2.webp` and `baymax-background-1/2.webp` files derive from user-supplied originals in `voice_app_assets`. These assets have no accompanying license; verify distribution rights before shipping externally. `white-background.webp` and `black-background.webp` are generated neutral gradients. All eight backgrounds are 1600x900, square-pixel WebP, quality 84, compression level 6, YUV420. Copilot background 2 and both Baymax images are naturally reframed above their lower-right generation marks, without patches or blur. Originals remain unchanged.

Sprite and retained legacy artwork provenance:

| Local asset | Source | License / Changes |
| --- | --- | --- |
| companion.webp | [Microsoft Fluent Emoji, White circle 3D](https://github.com/microsoft/fluentui-emoji/blob/main/assets/White%20circle/3D/white_circle_3d.png) | MIT; see [full license](fluent-license.txt), also linked in Settings and bundled by Vite. Resampled to 512px WebP with alpha. Face-only composition with original eye expressions; grayscale applied in CSS. |
| reactor.webp, reactor-gold.webp | Existing repository jarvis-icon.webp | Existing artwork retained; circular alpha mask removes the baked-in checkerboard outside the reactor. The Palladium variant is a warm rose hue-adjusted derivative. Upstream provenance was not present in the repository; verify the original artwork's rights before external distribution. |
| observatory.webp | [Deep-space photograph](https://images.unsplash.com/photo-1462331940025-496dfbfc7564) | Unsplash license; resized/cropped to 1600x1000 WebP. |
| skyline.webp | [Night-city photograph](https://images.unsplash.com/photo-1519608487953-e999c86e7455) | Unsplash license; resized/cropped to 1600x1000 WebP. |
| sanctuary.webp | [White architecture photograph](https://images.unsplash.com/photo-1487958449943-2429e8be8625) | Unsplash license; resized/cropped to 1600x1000 WebP. |
| garden.webp | [Kyoto photograph](https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e) | Unsplash license; resized/cropped to 1600x1000 WebP. |

[Unsplash license](https://unsplash.com/license): use and modification permitted, including commercial use; no sale of unmodified images or compilation into a competing image service. Existing Alpine/Copilot/Opal artwork remains unchanged outside this directory.

## Sounds

The active `{copilot,jarvis,baymax}-{bootup,action}.ogg` files derive from the six user-supplied WAV/MP3 originals in `voice_app_assets`. No license was supplied; verify distribution rights. They retain their original durations, use two-pass loudness normalization targeting -23 LUFS / -3 dBTP with short edge fades, and share mono 48kHz Vorbis quality 4 encoding. Measurement-only silence supports very short cues. They do not loop; hands-free capture pauses during playback.

Retained legacy cues (no longer selected) derive from [Kenney Interface Sounds 1.0](https://kenney.nl/assets/interface-sounds), dedicated to the public domain under [CC0](https://creativecommons.org/publicdomain/zero/1.0/).

| Local cue | Original |
| --- | --- |
| copilot-navigation | click_001.ogg |
| reactor-navigation | select_001.ogg |
| reactor-action | maximize_001.ogg |
| companion-navigation | drop_001.ogg |
| companion-action | bong_001.ogg |

The remaining legacy cues retain their original 24kHz format. Normal builds reference only active media.

## Preparation

From the app directory, run `node scripts/theme-assets.mjs` with FFmpeg installed and the supplied originals in `voice_app_assets`. The command is offline, deterministic and only writes normalized backgrounds/cues in this directory. It preserves source files and existing sprites. Normal builds consume the checked-in assets and never run preparation.