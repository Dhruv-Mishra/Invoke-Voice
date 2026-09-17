import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import yauzl from 'yauzl';

const destination = fileURLToPath(new URL('../public/immersive/', import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'voice-theme-assets-'));
await mkdir(destination, { recursive: true });

async function download(url, name) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const target = path.join(temporary, name);
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
  return target;
}

function image(source, name, filter) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', source, '-vf', filter, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '84', path.join(destination, name)], { stdio: 'inherit' });
}

async function extractAudio(archive) {
  const selections = { 'click_001.ogg': 'copilot-navigation', 'confirmation_001.ogg': 'copilot-action', 'select_001.ogg': 'reactor-navigation', 'maximize_001.ogg': 'reactor-action', 'bong_001.ogg': 'companion-action', 'drop_001.ogg': 'companion-navigation' };
  return new Promise((resolve, reject) => yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    zip.on('error', reject);
    zip.on('end', () => Object.keys(selections).length ? reject(new Error(`Missing sounds: ${Object.keys(selections)}`)) : resolve());
    zip.on('entry', entry => {
      const basename = path.posix.basename(entry.fileName);
      const name = selections[basename];
      if (!name) return zip.readEntry();
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', async () => {
          try {
            const source = path.join(temporary, basename);
            await writeFile(source, Buffer.concat(chunks));
            execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', source, '-t', '0.7', '-af', 'afade=t=out:st=0.5:d=0.2,loudnorm=I=-24:TP=-6:LRA=7', '-ar', '24000', '-ac', '1', '-c:a', 'libvorbis', '-q:a', '3', path.join(destination, `${name}.ogg`)], { stdio: 'inherit' });
            delete selections[basename];
            zip.readEntry();
          } catch (error) { zip.close(); reject(error); }
        });
      });
    });
    zip.readEntry();
  }));
}

try {
  const sphere = await download('https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/White%20circle/3D/white_circle_3d.png', 'sphere.png');
  image(sphere, 'companion.webp', 'scale=512:512:flags=lanczos');
  const reactor = fileURLToPath(new URL('../public/jarvis-icon.webp', import.meta.url));
  const mask = "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip((249-sqrt(pow(X-255.5,2)+pow(Y-255.5,2)))/2,0,1)'";
  image(reactor, 'reactor.webp', mask);
  image(reactor, 'reactor-gold.webp', `${mask},hue=h=155:s=0.65`);
  for (const [name, id] of Object.entries({ observatory: 'photo-1462331940025-496dfbfc7564', skyline: 'photo-1519608487953-e999c86e7455', sanctuary: 'photo-1487958449943-2429e8be8625', garden: 'photo-1493976040374-85c8e12f0c0e' })) {
    const source = await download(`https://images.unsplash.com/${id}?auto=format&fit=crop&w=1600&h=1000&q=85`, `${name}.jpg`);
    image(source, `${name}.webp`, 'scale=1600:1000:force_original_aspect_ratio=increase:flags=lanczos,crop=1600:1000');
  }
  const archive = await download('https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip', 'sounds.zip');
  await extractAudio(archive);
  const license = await download('https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/LICENSE', 'fluent-license.txt');
  await writeFile(path.join(destination, 'fluent-license.txt'), await readFile(license));
  console.log('Theme assets normalized: 512px alpha sprites, 1600x1000 WebP wallpapers, mono 24kHz Ogg cues.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}