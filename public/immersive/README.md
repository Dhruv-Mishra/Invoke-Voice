# Theme Media

All media is bundled locally. No third-party asset requests occur while using the app. These are unofficial character-inspired presentations, not endorsed Disney/Marvel products or actor voice clones.

## Artwork

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

All six Ogg files derive from [Kenney Interface Sounds 1.0](https://kenney.nl/assets/interface-sounds), dedicated to the public domain under [CC0](https://creativecommons.org/publicdomain/zero/1.0/).

| Local cue | Original |
| --- | --- |
| copilot-navigation | click_001.ogg |
| copilot-action | confirmation_001.ogg |
| reactor-navigation | select_001.ogg |
| reactor-action | maximize_001.ogg |
| companion-navigation | drop_001.ogg |
| companion-action | bong_001.ogg |

Cues are bounded to 700ms, faded, loudness-normalized to -24 LUFS with -6 dBTP target, and encoded as mono 24kHz Vorbis. Very short clips may not reach the integrated loudness target. Playback has an additional low per-theme gain and never overlaps a voice session.

## Preparation

From the app directory, run `node scripts/theme-assets.mjs` with FFmpeg installed. Downloads use temporary files and only write this media directory. Inspect regenerated artwork before shipping; source servers may change their images. Normal builds consume the checked-in assets and never run the preparation command.