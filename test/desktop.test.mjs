import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import desktopLaunch from '../scripts/desktop-launch.cjs';
import { createLocalSetup } from '../src/local-setup.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('packaged child uses bundled Electron Node mode, physical unpacked sources and writable config', () => {
  const resourcesPath = path.join(root, 'release', 'win-unpacked', 'resources');
  const dataDir = path.join(os.tmpdir(), 'Voice Supervisor launch fixture');
  const executable = path.join(root, 'release', 'win-unpacked', 'Invoke.exe');
  const spec = desktopLaunch.serverLaunch({ executable, resourcesPath, appRoot: root, packaged: true, dataDir, env: { NODE_OPTIONS: '--inspect=0.0.0.0', NODE_PATH: 'untrusted', PORT: '4317' } });
  assert.equal(spec.executable, executable);
  assert.equal(spec.options.cwd, dataDir);
  assert.equal(spec.options.shell, false);
  assert.equal(spec.args[0], `--env-file-if-exists=${path.join(dataDir, '.env')}`);
  assert.equal(spec.args[1], path.join(resourcesPath, 'app.asar.unpacked', 'src', 'server.mjs'));
  assert.deepEqual(spec.args.slice(-2), ['--port', '0']);
  assert.equal(spec.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(spec.options.env.PORT, '0');
  assert.equal(spec.options.env.NODE_OPTIONS, undefined);
  assert.equal(spec.options.env.NODE_PATH, undefined);
  const source = desktopLaunch.serverLaunch({ executable, resourcesPath, appRoot: root, packaged: false, dataDir, env: {} });
  assert.equal(source.options.cwd, root);
  assert.equal(source.args[1], path.join(root, 'src', 'server.mjs'));
});

test('installer includes physical runtime dependencies, excludes private data and uses per-user one-click NSIS', () => {
  const config = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(config.main, 'desktop.cjs');
  assert.deepEqual(config.author, { name: 'Dhruv Mishra', email: 'dhruvmishra.id@gmail.com' });
  assert.doesNotMatch(config.devDependencies.electron, /alpha|beta/);
  assert.equal(config.scripts['kokoro-pack'], 'node scripts/build-kokoro-pack.mjs');
  assert.equal(config.scripts['dist:win'], 'node scripts/dist-win.mjs');
  const distributor = readFileSync(path.join(root, 'scripts', 'dist-win.mjs'), 'utf8');
  assert.match(distributor, /run\(\['scripts\/build-kokoro-pack.mjs'\]\)/);
  assert.match(distributor, /distributionEdition: selected/);
  assert.match(distributor, /!artifacts\/voice-pack\/\*\.tar\.xz/);
  assert.equal(config.build.asar, true);
  assert.equal(config.build.compression, 'maximum');
  assert.equal(config.build.nsis.differentialPackage, false);
  for (const platform of ['darwin', 'linux', 'win32/arm64']) assert.ok(config.build.files.includes(`!node_modules/onnxruntime-node/bin/napi-v3/${platform}/**`));
  assert.ok(!config.build.files.includes('!node_modules/onnxruntime-node/bin/napi-v3/win32/x64/**'));
  assert.ok(config.build.files.includes('scripts/whisper_worker.py'));
  assert.ok(config.build.files.includes('requirements-whisper.txt'));
  assert.ok(config.build.asarUnpack.includes('requirements-whisper.txt'));
  for (const included of ['src/**', 'scripts/**', 'dist/**', 'artifacts/voice-pack/**', 'package.json', 'requirements-local.txt', 'node_modules/**']) assert.ok(config.build.asarUnpack.includes(included));
  for (const included of ['desktop-preload.cjs', 'desktop-update.cjs', 'scripts/models.mjs', 'scripts/start.mjs', 'scripts/desktop-launch.cjs', 'scripts/kokoro_worker.py', 'scripts/voice_pack.py', 'artifacts/voice-pack/descriptor.json', 'artifacts/voice-pack/*.tar.xz', 'requirements-local.txt']) assert.ok(config.build.files.includes(included));
  assert.ok(config.build.files.includes('!**/.env*'));
  assert.ok(config.build.files.includes('!**/*.{gguf,pth,pt}'));
  assert.ok(config.build.files.indexOf('artifacts/voice-pack/descriptor.json') > config.build.files.indexOf('!**/{test,tests,artifacts,state,.git,.venv,__pycache__}/**'));
  assert.equal(config.build.productName, 'Invoke');
  assert.equal(config.build.win.icon, 'build/invoke.ico');
  assert.equal(config.build.win.signAndEditExecutable, true);
  assert.ok(config.build.files.includes('build/invoke.png'));
  assert.equal(config.build.nsis.oneClick, true);
  assert.equal(config.build.nsis.perMachine, false);
  assert.equal(config.build.nsis.allowElevation, false);
});

