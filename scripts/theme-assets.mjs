import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../voice_app_assets/', import.meta.url));
const destination = fileURLToPath(new URL('../public/immersive/', import.meta.url));
const images = [
  ['copilot_background.webp', 'copilot-background-1', false],
  ['copilot_background_2.png', 'copilot-background-2', true],
  ['jarvis_background.png', 'jarvis-background-1', false],
  ['jarvis_background_2.png', 'jarvis-background-2', false],
  ['baymax_background.png', 'baymax-background-1', true],
  ['baymax_background_2.png', 'baymax-background-2', true],
];
const sounds = [
  ['copilot_bootup_sound.wav', 'copilot-bootup'],
  ['copilot_action_sound.wav', 'copilot-action'],
  ['jarvis_bootup_sound.mp3', 'jarvis-bootup'],
  ['jarvis_action_sound.mp3', 'jarvis-action'],
  ['baymax_bootup.mp3', 'baymax-bootup'],
  ['baymax_action_sound.mp3', 'baymax-action'],
];
await mkdir(destination, { recursive: true });
for (const [name, start, end] of [['white', 255, 239], ['black', 8, 29]]) {
  const channel = `${start}+(${end}-${start})*Y/H`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=1600x900',
    '-vf', `format=rgb24,geq=r='${channel}':g='${channel}':b='${channel}',setsar=1`,
    '-frames:v', '1', '-c:v', 'libwebp', '-quality', '84', '-compression_level', '6', '-pix_fmt', 'yuv420p',
    path.join(destination, `${name}-background.webp`)], { stdio: 'inherit' });
}
for (const [filename, name, reframe] of images) {
  const filters = [
    ...(reframe ? ['crop=iw:ih*0.8:0:0'] : []),
    'scale=1600:900:force_original_aspect_ratio=increase:flags=lanczos',
    'crop=1600:900', 'setsar=1',
  ];
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(source, filename),
    '-map_metadata', '-1', '-vf', filters.join(','), '-frames:v', '1',
    '-c:v', 'libwebp', '-quality', '84', '-compression_level', '6', '-pix_fmt', 'yuv420p',
    path.join(destination, `${name}.webp`)], { stdio: 'inherit' });
}
for (const [filename, name] of sounds) {
  const input = path.join(source, filename);
  const measurement = spawnSync('ffmpeg', ['-hide_banner', '-i', input,
    '-af', 'apad=pad_dur=0.4,loudnorm=I=-23:TP=-3:LRA=7:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
  if (measurement.status !== 0) throw new Error(`Cannot measure ${filename}: ${measurement.error?.message || measurement.stderr}`);
  const measured = JSON.parse(measurement.stderr.slice(measurement.stderr.lastIndexOf('{'), measurement.stderr.lastIndexOf('}') + 1));
  const filter = `loudnorm=I=-23:TP=-3:LRA=7:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-map_metadata', '-1',
    '-af', `${filter},afade=t=in:d=0.01,areverse,afade=t=in:d=0.03,areverse`,
    '-ar', '48000', '-ac', '1', '-c:a', 'libvorbis', '-q:a', '4',
    path.join(destination, `${name}.ogg`)], { stdio: 'inherit' });
}
console.log('Normalized six 1600x900 WebP backgrounds and six mono 48kHz Ogg cues. Originals preserved.');