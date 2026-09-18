import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, Platform, Arch } from 'electron-builder';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const edition = process.argv[2] || 'both';
if (!['both', 'bundled', 'online'].includes(edition)) throw new Error('Expected both, bundled or online.');
function run(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || 'Windows distribution step failed.');
}
async function checksum(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  writeFileSync(`${filename}.sha256`, `${digest.digest('hex')}  ${path.basename(filename)}\n`, 'ascii');
}
run(['scripts/build-kokoro-pack.mjs']);
run(['scripts/desktop-icon.mjs']);
run(['node_modules/vite/bin/vite.js', 'build']);
const descriptor = JSON.parse(readFileSync(path.join(root, 'artifacts', 'voice-pack', 'descriptor.json'), 'utf8'));
for (const selected of edition === 'both' ? ['bundled', 'online'] : [edition]) {
  const output = selected === 'bundled' ? 'release' : 'release/online';
  const overrides = {
    directories: { output },
    extraMetadata: { distributionEdition: selected },
    files: [...config.build.files.filter(pattern => pattern !== 'artifacts/voice-pack/*.tar.xz'), ...(selected === 'online' ? ['!artifacts/voice-pack/*.tar.xz'] : [`artifacts/voice-pack/${descriptor.filename}`])],
    win: { ...config.build.win, artifactName: selected === 'online' ? '${productName}-Setup-${version}-Online.${ext}' : config.build.win.artifactName },
  };
  await build({ projectDir: root, targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), config: overrides, publish: 'never' });
  const executable = path.join(root, output, 'win-unpacked', `${config.build.productName}.exe`);
  run(['--test', 'test/desktop.test.mjs'], { ...process.env, SUPERVISOR_PACKAGED_EXE: executable });
  if (selected === 'online') {
    const filename = `${config.build.productName}-Setup-${config.version}-Online.exe`;
    copyFileSync(path.join(root, output, filename), path.join(root, 'release', filename));
  }
  await checksum(path.join(root, 'release', `${config.build.productName}-Setup-${config.version}${selected === 'online' ? '-Online' : ''}.exe`));
}
copyFileSync(path.join(root, 'artifacts', 'voice-pack', descriptor.filename), path.join(root, 'release', descriptor.filename));
await checksum(path.join(root, 'release', descriptor.filename));
const tag = `v${config.version}`;
const installerNames = [`${config.build.productName}-Setup-${config.version}.exe`, `${config.build.productName}-Setup-${config.version}-Online.exe`];
const manifest = {
  tag_name: tag, name: `${config.build.productName} ${config.version}`, draft: false,
  prerelease: config.version.includes('-'), published_at: new Date().toISOString(),
  assets: installerNames.flatMap(name => [name, `${name}.sha256`]).map(name => ({ name, browser_download_url: `https://github.com/Dhruv-Mishra/VoiceOrchestration/releases/download/${tag}/${encodeURIComponent(name)}` })),
};
writeFileSync(path.join(root, 'release', 'invoke-update.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await checksum(path.join(root, 'release', 'invoke-update.json'));