test('local voice pack targets Python 3.12 Windows x64 and verifies a hash-locked offline install', () => {
  const recipe = readFileSync(path.join(root, 'requirements-kokoro-pack.in'), 'utf8');
  const builder = readFileSync(path.join(root, 'scripts', 'build-kokoro-pack.mjs'), 'utf8');
  for (const requirement of ['torch==2.8.0', 'kokoro==0.9.4', 'soundfile==0.13.1', 'spacy>=3.8,<3.9', 'docopt==0.6.2', 'en_core_web_sm-3.8.0-py3-none-any.whl', 'faster-whisper==1.2.1', 'ctranslate2==4.6.0', 'onnxruntime==1.23.2', 'setuptools==80.9.0']) assert.ok(recipe.includes(requirement));
  for (const target of ["'win_amd64'", "'cp312'", "'3.12'"]) assert.ok(builder.includes(target));
  for (const verification of ["'--no-index'", "'--require-hashes'", "'check'", 'torch.version.cuda is None', 'verifyKokoroPack', 'verifyWhisperPack', 'get_supported_compute_types']) assert.ok(builder.includes(verification));
  assert.ok(builder.indexOf("'torch==2.8.0'") < builder.indexOf("'-r', recipe"));
});

test('desktop updater uses an isolated preload bridge and verified installer flow', () => {
  const desktop = readFileSync(path.join(root, 'desktop.cjs'), 'utf8');
  const preload = readFileSync(path.join(root, 'desktop-preload.cjs'), 'utf8');
  assert.match(desktop, /contextIsolation:\s*true/);
  assert.match(desktop, /nodeIntegration:\s*false/);
  assert.match(desktop, /sandbox:\s*true/);
  assert.match(desktop, /preload:\s*path\.join\(__dirname, 'desktop-preload\.cjs'\)/);
  assert.match(desktop, /downloadUpdate\(pendingUpdate/);
  assert.match(desktop, /spawn\(installer, \[\], \{ detached: true, stdio: 'ignore', windowsHide: false, shell: false \}\)/);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer/s);
  assert.match(preload, /check: \(\) => ipcRenderer\.invoke\('updates:check'\)/);
  assert.match(preload, /install: \(\) => ipcRenderer\.invoke\('updates:install'\)/);
});

test('beta publisher builds before atomically pushing its version tag and prerelease', () => {
  const config = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'beta-release.yml'), 'utf8');
  const publisher = readFileSync(path.join(root, 'scripts', 'publish-beta.mjs'), 'utf8');
  const localPublisher = readFileSync(path.join(root, 'scripts', 'publish-beta-local.mjs'), 'utf8');
  assert.equal(config.scripts['release:beta'], 'node scripts/publish-beta.mjs');
  assert.equal(config.scripts['release:beta:local'], 'node scripts/publish-beta-local.mjs');
  assert.equal(config.scripts['release:stable:local'], 'node scripts/publish-beta-local.mjs stable');
  assert.match(localPublisher, /semver\.prerelease\(config\.version\)/);
  assert.match(localPublisher, /'--latest', '--notes-file'/);
  assert.match(localPublisher, /invoke-update\.json/);
  assert.match(localPublisher, /runNpm\(\['audit', '--omit=dev'\]\)/);
  assert.match(workflow, /actions\/setup-python@v5[\s\S]*python-version: '3\.12'[\s\S]*architecture: x64/);
  assert.match(publisher, /git', \['status', '--porcelain'/);
  assert.match(publisher, /releaseBranch = process\.env\.RELEASE_BRANCH \|\| 'master'/);
  assert.ok(workflow.indexOf('run: npm run dist:win') < workflow.indexOf('git push --atomic'));
  assert.match(workflow, /permissions:\s+contents: write/);
  assert.match(workflow, /--generate-notes --prerelease --latest=false/);
  assert.ok(localPublisher.indexOf("runNpm(['test'])") < localPublisher.indexOf("run('git', ['commit'"));
  assert.ok(localPublisher.indexOf("runNpm(['run', 'dist:win'])") < localPublisher.indexOf("run('git', ['push'"));
  assert.ok(localPublisher.indexOf('SUPERVISOR_PACKAGED_EXE: packagedExecutable') < localPublisher.indexOf("run('git', ['commit'"));
  assert.match(localPublisher, /'ls-remote', '--exit-code', '--tags'/);
  assert.match(localPublisher, /gh release upload.*--clobber/s);
  assert.match(localPublisher, /'release', 'create'.*'--verify-tag'/s);
});

test('desktop allows setup documentation sources but rejects arbitrary URLs and protocols', context => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'voice-desktop-links-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const url of ['https://aka.ms/agency', 'https://github.com/Dhruv-Mishra/Invoke-Voice/releases', 'https://github.com/Dhruv-Mishra/Invoke-Voice/releases/latest']) assert.equal(desktopLaunch.allowedExternal(url), true);
  for (const provider of ['whisper', 'moonshine']) {
    const setup = createLocalSetup({ env: { LOCALAPPDATA: directory, LOCAL_STT_PROVIDER: provider } });
    for (const component of setup.snapshot().components) assert.equal(desktopLaunch.allowedExternal(component.sourceUrl), true, component.sourceUrl);
    context.after(() => setup.close());
  }
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/System32/cmd.exe', 'https://github.com/evil/project', 'https://github.com@evil.test/', 'https://docs.github.com/en/copilot?redirect=https://evil.test', 'http://huggingface.co/hexgrad/Kokoro-82M']) assert.equal(desktopLaunch.allowedExternal(url), false);
});

test('built Windows app starts its packaged backend without an external Node installation', { skip: !process.env.SUPERVISOR_PACKAGED_EXE, timeout: 30000 }, async () => {
  const executable = path.resolve(process.env.SUPERVISOR_PACKAGED_EXE);
  const resourcesPath = path.join(path.dirname(executable), 'resources');
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-packaged-smoke-'));
  assert.ok(existsSync(path.join(resourcesPath, 'app.asar')));
  const backend = path.join(resourcesPath, 'app.asar.unpacked');
  const packagedConfig = JSON.parse(readFileSync(path.join(backend, 'package.json'), 'utf8'));
  const packDir = path.join(backend, 'artifacts', 'voice-pack');
  const descriptor = JSON.parse(readFileSync(path.join(packDir, 'descriptor.json'), 'utf8'));
  assert.ok(['bundled', 'online'].includes(packagedConfig.distributionEdition));
  assert.equal(existsSync(path.join(packDir, descriptor.filename)), packagedConfig.distributionEdition === 'bundled');
  assert.equal(existsSync(path.join(backend, 'artifacts', 'kokoro-offline-pack')), false);
  const ort = path.join(backend, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3');
  for (const foreign of ['darwin', 'linux', 'win32/arm64']) assert.equal(existsSync(path.join(ort, foreign)), false, foreign);
  assert.ok(existsSync(path.join(ort, 'win32', 'x64', 'onnxruntime_binding.node')));
  const probe = spawnSync(executable, ['--input-type=module', '-e', "import { pipeline } from '@huggingface/transformers'; import * as ort from 'onnxruntime-node'; if (typeof pipeline !== 'function') throw new Error('Missing embedding pipeline'); console.log(JSON.stringify(ort.listSupportedBackends()));"], { cwd: backend, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(probe.status, 0, probe.error?.message || probe.stderr);
  assert.match(probe.stdout, /cpu/);
  const { listPackage } = await import('@electron/asar');
  assert.ok(listPackage(path.join(resourcesPath, 'app.asar')).some(filename => filename.replaceAll('\\', '/') === '/build/invoke.png'));
  const spec = desktopLaunch.serverLaunch({ executable, appRoot: root, resourcesPath, packaged: true, dataDir, env: { SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), PATH: path.join(process.env.SystemRoot, 'System32'), PREWARM_LOCAL_VOICE: '0' } });
  spec.options.env.SUPERVISOR_DESKTOP = '0';
  const child = spawn(spec.executable, spec.args, { ...spec.options, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2000); });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Packaged startup timed out: ${diagnostic}`)), 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Packaged backend exited ${code}: ${diagnostic}`)); });
      child.on('message', message => { if (message?.type === 'supervisor-ready') { clearTimeout(timer); resolve(message.url); } });
    });
    const status = await fetch(`${url}/api/setup`).then(response => response.json());
    assert.equal(status.status, 'idle');
    assert.equal(status.supported, true);
    assert.equal((await fetch(`${url}/`)).status, 200);
  } finally {
    if (child.connected) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.send({ type: 'shutdown' });
      });
    }
    await desktopLaunch.stopChild(child);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});