import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createSetup } from '../src/setup.mjs';
import { ASSETS, CRISPASR_AVX2_ASSET, TASK_SEARCH_ASSETS, assetReady, ensureAsset, localSetupAssets, localSttProvider, stackPaths, trustedDownloadUrl, withSetupLock } from '../scripts/models.mjs';
import { approvedPythonProbe, createLocalSetup, isolatedEnvironment, runSetupCommand } from '../src/local-setup.mjs';
import { startSupervisor } from '../src/server.mjs';
import { createRuntimeConfig } from '../src/runtime-config.mjs';
import { downloadVoicePack, resolveVoicePack } from '../src/voice-pack.mjs';

function fixture(context) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'voice-setup-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, paths: stackPaths({ LOCALAPPDATA: directory }, path.join(directory, 'app')) };
}

test('local STT defaults to Whisper and Moonshine requires an explicit selection', () => {
  assert.equal(localSttProvider({}), 'whisper');
  assert.equal(localSttProvider({ LOCAL_STT_PROVIDER: 'moonshine' }), 'moonshine');
  assert.throws(() => localSttProvider({ LOCAL_STT_PROVIDER: 'browser' }), /LOCAL_STT_PROVIDER/);
  const defaults = localSetupAssets({}).map(asset => asset.id);
  assert.ok(defaults.includes('whisperModel'));
  for (const id of ['moonshine', 'tokenizer', 'vad', 'crispasr']) assert.equal(defaults.includes(id), false);
  const moonshine = localSetupAssets({ LOCAL_STT_PROVIDER: 'moonshine' }).map(asset => asset.id);
  assert.ok(moonshine.includes('moonshine') && moonshine.includes('crispasr'));
  assert.equal(moonshine.some(id => id.startsWith('whisper')), false);
});

test('Whisper model assets are pinned, verified and reusable offline', async context => {
  const { paths } = fixture(context);
  for (const asset of ASSETS.filter(asset => asset.id.startsWith('whisper'))) {
    assert.ok(paths[asset.id].startsWith(paths.whisperDir + path.sep));
    assert.match(asset.sourceUrl, /\/resolve\/[a-f0-9]{40}\//);
    const content = Buffer.from(`synthetic-${asset.id}`);
    await ensureAsset(paths, asset, { fetchImpl: async url => url.includes('/api/models/')
      ? Response.json([{ path: asset.name, size: content.length, lfs: { oid: createHash('sha256').update(content).digest('hex') } }])
      : new Response(content) });
    assert.equal(assetReady(paths, asset), true);
    await ensureAsset(paths, asset, { fetchImpl: async () => { throw new Error('No network for verified models'); } });
  }
});

test('optional task embeddings use pinned verified assets and reuse them offline', async context => {
  const { paths } = fixture(context);
  for (const asset of TASK_SEARCH_ASSETS) {
    assert.equal(ASSETS.includes(asset), false);
    assert.ok(paths[asset.id].startsWith(path.join(paths.modelDir, 'task-search-minilm') + path.sep));
    assert.match(asset.sourceUrl, /\/resolve\/[a-f0-9]{40}\//);
    const content = Buffer.from(`synthetic-${asset.id}`);
    let requests = 0;
    await ensureAsset(paths, asset, { fetchImpl: async url => {
      requests += 1;
      return url.includes('/api/models/')
        ? Response.json([{ path: asset.name, size: content.length, lfs: { oid: createHash('sha256').update(content).digest('hex') } }])
        : new Response(content);
    } });
    assert.equal(requests, 2);
    assert.equal(assetReady(paths, asset), true);
    await ensureAsset(paths, asset, { fetchImpl: async () => { throw new Error('Cached assets must not use the network'); } });
  }
});

function controller(options = {}) {
  return createSetup({ platform: 'win32', arch: 'x64', cacheDir: 'cache', runtimeDir: 'runtime', inspect: () => [{ id: 'fixture', label: 'Fixture', ready: false, sourceUrl: 'https://huggingface.co' }], install: async () => {}, activate: async () => {}, ...options });
}

function offlinePackFixture(directory, extraWheels = []) {
  const packDir = path.join(directory, 'kokoro-offline-pack');
  const wheelhouse = path.join(packDir, 'wheelhouse');
  mkdirSync(wheelhouse, { recursive: true });
  const wheels = [
    ['torch', '2.8.0+cpu', 'torch-2.8.0+cpu-cp312-cp312-win_amd64.whl'],
    ['kokoro', '0.9.4', 'kokoro-0.9.4-py3-none-any.whl'],
    ['spacy', '3.8.7', 'spacy-3.8.7-cp312-cp312-win_amd64.whl'],
    ['en-core-web-sm', '3.8.0', 'en_core_web_sm-3.8.0-py3-none-any.whl'],
    ['soundfile', '0.13.1', 'soundfile-0.13.1-py2.py3-none-win_amd64.whl'],
    ...extraWheels,
  ].map(([name, version, filename]) => {
    const contents = Buffer.from(`${name}-${version}`);
    writeFileSync(path.join(wheelhouse, filename), contents);
    return { name, version, filename, size: contents.length, sha256: createHash('sha256').update(contents).digest('hex') };
  });
  const lock = wheels.map(wheel => `${wheel.name}==${wheel.version} --hash=sha256:${wheel.sha256}`).join('\n') + '\n';
  writeFileSync(path.join(packDir, 'requirements.lock'), lock);
  writeFileSync(path.join(packDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    platform: 'win32',
    arch: 'x64',
    python: '3.12',
    abi: 'cp312',
    lock: { filename: 'requirements.lock', size: Buffer.byteLength(lock), sha256: createHash('sha256').update(lock).digest('hex') },
    wheels,
  }));
  return { packDir, wheelhouse, wheels };
}

function localFixture(context, options = {}) {
  const { env: envOverrides = {}, ...setupOptions } = options;
  const { directory } = fixture(context);
  const commands = [];
  const provisioned = [];
  const children = [];
  const env = { SUPERVISOR_CACHE_DIR: directory, LOCAL_STT_PROVIDER: 'moonshine', ...envOverrides };
  const paths = stackPaths(env);
  const setup = createLocalSetup({
    env,
    provision: async (paths, asset) => {
      provisioned.push(asset.id);
      if (asset.id !== 'uv') paths[asset.id] = asset.id.startsWith('whisper') ? path.join(directory, 'whisper-small', asset.name) : path.join(directory, asset.id);
      mkdirSync(path.dirname(paths[asset.id]), { recursive: true });
      writeFileSync(paths[asset.id], 'fixture');
    },
    run: async (executable, args, options) => {
      commands.push({ executable, args, options });
      if (args.includes('venv')) {
        mkdirSync(path.dirname(paths.python), { recursive: true });
        writeFileSync(paths.python, 'fixture Python');
      }
    },
    activateLLM: async () => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, killed: false, kill() { this.killed = true; } });
      children.push(child);
      return { llama: child };
    },
    warm: async () => true,
    offlinePackDir: path.join(directory, 'missing-kokoro-offline-pack'),
    compressedPackDir: null,
    ...setupOptions,
  });
  context.after(() => setup.close());
  return { setup, paths, commands, provisioned, children, env };
}

test('voice pack download resumes, rejects corrupt sources, and reuses verified archives offline', async context => {
  const { directory } = fixture(context);
  const content = Buffer.from('verified voice pack bytes');
  const destination = path.join(directory, 'pack.tar.xz');
  const descriptor = { size: content.length, sha256: createHash('sha256').update(content).digest('hex'), urls: ['https://github.com/pack'] };
  writeFileSync(`${destination}.partial`, content.subarray(0, 5));
  await downloadVoicePack(descriptor, destination, { fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Range, 'bytes=5-');
    return new Response(content.subarray(5), { status: 206, headers: { 'content-range': `bytes 5-${content.length - 1}/${content.length}` } });
  } });
  assert.deepEqual(readFileSync(destination), content);
  await downloadVoicePack(descriptor, destination, { fetchImpl: () => { throw new Error('No network expected'); } });
  rmSync(destination);
  let attempts = 0;
  await downloadVoicePack(descriptor, destination, { urls: ['https://mirror.test/pack', 'https://github.com/pack'], fetchImpl: async () => {
    attempts += 1;
    return new Response(attempts === 1 ? Buffer.alloc(content.length) : content);
  } });
  assert.equal(attempts, 2);
  assert.deepEqual(readFileSync(destination), content);
});

test('voice pack download rejects untrusted redirects, bad ranges, and cancellation', async context => {
  const { directory } = fixture(context);
  const descriptor = { size: 10, sha256: 'a'.repeat(64), urls: ['https://github.com/pack'] };
  const destination = path.join(directory, 'pack.tar.xz');
  let calls = 0;
  await assert.rejects(downloadVoicePack(descriptor, destination, { fetchImpl: async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: 'http://evil.test/pack' } });
  } }), /pinned voice dependency pack/);
  assert.equal(calls, 1);
  writeFileSync(`${destination}.partial`, 'abc');
  await assert.rejects(downloadVoicePack(descriptor, destination, { fetchImpl: async () => new Response('def', { status: 206, headers: { 'content-range': 'bytes 0-2/10' } }) }), /pinned voice dependency pack/);
  assert.equal(readFileSync(`${destination}.partial`, 'utf8'), 'abc');
  await assert.rejects(downloadVoicePack(descriptor, destination, { signal: AbortSignal.abort(), fetchImpl: () => { throw new Error('Unexpected download'); } }), { name: 'AbortError' });
});

test('compressed voice pack uses pinned manifest, local file and verified extracted cache', async context => {
  const { directory, paths } = fixture(context);
  const { packDir } = offlinePackFixture(directory, [
    ['faster-whisper', '1.2.1', 'faster_whisper-1.2.1-py3-none-any.whl'],
    ['ctranslate2', '4.6.0', 'ctranslate2-4.6.0-cp312-cp312-win_amd64.whl'],
    ['onnxruntime', '1.23.2', 'onnxruntime-1.23.2-cp312-cp312-win_amd64.whl'],
    ['setuptools', '80.9.0', 'setuptools-80.9.0-py3-none-any.whl'],
  ]);
  const sourceDir = path.join(directory, 'compressed');
  mkdirSync(sourceDir);
  const content = Buffer.from('synthetic compressed pack');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const descriptor = { format: 'wheelhouse-tar-xz-v1', filename: `voice-dependencies-${sha256.slice(0, 16)}.tar.xz`, sha256, size: content.length, expandedSize: 1024 * 1024, manifestSha256: createHash('sha256').update(readFileSync(path.join(packDir, 'manifest.json'))).digest('hex'), urls: ['https://github.com/pack'] };
  writeFileSync(path.join(sourceDir, 'descriptor.json'), JSON.stringify(descriptor));
  const localFile = path.join(directory, descriptor.filename);
  writeFileSync(localFile, content);
  const { cpSync } = await import('node:fs');
  let extractions = 0;
  const options = { sourceDir, paths, env: { LOCAL_VOICE_PACK_FILE: localFile }, fetchImpl: () => { throw new Error('No network expected'); }, run: async (_executable, args) => {
    extractions += 1;
    assert.equal(args[2], 'extract');
    assert.equal(args[3], localFile);
    cpSync(packDir, args[4], { recursive: true });
  } };
  assert.ok(await resolveVoicePack(options));
  rmSync(localFile);
  assert.ok(await resolveVoicePack(options));
  assert.equal(extractions, 1);
  descriptor.manifestSha256 = 'a'.repeat(64);
  writeFileSync(path.join(sourceDir, 'descriptor.json'), JSON.stringify(descriptor));
  writeFileSync(localFile, content);
  await assert.rejects(resolveVoicePack(options), /failed verification/);
});

const windowsSetup = { skip: process.platform !== 'win32' || process.arch !== 'x64' };

test('compressed bundled setup retains the hash-locked install and removes only successful expanded staging', windowsSetup, async context => {
  const { directory } = fixture(context);
  const { packDir } = offlinePackFixture(directory, [
    ['faster-whisper', '1.2.1', 'faster_whisper-1.2.1-py3-none-any.whl'],
    ['ctranslate2', '4.6.0', 'ctranslate2-4.6.0-cp312-cp312-win_amd64.whl'],
    ['onnxruntime', '1.23.2', 'onnxruntime-1.23.2-cp312-cp312-win_amd64.whl'],
    ['setuptools', '80.9.0', 'setuptools-80.9.0-py3-none-any.whl'],
  ]);
  const compressedPackDir = path.join(directory, 'compressed');
  mkdirSync(compressedPackDir);
  const content = Buffer.from('bundled archive fixture');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const filename = `voice-dependencies-${sha256.slice(0, 16)}.tar.xz`;
  writeFileSync(path.join(compressedPackDir, filename), content);
  writeFileSync(path.join(compressedPackDir, 'descriptor.json'), JSON.stringify({ format: 'wheelhouse-tar-xz-v1', filename, sha256, size: content.length, expandedSize: 1024 * 1024, manifestSha256: createHash('sha256').update(readFileSync(path.join(packDir, 'manifest.json'))).digest('hex'), urls: ['https://github.com/pack'] }));
  const { cpSync } = await import('node:fs');
  let expanded;
  const { setup, paths, commands } = localFixture(context, {
    env: { LOCAL_STT_PROVIDER: 'whisper' }, compressedPackDir,
    run: async (executable, args, options) => {
      commands.push({ executable, args, options });
      if (args.includes('venv')) {
        mkdirSync(path.dirname(paths.python), { recursive: true });
        writeFileSync(paths.python, 'isolated Python fixture');
      }
      if (args[2] === 'extract') cpSync(packDir, args[4], { recursive: true });
      if (args.includes('--find-links')) {
        expanded = path.dirname(args[args.indexOf('--find-links') + 1]);
        assert.ok(existsSync(path.join(expanded, 'manifest.json')));
      }
    },
  });
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  const installs = commands.filter(command => command.args.includes('pip') && command.args.includes('install'));
  assert.equal(installs.length, 1);
  assert.ok(installs[0].args.includes('--offline') && installs[0].args.includes('--require-hashes') && installs[0].args.includes('--no-index'));
  assert.ok(expanded);
  assert.equal(existsSync(expanded), false);
  assert.equal(existsSync(path.join(compressedPackDir, filename)), true);
  assert.equal(existsSync(path.join(paths.venv, 'complete.json')), true);
  assert.equal(existsSync(path.join(paths.venv, 'whisper-complete.json')), true);
});

test('Whisper setup installs only selected models and verifies INT8 dependencies', windowsSetup, async context => {
  const { setup, provisioned, commands, env } = localFixture(context, { env: { LOCAL_STT_PROVIDER: '' } });
  setup.start({ consent: true });
  const snapshot = await setup.settled();
  assert.equal(snapshot.status, 'ready', snapshot.message);
  assert.ok(provisioned.includes('whisperModel'));
  assert.equal(provisioned.includes('moonshine'), false);
  assert.equal(provisioned.includes('crispasr'), false);
  assert.ok(commands.some(command => command.args.includes(fileURLToPath(new URL('../requirements-whisper.txt', import.meta.url)))));
  assert.ok(commands.some(command => command.args.some(arg => arg.includes('get_supported_compute_types'))));
  assert.equal(env.WHISPER_READY, '1');
  assert.equal(snapshot.components.find(component => component.id === 'whisper').ready, true);
});

test('recognizer changes preserve chat and require consent before optional model downloads', windowsSetup, async context => {
  const { setup, provisioned, children, env } = localFixture(context, { env: { LOCAL_STT_PROVIDER: 'whisper' } });
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  const count = provisioned.length;
  env.LOCAL_STT_PROVIDER = 'moonshine';
  await setup.recognitionChanged();
  const snapshot = setup.snapshot();
  assert.equal(provisioned.length, count);
  assert.equal(snapshot.capabilities.chat.ready, true);
  assert.equal(snapshot.capabilities.voice.ready, false);
  assert.ok(snapshot.components.some(component => component.id === 'moonshine'));
  assert.equal(snapshot.components.some(component => component.id === 'whisperModel'), false);
  assert.equal(children[0].killed, false);
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  assert.ok(provisioned.includes('moonshine'));
  assert.equal(children.length, 1);
});

test('local setup uses the private pip recipe with only pinned docopt allowed from source', windowsSetup, async context => {
  const { setup, paths, commands } = localFixture(context);
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  const installs = commands.filter(command => command.args[1] === 'pip' && command.args[2] === 'install');
  assert.equal(installs.length, 2);
  assert.deepEqual(installs[0].args, ['--no-config', 'pip', 'install', '--python', paths.python, '--index-url', 'https://download.pytorch.org/whl/cpu', 'torch==2.8.0']);
  assert.deepEqual(installs[1].args, ['--no-config', 'pip', 'install', '--python', paths.python, '--index-url', 'https://pypi.org/simple', '--only-binary', ':all:', '--no-binary', 'docopt', 'docopt==0.6.2', '-r', fileURLToPath(new URL('../requirements-local.txt', import.meta.url)), 'https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl']);
  for (const command of installs) {
    assert.equal(command.executable, paths.uv);
    assert.equal(command.options.cwd, paths.home);
    assert.equal(command.options.env.PYTHONNOUSERSITE, '1');
  }
});

test('local setup installs a verified bundled pack without contacting package indexes', windowsSetup, async context => {
  const { directory } = fixture(context);
  const { packDir, wheelhouse } = offlinePackFixture(directory);

  const { setup, paths, commands } = localFixture(context, { offlinePackDir: packDir });
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  const installs = commands.filter(command => command.args.includes('pip') && command.args.includes('install'));
  assert.equal(installs.length, 1);
  assert.deepEqual(installs[0].args, ['--no-config', '--offline', 'pip', 'install', '--python', paths.python, '--no-index', '--find-links', wheelhouse, '--only-binary', ':all:', '--require-hashes', '-r', path.join(packDir, 'requirements.lock')]);
  assert.equal(installs[0].options.message, 'Installing verified bundled Kokoro dependencies without network access.');
});

test('Whisper setup uses the verified bundle with approved Python and no package network access', windowsSetup, async context => {
  const { directory } = fixture(context);
  const pythonBase = path.join(directory, 'approved-python.exe');
  writeFileSync(pythonBase, 'approved interpreter fixture');
  const whisperWheels = [
    ['faster-whisper', '1.2.1', 'faster_whisper-1.2.1-py3-none-any.whl'],
    ['ctranslate2', '4.6.0', 'ctranslate2-4.6.0-cp312-cp312-win_amd64.whl'],
    ['onnxruntime', '1.23.2', 'onnxruntime-1.23.2-cp312-cp312-win_amd64.whl'],
    ['setuptools', '80.9.0', 'setuptools-80.9.0-py3-none-any.whl'],
  ];
  const { packDir, wheelhouse } = offlinePackFixture(directory, whisperWheels);
  const { setup, paths, commands } = localFixture(context, {
    env: { LOCAL_STT_PROVIDER: 'whisper', PYTHON_BIN: pythonBase },
    offlinePackDir: packDir,
  });

  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  const installs = commands.filter(command => command.args.includes('install'));
  assert.equal(installs.length, 1);
  const bundledInstall = installs[0];
  assert.equal(bundledInstall.executable.endsWith(path.join('Scripts', 'python.exe')), true);
  assert.ok(bundledInstall.args.includes('--no-index'));
  assert.ok(bundledInstall.args.includes('--require-hashes'));
  assert.equal(bundledInstall.args[bundledInstall.args.indexOf('--find-links') + 1], wheelhouse);
  assert.equal(bundledInstall.args.includes('--index-url'), false);
  assert.equal(bundledInstall.options.message, 'Installing verified bundled local voice dependencies without network access.');
  assert.ok(commands.some(command => command.options.stage === 'whisper' && command.args.some(arg => arg.includes('get_supported_compute_types'))));
  assert.equal(existsSync(path.join(paths.venv, 'whisper-complete.json')), true);
});

test('local setup rejects a modified bundled pack and preserves the online fallback', windowsSetup, async context => {
  const { directory } = fixture(context);
  const { packDir, wheelhouse, wheels } = offlinePackFixture(directory);
  writeFileSync(path.join(wheelhouse, wheels[0].filename), 'modified wheel');
  const { setup, commands } = localFixture(context, { offlinePackDir: packDir });
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  const installs = commands.filter(command => command.args.includes('pip') && command.args.includes('install'));
  assert.equal(installs.length, 2);
  assert.ok(installs[0].args.includes('--index-url'));
  assert.equal(installs.some(command => command.args.includes('--find-links')), false);
});

test('managed Python retries package installation from the uv cache without network access', windowsSetup, async context => {
  let failedOnlineInstall = false;
  const { setup, paths, commands } = localFixture(context, {
    run: async (executable, args, options) => {
      commands.push({ executable, args, options });
      if (args.includes('venv')) {
        mkdirSync(path.dirname(paths.python), { recursive: true });
        writeFileSync(paths.python, 'fixture Python');
      }
      if (!failedOnlineInstall && args.includes('pip') && args.includes('install') && !args.includes('--offline')) {
        failedOnlineInstall = true;
        throw new Error('TLS handshake failed');
      }
    },
  });
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  const installs = commands.filter(command => command.args.includes('pip') && command.args.includes('install'));
  assert.equal(installs.length, 3);
  assert.deepEqual(installs[1].args.slice(0, 4), ['--no-config', '--offline', 'pip', 'install']);
  assert.equal(installs[1].options.message, 'Installing CPU speech dependencies. Retrying from the verified local package cache without network access.');
});

test('managed Python replaces a stale virtual environment from a previous pinned version', windowsSetup, async context => {
  let staleProbe = true;
  const attempted = [];
  const { setup, paths } = localFixture(context, {
    run: async (executable, args) => {
      attempted.push({ executable, args });
      if (executable === paths.python && args.includes('-c') && args.at(-1).includes('Pinned Python 3.12.11 required') && staleProbe) {
        staleProbe = false;
        throw new Error('Pinned Python 3.12.11 required');
      }
      if (args.includes('venv')) {
        mkdirSync(path.dirname(paths.python), { recursive: true });
        writeFileSync(paths.python, 'replacement Python');
      }
    },
  });
  mkdirSync(path.dirname(paths.python), { recursive: true });
  writeFileSync(paths.python, 'stale Python 3.12.10');
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  const replacement = attempted.find(command => command.executable === paths.uv && command.args.includes('venv'));
  assert.ok(replacement);
  assert.ok(replacement.args.includes('--clear'));
  assert.ok(attempted.filter(command => command.executable === paths.python && command.args.includes('-c')).length >= 2);
});

test('configured Python uses bundled venv and pip without downloading or invoking uv', windowsSetup, async context => {
  const { directory } = fixture(context);
  const pythonBase = path.join(directory, 'approved Python', 'python.exe');
  mkdirSync(path.dirname(pythonBase), { recursive: true });
  writeFileSync(pythonBase, 'approved interpreter fixture');
  const { setup, paths, commands, provisioned, children } = localFixture(context, { env: { PYTHON_BIN: pythonBase } });
  assert.equal(setup.snapshot().components.some(component => component.id === 'uv'), false);
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  assert.equal(provisioned.includes('uv'), false);
  assert.equal(commands.some(command => command.executable === paths.uv), false);
  assert.equal(commands[0].executable, pythonBase);
  assert.equal(commands[0].args.at(-1), approvedPythonProbe);
  for (const requirement of ['cpython', 'platform.machine', 'ensurepip', 'ssl', 'venv']) assert.match(approvedPythonProbe, new RegExp(requirement));
  assert.deepEqual(commands[1].args, ['-I', '-m', 'venv', paths.venv]);
  assert.equal(commands[1].executable, pythonBase);
  assert.equal(commands[2].executable, paths.python);
  assert.match(commands[2].args.at(-1), /sys\.prefix != sys\.base_prefix.*pip\.\__version__/);
  assert.notEqual(paths.venv, path.join(paths.runtimeDir, 'kokoro-venv'));
  const installs = commands.filter(command => command.args.includes('pip'));
  assert.equal(installs.length, 2);
  for (const command of installs) {
    assert.equal(command.executable, paths.python);
    assert.deepEqual(command.args.slice(0, 3), ['-I', '-m', 'pip']);
    for (const flag of ['--isolated', '--no-input', '--use-feature=truststore']) assert.ok(command.args.includes(flag));
    assert.equal(command.options.env.PIP_CONFIG_FILE, 'NUL');
  }
  assert.ok(installs[0].args.includes('torch==2.8.0'));
  assert.deepEqual(installs[1].args.slice(installs[1].args.indexOf('--only-binary'), -3), ['--only-binary', ':all:', '--no-binary', 'docopt', 'docopt==0.6.2']);
  assert.equal(readFileSync(pythonBase, 'utf8'), 'approved interpreter fixture');
  const receipt = JSON.parse(readFileSync(path.join(paths.venv, 'complete.json'), 'utf8'));
  assert.equal(receipt.base.path, pythonBase);
  const installedCommands = commands.length;
  children[0].exitCode = 1;
  children[0].emit('exit', 1, null);
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  assert.equal(commands.length, installedCommands, 'receipt avoids reinstall after PYTHON_BIN becomes the runtime path');
  writeFileSync(pythonBase, 'updated approved interpreter fixture');
  assert.equal(setup.snapshot().components.find(component => component.id === 'kokoro').ready, false);
});

test('missing or unusable configured Python never falls back and leaves local chat usable', windowsSetup, async context => {
  for (const failure of ['missing', 'policy blocked', 'wrong version', 'missing venv']) {
    await context.test(failure, async context => {
      const { directory } = fixture(context);
      const pythonBase = path.join(directory, 'python.exe');
      if (failure !== 'missing') writeFileSync(pythonBase, 'approved interpreter fixture');
      const attempted = [];
      const { setup, paths, provisioned, children } = localFixture(context, {
        env: { PYTHON_BIN: pythonBase },
        run: async (executable, args) => {
          attempted.push({ executable, args });
          if (failure !== 'missing venv' || args.includes('venv')) throw new Error(failure);
        },
      });
      setup.start({ consent: true });
      const failed = await setup.settled();
      assert.equal(failed.status, 'error');
      assert.equal(failed.capabilities.chat.ready, true);
      assert.equal(failed.capabilities.voice.ready, false);
      assert.equal(children[0].killed, false);
      assert.equal(provisioned.includes('uv'), false);
      assert.ok(attempted.every(command => command.executable === pythonBase));
      assert.equal(existsSync(path.join(paths.venv, 'complete.json')), false);
      if (failure === 'missing') {
        assert.equal(attempted.length, 0);
        assert.match(failed.error, /PYTHON_BIN.*not found.*No downloaded Python or uv fallback/);
      }
    });
  }
});

test('configured Python repairs an incomplete venv on retry without touching a downloaded runtime', windowsSetup, async context => {
  const { directory } = fixture(context);
  const pythonBase = path.join(directory, 'python.exe');
  writeFileSync(pythonBase, 'approved interpreter fixture');
  const attempted = [];
  let creations = 0;
  const { setup, paths, provisioned, children } = localFixture(context, {
    env: { PYTHON_BIN: pythonBase },
    run: async (executable, args) => {
      attempted.push(executable);
      if (args.includes('venv')) {
        mkdirSync(path.dirname(paths.python), { recursive: true });
        writeFileSync(paths.python, 'fixture Python');
        if (++creations === 1) throw new Error('ensurepip interrupted');
      }
    },
  });
  const downloadedPython = path.join(paths.runtimeDir, 'kokoro-venv', 'Scripts', 'python.exe');
  mkdirSync(path.dirname(downloadedPython), { recursive: true });
  writeFileSync(downloadedPython, 'downloaded interpreter fixture');
  setup.start({ consent: true });
  assert.equal((await setup.settled()).capabilities.chat.ready, true);
  assert.equal(existsSync(path.join(paths.venv, 'complete.json')), false);
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  assert.equal(creations, 2);
  assert.equal(children.length, 1);
  assert.equal(provisioned.includes('uv'), false);
  assert.ok(attempted.every(executable => [pythonBase, paths.python].includes(executable)));
  assert.equal(readFileSync(downloadedPython, 'utf8'), 'downloaded interpreter fixture');
});

test('llama exit during speech warmup fails readiness and permits a cached retry', windowsSetup, async context => {
  let release;
  let entered;
  let warmups = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const warming = new Promise(resolve => { entered = resolve; });
  const { setup, commands, children } = localFixture(context, { warm: async () => {
    if (++warmups === 1) { entered(); await gate; }
    return true;
  } });
  setup.start({ consent: true });
  try {
    await warming;
    children[0].exitCode = 1;
    children[0].emit('exit', 1, null);
    assert.equal(setup.snapshot().status, 'error', 'runtime is monitored while warmup is pending');
  } finally { release(); }
  const failed = await setup.settled();
  assert.equal(failed.status, 'error');
  assert.match(failed.message, /llama\.cpp/);
  const installedCommands = commands.length;
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  assert.equal(children.length, 2);
  assert.equal(warmups, 2);
  assert.equal(commands.length, installedCommands, 'verified Python environment is not reinstalled');
  children[1].signalCode = 'SIGTERM';
  children[1].emit('exit', null, 'SIGTERM');
  assert.equal(setup.snapshot().status, 'error', 'ready is invalidated when the runtime dies');
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  assert.equal(children.length, 3);
});

test('llama exitCode and signalCode are checked even without an observed exit event', windowsSetup, async context => {
  for (const phase of ['before warmup', 'after warmup']) {
    for (const status of [{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: 'SIGTERM' }]) {
      await context.test(`${phase}: ${JSON.stringify(status)}`, async context => {
        let warmups = 0;
        const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() {} });
        if (phase === 'before warmup') Object.assign(child, status);
        const { setup } = localFixture(context, {
          activateLLM: async () => ({ llama: child }),
          warm: async () => { warmups += 1; Object.assign(child, status); return true; },
        });
        setup.start({ consent: true });
        const failed = await setup.settled();
        assert.equal(failed.status, 'error');
        assert.match(failed.message, /llama\.cpp/);
        assert.equal(warmups, phase === 'before warmup' ? 0 : 1);
      });
    }
  }
});

test('a speech warmup failure keeps the validated chat runtime alive and retry reuses it', windowsSetup, async context => {
  let warmups = 0;
  const { setup, children } = localFixture(context, { warm: async () => {
    if (++warmups === 1) throw new Error('Kokoro fixture failure');
    return true;
  } });
  setup.start({ consent: true });
  const failed = await setup.settled();
  assert.equal(failed.status, 'error');
  assert.equal(children[0].killed, false, 'validated owned llama runtime is kept alive');
  assert.equal(failed.capabilities.chat.ready, true, 'chat capability remains ready');
  assert.equal(failed.capabilities.voice.ready, false, 'voice capability is not ready');
  assert.ok(typeof failed.capabilities.chat.message === 'string' && failed.capabilities.chat.message.length > 0);
  assert.ok(typeof failed.capabilities.voice.message === 'string' && failed.capabilities.voice.message.length > 0);

  // Retry reuses downloaded and validated chat runtime without creating a new child:
  setup.start({ consent: true });
  const ready = await setup.settled();
  assert.equal(ready.status, 'ready');
  assert.equal(children.length, 1, 'reused the existing validated llama runtime');
  assert.equal(ready.capabilities.chat.ready, true);
  assert.equal(ready.capabilities.voice.ready, true);

  // If the active runtime later exits, ready is invalidated:
  children[0].signalCode = 'SIGTERM';
  children[0].emit('exit', null, 'SIGTERM');
  const stopped = setup.snapshot();
  assert.equal(stopped.status, 'error');
  assert.equal(stopped.capabilities.chat.ready, false);
  assert.equal(stopped.capabilities.voice.ready, false);
});

test('a replacement runtime is started after exit and late exit from dead runtime cannot invalidate it', windowsSetup, async context => {
  let warmups = 0;
  const { setup, children } = localFixture(context, { warm: async () => {
    if (++warmups === 1) throw new Error('Kokoro fixture failure');
    return true;
  } });
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'error');
  // Explicitly simulate dead first child:
  children[0].exitCode = 1;
  children[0].emit('exit', 1, null);
  assert.equal(setup.snapshot().capabilities.chat.ready, false);

  // Retry starts replacement child:
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  assert.equal(children.length, 2);
  // Late exit emitted on old dead child cannot invalidate active replacement runtime:
  children[0].emit('exit', null, 'SIGTERM');
  assert.equal(setup.snapshot().status, 'ready');
});

test('Kokoro install failure keeps validated chat runtime alive with chat ready and voice unready', windowsSetup, async context => {
  let attempts = 0;
  const { setup, paths, children } = localFixture(context, {
    run: async (executable, args, options) => {
      if (args.includes('venv')) {
        mkdirSync(path.dirname(paths.python), { recursive: true });
        writeFileSync(paths.python, 'fixture Python');
      }
      if (args.includes('pip') && args.includes('install') && ++attempts <= 2) {
        throw new Error('pip installation failed: network error');
      }
    },
  });
  setup.start({ consent: true });
  const failed = await setup.settled();
  assert.equal(failed.status, 'error');
  assert.equal(children.length, 1, 'chat was activated before Kokoro install');
  assert.equal(children[0].killed, false, 'owned llama runtime kept alive');
  assert.equal(failed.capabilities.chat.ready, true, 'chat is ready');
  assert.equal(failed.capabilities.voice.ready, false, 'voice is not ready');
  assert.match(failed.capabilities.voice.message, /pip installation failed/);
  assert.match(failed.capabilities.voice.message, /offline package-cache fallback was attempted/);

  // Retry reuses validated chat runtime:
  setup.start({ consent: true });
  const ready = await setup.settled();
  assert.equal(ready.status, 'ready');
  assert.equal(children.length, 1, 'reused chat runtime on retry');
  assert.equal(ready.capabilities.chat.ready, true);
  assert.equal(ready.capabilities.voice.ready, true);
});

test('LOCAL_LLM_URL is only published after healthy startup and cleaned up on failure', windowsSetup, async context => {
  const { directory } = fixture(context);
  const env = { SUPERVISOR_CACHE_DIR: directory };

  // When startup fails, no stale URL is left:
  const failingSetup = createLocalSetup({
    env,
    provision: async () => {},
    activateLLM: async () => { throw new Error('startup failed'); },
  });
  failingSetup.start({ consent: true });
  const failed = await failingSetup.settled();
  assert.equal(failed.status, 'error');
  assert.equal(env.LOCAL_LLM_URL, undefined, 'no stale URL left after failed startup');

  // When external URL was pre-configured, it is preserved:
  env.LOCAL_LLM_URL = 'http://127.0.0.1:9999/v1';
  const externalSetup = createLocalSetup({
    env,
    provision: async () => {},
    activateLLM: async () => { throw new Error('startup failed'); },
  });
  externalSetup.start({ consent: true });
  await externalSetup.settled();
  assert.equal(env.LOCAL_LLM_URL, 'http://127.0.0.1:9999/v1', 'pre-existing external URL is preserved');
  delete env.LOCAL_LLM_URL;

  // When startup succeeds, URL is published:
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() {} });
  const succeedingSetup = createLocalSetup({
    env,
    provision: async () => {},
    run: async () => {},
    activateLLM: async () => ({ llama: child, url: 'http://127.0.0.1:4567/v1' }),
    warm: async () => true,
  });
  succeedingSetup.start({ consent: true });
  await succeedingSetup.settled();
  assert.equal(env.LOCAL_LLM_URL, 'http://127.0.0.1:4567/v1', 'URL is published after healthy startup');

  // When owned child exits, URL is removed:
  child.signalCode = 'SIGTERM';
  child.emit('exit', null, 'SIGTERM');
  assert.equal(env.LOCAL_LLM_URL, undefined, 'URL cleaned up when owned runtime dies');
});

test('setup command failures retain bounded sanitized stream tails only in the local log', async context => {
  const { directory } = fixture(context);
  const secret = 'fixture-env-secret-7391';
  const script = `
    process.stdout.write('old stdout\\n' + 'stdout progress\\n'.repeat(10000));
    process.stderr.write('old stderr\\n' + 'stderr progress\\n'.repeat(10000));
    process.stdout.write('OPENAI_API_KEY=' + 'fixture-oversized'.repeat(1000) + '\\n');
    process.stdout.write('stdout diagnostic: dependency resolution failed\\n');
    process.stdout.write('https://fixture-user:fixture-pass@example.test/packages?sig=fixture-query#fixture-fragment\\n');
    process.stdout.write('bare value: fixture-env-');
    setImmediate(() => {
      process.stdout.write('secret-7391\\n');
      process.stderr.write('OPENAI_API_KEY="fixture-assignment"\\nAuthorization: Bearer fixture-auth\\n');
      process.stderr.write('stderr diagnostic: docopt build failed\\n');
      process.exitCode = 7;
    });
  `;
  const setup = controller({ install: ({ report, signal }) => runSetupCommand(process.execPath, ['-e', script], {
    env: isolatedEnvironment(process.env, stackPaths({ SUPERVISOR_CACHE_DIR: directory })),
    redactEnv: { HF_TOKEN: secret }, cwd: directory, report, signal, stage: 'kokoro', message: 'Installing speech dependencies.',
  }) });
  setup.start({ consent: true });
  const failed = await setup.settled();
  assert.equal(failed.status, 'error');
  assert.match(failed.message, /code 7/);
  assert.match(failed.message, /logs\/local-setup\.log/);
  assert.doesNotMatch(JSON.stringify(failed), /stdout diagnostic|stderr diagnostic|fixture-|docopt build failed/);
  const logFile = path.join(directory, 'logs', 'local-setup.log');
  const output = readFileSync(logFile, 'utf8');
  assert.ok(Buffer.byteLength(output) <= 64 * 1024);
  assert.match(output, /stdout diagnostic: dependency resolution failed/);
  assert.match(output, /stderr diagnostic: docopt build failed/);
  assert.match(output, /https:\/\/example\.test\/packages/);
  assert.match(output, /\[REDACTED/);
  assert.doesNotMatch(output, /old stdout|old stderr|fixture-(?:user|pass|query|fragment|env|assignment|auth|oversized)/);
  await runSetupCommand(process.execPath, ['-e', 'process.stdout.write("retry completed\\n")'], { cwd: directory, stage: 'kokoro', message: 'Retrying speech dependencies.' });
  const retried = readFileSync(logFile, 'utf8');
  assert.match(retried, /retry completed/);
  assert.doesNotMatch(retried, /docopt build failed/);
});

test('setup launch failures and unwritable logs remain actionable without leaking subprocess details', async context => {
  const { directory } = fixture(context);
  const options = { cwd: directory, stage: 'python', message: 'Checking Python.' };
  await assert.rejects(runSetupCommand(path.join(directory, 'missing-runtime'), [], options), /Could not run.*logs\/local-setup\.log/);
  const logFile = path.join(directory, 'logs', 'local-setup.log');
  assert.match(readFileSync(logFile, 'utf8'), /Could not run/);
  rmSync(logFile);
  mkdirSync(logFile);
  await assert.rejects(runSetupCommand(process.execPath, ['-e', 'process.stderr.write("raw-private-output"); process.exitCode = 2;'], options), error => {
    assert.match(error.setupMessage, /code 2/);
    assert.match(error.setupMessage, /log could not be written/);
    assert.doesNotMatch(error.setupMessage, /raw-private-output/);
    return true;
  });
});

test('setup reports policy and TLS failures without implying a bypass or exposing raw diagnostics', async context => {
  const { directory } = fixture(context);
  for (const diagnostic of ['This program is blocked by group policy', 'CERTIFICATE_VERIFY_FAILED']) {
    await assert.rejects(runSetupCommand(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(diagnostic)}); process.exitCode = 1;`], {
      cwd: directory, stage: 'python', message: 'Preparing Kokoro.',
    }), error => {
      assert.match(error.setupMessage, /logs\/local-setup\.log/);
      assert.doesNotMatch(error.setupMessage, new RegExp(diagnostic));
      assert.match(error.setupMessage, diagnostic.includes('policy') ? /stop retrying.*IT-approved.*Do not bypass Defender, AppLocker or WDAC/ : /trusted certificates.*approved package mirrors.*Do not disable TLS/);
      return true;
    });
    const output = readFileSync(path.join(directory, 'logs', 'local-setup.log'), 'utf8');
    assert.match(output, /Executable:/);
    assert.ok(output.includes(diagnostic));
  }
});

test('setup requires exact consent and serializes asynchronous starts', async () => {
  let installs = 0;
  let activations = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const setup = controller({ install: async () => { installs += 1; await gate; }, activate: async () => { activations += 1; } });
  assert.equal(setup.snapshot().status, 'idle');
  assert.equal(setup.snapshot().capabilities.chat.ready, false);
  assert.equal(setup.snapshot().capabilities.voice.ready, false);
  for (const input of [undefined, null, {}, { consent: false }, { consent: 'true' }, { consent: true, url: 'https://evil.test' }, { consent: true, command: 'anything' }, { consent: true, path: 'C:\\' }]) assert.throws(() => setup.start(input), /consent/);
  assert.equal(installs, 0);
  assert.equal(setup.start({ consent: true }).status, 'running');
  assert.equal(setup.start({ consent: true }).status, 'running');
  assert.equal(installs, 0, 'POST returns before installer starts');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(installs, 1);
  release();
  const settled = await setup.settled();
  assert.equal(settled.status, 'ready');
  assert.equal(settled.capabilities.chat.ready, true);
  assert.equal(settled.capabilities.voice.ready, true);
  assert.equal(activations, 1);
  setup.start({ consent: true });
  assert.equal(installs, 1);
});

test('failed setup redacts raw errors and permits a real retry; offline resume never installs', async () => {
  let attempts = 0;
  const setup = controller({ install: async () => { if (++attempts === 1) throw new Error('secret-token and arbitrary subprocess output'); } });
  setup.start({ consent: true });
  const failure = await setup.settled();
  assert.equal(failure.status, 'error');
  assert.doesNotMatch(JSON.stringify(failure), /secret-token/);
  setup.start({ consent: true });
  assert.equal((await setup.settled()).status, 'ready');
  assert.equal(attempts, 2);
  const offline = controller({ install: async () => assert.fail('resume must not install') });
  offline.resume();
  assert.equal((await offline.settled()).status, 'ready');
  const unsupported = controller({ platform: 'linux' });
  assert.equal(unsupported.snapshot().supported, false);
  assert.throws(() => unsupported.start({ consent: true }), /Windows x64/);
});

test('setup snapshot includes hardware advisory with deterministic overrides and preserves non-blocking consent', async () => {
  const lowSpec = controller({
    inspectHardware: () => ({ logicalCpus: 2, memoryGiB: 8 }),
  });
  const lowSnapshot = lowSpec.snapshot();
  assert.equal(lowSnapshot.hardware.logicalCpus, 2);
  assert.equal(lowSnapshot.hardware.memoryGiB, 8);
  assert.match(lowSnapshot.hardware.warning, /16 GB|4.*CPU/i);
  lowSpec.start({ consent: true });
  assert.equal((await lowSpec.settled()).status, 'ready');

  const goodSpec = controller({
    inspectHardware: () => ({ logicalCpus: 8, memoryGiB: 32 }),
  });
  const goodSnapshot = goodSpec.snapshot();
  assert.equal(goodSnapshot.hardware.logicalCpus, 8);
  assert.equal(goodSnapshot.hardware.memoryGiB, 32);
  assert.equal(goodSnapshot.hardware.warning, null);

  const unsupportedLow = controller({
    platform: 'linux',
    inspectHardware: () => ({ logicalCpus: 1, memoryGiB: 2 }),
  });
  const unsupportedSnapshot = unsupportedLow.snapshot();
  assert.equal(unsupportedSnapshot.supported, false);
  assert.match(unsupportedSnapshot.hardware.warning, /Windows x64/i);
});

test('completed verified assets are reused offline; partial and corrupted downloads are never ready', async context => {
  const { paths } = fixture(context);
  const asset = ASSETS.find(candidate => candidate.id === 'tokenizer');
  const content = Buffer.from('local deterministic tokenizer fixture');
  const digest = createHash('sha256').update(content).digest('hex');
  const metadata = [{ path: asset.name, size: content.length, lfs: { oid: digest } }];
  let calls = 0;
  const fetchImpl = async url => { calls += 1; return url.includes('/api/models/') ? Response.json(metadata) : new Response(content); };
  mkdirSync(paths.modelDir, { recursive: true });
  writeFileSync(`${paths.tokenizer}.partial`, content);
  assert.equal(assetReady(paths, asset), false);
  const progress = [];
  await ensureAsset(paths, asset, { fetchImpl, report: event => progress.push(event) });
  assert.equal(calls, 2);
  assert.equal(assetReady(paths, asset), true);
  assert.ok(progress.some(event => event.progress?.received === content.length));
  await ensureAsset(paths, asset, { fetchImpl: async () => assert.fail('offline reuse must not perform even a HEAD request') });
  utimesSync(paths.tokenizer, new Date(0), new Date(0));
  assert.equal(assetReady(paths, asset), false);
  await ensureAsset(paths, asset, { fetchImpl: async () => assert.fail('a changed timestamp must be reverified offline using the recorded digest') });
  assert.equal(assetReady(paths, asset), true);
  writeFileSync(paths.tokenizer, 'truncated');
  assert.equal(assetReady(paths, asset), false);
  await assert.rejects(ensureAsset(paths, asset, { fetchImpl: async url => url.includes('/api/models/') ? Response.json(metadata) : new Response('bad') }), /integrity/);
  assert.equal(existsSync(`${paths.tokenizer}.partial`), false);
  assert.equal(assetReady(paths, asset), false);
  await ensureAsset(paths, asset, { fetchImpl });
  assert.equal(assetReady(paths, asset), true);
});

test('managed asset receipts reject junctions outside cache roots', context => {
  const { directory, paths } = fixture(context);
  const asset = ASSETS.find(candidate => candidate.id === 'tokenizer');
  const external = path.join(directory, 'external');
  const junction = path.join(paths.modelDir, 'redirected');
  mkdirSync(external, { recursive: true });
  mkdirSync(paths.modelDir, { recursive: true });
  symlinkSync(external, junction, process.platform === 'win32' ? 'junction' : 'dir');
  const destination = path.join(junction, asset.name);
  writeFileSync(destination, 'redirected asset');
  const stat = statSync(destination);
  const receipt = path.join(paths.receiptDir, `${asset.id}-${createHash('sha256').update(destination).digest('hex').slice(0, 20)}.json`);
  mkdirSync(paths.receiptDir, { recursive: true });
  writeFileSync(receipt, JSON.stringify({ sourceUrl: asset.sourceUrl, digest: '0'.repeat(64), files: [{ path: destination, size: stat.size, mtimeMs: stat.mtimeMs }] }));
  assert.equal(assetReady(paths, asset, destination), false);
});

function runtimeArchive(context, entries, asset = ASSETS.find(candidate => candidate.id === 'uv')) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;
  for (const { name, body = '', mode = 0o100644, directory = false, size, compressed } of entries) {
    const filename = Buffer.from(name);
    const content = Buffer.from(body);
    const data = compressed ?? deflateRawSync(content);
    let checksum = 0xffffffff;
    for (const byte of content) {
      checksum ^= byte;
      for (let bit = 0; bit < 8; bit += 1) checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE((checksum ^ 0xffffffff) >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size ?? content.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x314, 4);
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE(((mode << 16) | (directory ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    localRecords.push(local, filename, data);
    centralRecords.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralRecords.reduce((total, record) => total + record.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  const content = Buffer.concat([...localRecords, ...centralRecords, end]);
  const original = { size: asset.size, sha256: asset.sha256 };
  context.after(() => Object.assign(asset, original));
  Object.assign(asset, { size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  return { asset, content, fetchImpl: async url => { assert.equal(url, asset.sourceUrl); return new Response(content); } };
}

test('CrispASR CPU builds retain official integrity pins and require explicit AVX2 opt-in', context => {
  const { directory, paths } = fixture(context);
  const legacy = ASSETS.find(asset => asset.id === 'crispasr');
  assert.equal(legacy.size, 7713869);
  assert.equal(legacy.sha256, 'ba4e23fb8dfcc99b8a76af034954576a75f88193e3dbf62fc774287bcbd1114b');
  assert.equal(CRISPASR_AVX2_ASSET.size, 8261759);
  assert.equal(CRISPASR_AVX2_ASSET.sha256, 'ac8b6caf4dd448d00c5050907275bce4d154747110c37943aa4f69ee7fac9541');
  assert.equal(paths.crispasrCpu, 'legacy');
  assert.equal(paths.crispasr, path.join(paths.runtimeDir, 'crispasr', 'crispasr.exe'));
  const optimized = stackPaths({ LOCALAPPDATA: directory, CRISPASR_CPU: 'avx2' }, path.join(directory, 'app'));
  assert.equal(optimized.crispasr, path.join(paths.runtimeDir, 'crispasr-avx2', 'crispasr.exe'));
  assert.throws(() => stackPaths({ CRISPASR_CPU: 'auto' }), /CRISPASR_CPU must be/);
  const custom = path.join(directory, 'custom.exe');
  writeFileSync(custom, 'fixture');
  assert.equal(stackPaths({ LOCALAPPDATA: directory, CRISPASR_CPU: 'avx2', CRISPASR_BIN: custom }).crispasr, custom);
});

test('CrispASR AVX2 setup isolates binaries, checks integrity and reuses only matching receipts', async context => {
  const { directory, paths: legacyPaths } = fixture(context);
  const paths = stackPaths({ LOCALAPPDATA: directory, CRISPASR_CPU: 'avx2' }, path.join(directory, 'app'));
  const legacy = ASSETS.find(asset => asset.id === 'crispasr');
  mkdirSync(path.dirname(legacyPaths.crispasr), { recursive: true });
  writeFileSync(legacyPaths.crispasr, 'retained legacy');
  const { content, fetchImpl } = runtimeArchive(context, [
    { name: 'release/crispasr.exe', body: 'optimized fixture' },
    { name: 'release/ggml.dll', body: 'optimized library' },
  ], CRISPASR_AVX2_ASSET);
  await assert.rejects(ensureAsset(paths, legacy, { fetchImpl: async () => new Response(Buffer.alloc(content.length)) }), /integrity check failed/);
  assert.equal(existsSync(paths.crispasr), false);
  const destination = await ensureAsset(paths, legacy, { fetchImpl });
  assert.equal(destination, path.join(paths.runtimeDir, 'crispasr-avx2', 'crispasr.exe'));
  assert.equal(readFileSync(legacyPaths.crispasr, 'utf8'), 'retained legacy');
  assert.equal(assetReady(paths, legacy), true);
  assert.equal(assetReady(legacyPaths, legacy, destination), false);
  assert.equal(await ensureAsset(paths, legacy, { fetchImpl: async () => assert.fail('verified optimized runtime must work offline') }), destination);
  writeFileSync(path.join(path.dirname(destination), 'ggml.dll'), 'corrupted');
  assert.equal(assetReady(paths, legacy), false);
  const fallback = stackPaths({ LOCALAPPDATA: directory }, path.join(directory, 'app'));
  assert.equal(fallback.crispasr, legacyPaths.crispasr);
});

test('runtime archives extract root and nested executables with directories and verified offline reuse', async context => {
  for (const prefix of ['', 'release/']) {
    await context.test(prefix || 'root', async context => {
      const { paths } = fixture(context);
      const { asset, fetchImpl } = runtimeArchive(context, [
        { name: `${prefix}uv.exe`, body: 'fixture executable', mode: 0o100755 },
        { name: `${prefix}lib/helper.dll`, body: 'fixture library' },
        { name: `${prefix}lib/`, mode: 0o040755 },
        { name: `${prefix}empty/`, mode: 0o040755 },
        { name: `${prefix}windows/`, mode: 0, directory: true },
      ]);
      const destination = await ensureAsset(paths, asset, { fetchImpl });
      assert.equal(destination, path.join(paths.runtimeDir, 'uv', 'uv.exe'));
      assert.equal(readFileSync(destination, 'utf8'), 'fixture executable');
      assert.equal(readFileSync(path.join(path.dirname(destination), 'lib', 'helper.dll'), 'utf8'), 'fixture library');
      assert.deepEqual(readdirSync(path.join(path.dirname(destination), 'empty')), []);
      assert.deepEqual(readdirSync(path.join(path.dirname(destination), 'windows')), []);
      assert.equal(assetReady(paths, asset), true);
      const offline = { fetchImpl: async () => assert.fail('verified archive and receipts must be reused offline') };
      assert.equal(await ensureAsset(paths, asset, offline), destination);
      writeFileSync(destination, 'corrupted executable');
      assert.equal(assetReady(paths, asset), false);
      assert.equal(await ensureAsset(paths, asset, offline), destination);
      assert.equal(readFileSync(destination, 'utf8'), 'fixture executable');
      assert.equal(assetReady(paths, asset), true);
      assert.equal(readdirSync(paths.runtimeDir).some(name => name.startsWith('uv.partial-')), false);
    });
  }
});

test('runtime archives reject unsafe paths without changing the runtime or writing outside staging', async context => {
  const names = ['../outside/pwned.exe', 'safe/../../outside/pwned.exe', '..\\outside\\pwned.exe', 'C:relative.exe', 'uv.exe:payload', 'nested/uv.exe:payload', './uv.exe', 'nested/../uv.exe', 'trailing./uv.exe', 'NUL', 'bad\0name.exe', 'absolute', 'drive', 'unc'];
  for (const name of names) {
    await context.test(name.replace(/\0/g, '(NUL)'), async context => {
      const { paths } = fixture(context);
      const outside = path.join(paths.runtimeDir, 'outside');
      const escaped = path.join(outside, 'pwned.exe');
      const absolute = escaped.replace(/\\/g, '/');
      const filename = name === 'absolute' ? `/${absolute.replace(/^[A-Za-z]:\//, '')}` : name === 'drive' ? (path.win32.isAbsolute(escaped) ? escaped.replace(/\\/g, '/') : `C:${absolute}`) : name === 'unc' ? `//localhost/${absolute.replace(/^([A-Za-z]):\//, '$1$/')}` : name;
      const { asset, fetchImpl } = runtimeArchive(context, [{ name: 'uv.exe', body: 'replacement' }, { name: filename, body: 'escape' }]);
      mkdirSync(path.dirname(paths.uv), { recursive: true });
      mkdirSync(outside);
      writeFileSync(paths.uv, 'existing runtime');
      await assert.rejects(ensureAsset(paths, asset, { fetchImpl }), /unsafe path|invalid characters|invalid relative path|absolute path/i);
      assert.equal(readFileSync(paths.uv, 'utf8'), 'existing runtime');
      assert.deepEqual(readdirSync(outside), []);
      assert.equal(existsSync(escaped), false);
      assert.equal(assetReady(paths, asset), false);
      assert.equal(existsSync(paths.receiptDir), false);
      assert.equal(readdirSync(paths.runtimeDir).some(entry => entry.startsWith('uv.partial-')), false);
    });
  }
});

test('runtime archives reject symlinks and special types before a following entry can write through them', async context => {
  for (const mode of [0o120777, 0o010644, 0o020644, 0o060644, 0o140644]) {
    await context.test(mode.toString(8), async context => {
      const { paths } = fixture(context);
      const outside = path.join(paths.runtimeDir, 'outside');
      mkdirSync(outside, { recursive: true });
      writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
      const { asset, fetchImpl } = runtimeArchive(context, [
        { name: 'escape', body: '../outside', mode },
        { name: 'escape/pwned.exe', body: 'escape' },
        { name: 'uv.exe', body: 'fixture executable' },
      ]);
      await assert.rejects(ensureAsset(paths, asset, { fetchImpl }), /symbolic links or special file types/);
      assert.deepEqual(readdirSync(outside), ['sentinel']);
      assert.equal(readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
      assert.equal(existsSync(paths.uv), false);
      assert.equal(existsSync(paths.receiptDir), false);
      assert.equal(readdirSync(paths.runtimeDir).some(name => name.startsWith('uv.partial-')), false);
    });
  }
});

test('runtime archives bound extraction and clean up parser, stream and write failures', async context => {
  const cases = [
    { name: 'expanded size', entries: [{ name: 'uv.exe', size: 1024 ** 3 + 1 }], error: /size limit/ },
    { name: 'entry count', entries: Array.from({ length: 10001 }, (_, index) => ({ name: `directory-${index}/`, mode: 0o040755 })), error: /too many entries/ },
    { name: 'invalid deflate stream', entries: [{ name: 'uv.exe', body: 'runtime', compressed: Buffer.from([0x07]) }], error: /invalid|inflate/i },
    { name: 'size mismatch', entries: [{ name: 'uv.exe', body: 'runtime', size: 1 }], error: /size|byte/i },
    { name: 'duplicate file', entries: [{ name: 'uv.exe', body: 'first' }, { name: 'uv.exe', body: 'second' }], error: /EEXIST/ },
    { name: 'missing executable', entries: [{ name: 'other.exe', body: 'runtime' }], error: /missing its executable/ },
    { name: 'invalid central directory', entries: [{ name: 'uv.exe', body: 'runtime' }], corrupt: true, error: /central directory/i },
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, async context => {
      const { paths } = fixture(context);
      const { asset, content, fetchImpl } = runtimeArchive(context, scenario.entries);
      if (scenario.corrupt) {
        const centralOffset = content.readUInt32LE(content.length - 6);
        content.writeUInt32LE(0, centralOffset);
        asset.sha256 = createHash('sha256').update(content).digest('hex');
      }
      await assert.rejects(ensureAsset(paths, asset, { fetchImpl }), scenario.error);
      assert.equal(existsSync(paths.uv), false);
      assert.equal(existsSync(paths.receiptDir), false);
      assert.equal(readdirSync(paths.runtimeDir).some(name => name.startsWith('uv.partial-')), false);
      const archive = path.join(paths.runtimeDir, 'archives', asset.name);
      rmSync(archive);
      assert.equal(existsSync(archive), false, 'archive handle must be closed after failure');
    });
  }
});

test('configured local models are verified in place, and Q8 uses sibling or cached canonical Q4', async context => {
  const { directory } = fixture(context);
  const existing = path.join(directory, 'LocalVoiceStack', 'LLMs', ASSETS[0].name);
  mkdirSync(path.dirname(existing), { recursive: true });
  const content = Buffer.from('existing local GGUF fixture');
  writeFileSync(existing, content);
  const paths = stackPaths({ LOCALAPPDATA: directory, LOCAL_LLM_PATH: existing }, path.join(directory, 'app'));
  assert.equal(paths.ling, existing);
  await ensureAsset(paths, ASSETS[0], { fetchImpl: async url => {
    assert.ok(url.includes('/api/models/'), 'must not download an existing valid model');
    return Response.json([{ path: ASSETS[0].name, size: content.length, lfs: { oid: createHash('sha256').update(content).digest('hex') } }]);
  } });
  assert.deepEqual(readFileSync(existing), content);
  assert.equal(existsSync(path.join(paths.modelDir, ASSETS[0].name)), false);
  const q4 = path.join(paths.modelDir, ASSETS[1].name);
  mkdirSync(path.dirname(q4), { recursive: true });
  writeFileSync(q4, 'canonical Q4 fixture');
  const configured = stackPaths({ LOCALAPPDATA: directory, MOONSHINE_MODEL: path.join(directory, 'moonshine-streaming-small-Q8_0.gguf') }, path.join(directory, 'app'));
  assert.equal(configured.moonshine, q4);
});

test('setup networking and Python environment reject untrusted overrides', () => {
  for (const url of ['http://huggingface.co/model', 'https://huggingface.co.evil.test/model', 'file:///C:/test', 'https://user:pass@github.com/file', 'https://github.com:444/file']) assert.equal(trustedDownloadUrl(url), false);
  const paths = stackPaths({ LOCALAPPDATA: os.tmpdir() });
  const env = isolatedEnvironment({ PATH: 'system', HF_TOKEN: 'secret', OPENAI_API_KEY: 'secret', PYTHONPATH: 'injection', UV_INDEX_URL: 'https://evil.test' }, paths);
  assert.equal(env.PATH, 'system');
  assert.equal(env.HF_HUB_OFFLINE, '1');
  for (const key of ['HF_TOKEN', 'OPENAI_API_KEY', 'PYTHONPATH', 'UV_INDEX_URL']) assert.equal(env[key], undefined);
});

test('shared cache provisioning locks reject overlapping jobs and release after failure', async context => {
  const { paths } = fixture(context);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let acquired;
  const ready = new Promise(resolve => { acquired = resolve; });
  const first = withSetupLock(paths, () => { acquired(); return gate; });
  await ready;
  try { await assert.rejects(withSetupLock(paths, async () => {}), /Another app/); }
  finally { release(); await first; }
  await assert.rejects(withSetupLock(paths, async () => { throw new Error('fixture failure'); }), /fixture failure/);
  assert.equal(await withSetupLock(paths, async () => 'retry succeeded'), 'retry succeeded');
});

test('setup API is same-origin, consent-gated and returns 202 without waiting for completion', async context => {
  const { directory } = fixture(context);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let installs = 0;
  const setup = controller({ install: async () => { installs += 1; await gate; } });
  const app = await startSupervisor({ dataDir: directory, port: 0, mode: 'release', prewarm: false, setup });
  try {
    const initial = await fetch(`${app.url}/api/setup`);
    assert.equal(initial.status, 200);
    const initialJson = await initial.json();
    assert.equal(initialJson.status, 'idle');
    assert.equal(initialJson.capabilities.chat.ready, false);
    assert.equal(initialJson.capabilities.voice.ready, false);
    assert.equal(installs, 0);
    const post = body => fetch(`${app.url}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ consent: false })).status, 400);
    const foreign = await fetch(`${app.url}/api/setup`, { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{"consent":true}' });
    assert.equal(foreign.status, 403);
    assert.equal((await post({ consent: true })).status, 202);
    assert.equal((await post({ consent: true })).status, 202);
    assert.equal(installs, 1);
    release();
    await setup.settled();
    const readyJson = await (await fetch(`${app.url}/api/setup`)).json();
    assert.equal(readyJson.status, 'ready');
    assert.equal(readyJson.capabilities.chat.ready, true);
    assert.equal(readyJson.capabilities.voice.ready, true);
  } finally { release(); await app.close(); }
});

test('speech settings expose Whisper by default and persist Moonshine without a restart', context => {
  const { directory } = fixture(context);
  const env = {};
  const config = createRuntimeConfig({ dataDir: directory, env });
  const field = config.snapshot().fields.find(field => field.key === 'LOCAL_STT_PROVIDER');
  assert.equal(field.value, 'whisper');
  assert.deepEqual(field.options.map(option => option.value), ['whisper', 'moonshine']);
  assert.equal(field.restartRequired, false);
  config.update({ values: { LOCAL_STT_PROVIDER: 'moonshine' } });
  assert.equal(env.LOCAL_STT_PROVIDER, 'moonshine');
  const restored = {};
  createRuntimeConfig({ dataDir: directory, env: restored });
  assert.equal(restored.LOCAL_STT_PROVIDER, 'moonshine');
  assert.throws(() => config.update({ values: { LOCAL_STT_PROVIDER: 'chrome' } }), /unsupported value/);
});

test('Agency work-data consent defaults off and persists or revokes without restarting', context => {
  const { directory } = fixture(context);
  const env = {};
  const config = createRuntimeConfig({ dataDir: directory, env });
  const field = config.snapshot().fields.find(field => field.key === 'AGENCY_WORK_DATA_ACCESS');
  assert.equal(field.value, 'disabled');
  assert.equal(field.restartRequired, false);
  assert.deepEqual(field.options.map(option => option.value), ['disabled', 'read-only']);
  config.update({ values: { AGENCY_WORK_DATA_ACCESS: 'read-only' } });
  assert.equal(env.AGENCY_WORK_DATA_ACCESS, 'read-only');
  const restored = {};
  createRuntimeConfig({ dataDir: directory, env: restored });
  assert.equal(restored.AGENCY_WORK_DATA_ACCESS, 'read-only');
  config.update({ values: { AGENCY_WORK_DATA_ACCESS: 'disabled' } });
  assert.equal(env.AGENCY_WORK_DATA_ACCESS, 'disabled');
  assert.throws(() => config.update({ values: { AGENCY_WORK_DATA_ACCESS: 'all' } }), /unsupported value/);
});

test('speech configuration API refreshes setup and refuses changes during installation', async context => {
  const { directory } = fixture(context);
  const previous = process.env.LOCAL_STT_PROVIDER;
  process.env.LOCAL_STT_PROVIDER = 'whisper';
  let changes = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const setup = controller({ install: () => gate });
  setup.recognitionChanged = async () => { changes += 1; };
  const app = await startSupervisor({ dataDir: directory, port: 0, prewarm: false, setup });
  try {
    const post = provider => fetch(`${app.url}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: { LOCAL_STT_PROVIDER: provider } }) });
    const result = await post('moonshine');
    assert.equal(result.status, 200);
    assert.equal((await result.json()).local.sttProvider, 'moonshine');
    assert.equal(changes, 1);
    setup.start({ consent: true });
    assert.equal((await post('whisper')).status, 409);
    assert.equal(process.env.LOCAL_STT_PROVIDER, 'moonshine');
    assert.equal(changes, 1);
  } finally {
    release();
    await app.close();
    if (previous === undefined) delete process.env.LOCAL_STT_PROVIDER;
    else process.env.LOCAL_STT_PROVIDER = previous;
  }
});

test('setup configuration persists approved Python and mirrors without replacing the running interpreter', context => {
  const { directory } = fixture(context);
  const basePython = path.join(directory, 'Python312', 'python.exe');
  const nextPython = path.join(directory, 'approved Python', 'python.exe');
  const env = { PYTHON_BIN: basePython };
  const config = createRuntimeConfig({ dataDir: directory, env });
  env.PYTHON_BIN = path.join(directory, 'active-venv', 'python.exe');
  assert.equal(config.snapshot().fields.find(field => field.key === 'PYTHON_BIN').value, basePython);
  const updated = config.update({ values: { PYTHON_BIN: nextPython, LOCAL_SPACY_MODEL_URL: 'https://packages.example.test/en_core_web_sm-3.8.0-py3-none-any.whl' } });
  const pythonField = updated.fields.find(field => field.key === 'PYTHON_BIN');
  assert.equal(pythonField.value, nextPython);
  assert.equal(pythonField.pendingRestart, true);
  assert.equal(env.PYTHON_BIN, path.join(directory, 'active-venv', 'python.exe'));
  assert.equal(env.LOCAL_SPACY_MODEL_URL, 'https://packages.example.test/en_core_web_sm-3.8.0-py3-none-any.whl');
  assert.throws(() => config.update({ values: { PYTHON_BIN: 'relative/python.exe' } }), /absolute executable path/);
  assert.throws(() => config.update({ values: { LOCAL_SPACY_MODEL_URL: 'http://untrusted.example/model.whl' } }), /HTTPS/);
  const restartedEnv = {};
  const restarted = createRuntimeConfig({ dataDir: directory, env: restartedEnv });
  assert.equal(restartedEnv.PYTHON_BIN, nextPython);
  assert.equal(restarted.snapshot().fields.find(field => field.key === 'PYTHON_BIN').pendingRestart, false);
  restarted.update({ values: { PYTHON_BIN: '', LOCAL_SPACY_MODEL_URL: '' } });
  const managedEnv = {};
  createRuntimeConfig({ dataDir: directory, env: managedEnv });
  assert.equal(managedEnv.PYTHON_BIN, '');
  for (const python of ['python', path.join('.venv', 'Scripts', 'python.exe')]) {
    const dataDir = path.join(directory, python === 'python' ? 'managed-config' : 'legacy-config');
    const legacyEnv = { PYTHON_BIN: python, SUPERVISOR_CONFIG_DIR: directory };
    const legacy = createRuntimeConfig({ dataDir, env: legacyEnv });
    const field = legacy.snapshot().fields.find(field => field.key === 'PYTHON_BIN');
    assert.equal(field.value, stackPaths(legacyEnv).pythonBase || '');
    const saved = legacy.update({ values: { PYTHON_BIN: field.value } });
    assert.equal(saved.fields.find(field => field.key === 'PYTHON_BIN').pendingRestart, false);
  }
});

test('local setup accepts explicit HTTPS package mirrors and rejects insecure indexes', windowsSetup, async context => {
  const { directory } = fixture(context);
  const pythonBase = path.join(directory, 'python.exe');
  writeFileSync(pythonBase, 'approved interpreter fixture');
  for (const python of [undefined, pythonBase]) {
    const mirrored = localFixture(context, { env: {
      PYTHON_BIN: python,
      LOCAL_PYPI_INDEX_URL: 'https://packages.contoso.test/pypi/',
      LOCAL_TORCH_INDEX_URL: 'https://packages.contoso.test/torch/',
      LOCAL_SPACY_MODEL_URL: 'https://packages.contoso.test/en_core_web_sm-3.8.0-py3-none-any.whl',
    } });
    mirrored.setup.start({ consent: true });
    assert.equal((await mirrored.setup.settled()).status, 'ready');
    const installs = mirrored.commands.filter(command => command.args.includes('pip') && command.args.includes('install'));
    assert.equal(installs[0].args[installs[0].args.indexOf('--index-url') + 1], 'https://packages.contoso.test/torch');
    assert.equal(installs[1].args[installs[1].args.indexOf('--index-url') + 1], 'https://packages.contoso.test/pypi');
    assert.equal(installs[1].args.at(-1), 'https://packages.contoso.test/en_core_web_sm-3.8.0-py3-none-any.whl');
  }

  const insecure = localFixture(context, { env: { LOCAL_PYPI_INDEX_URL: 'http://packages.example.test/simple' } });
  insecure.setup.start({ consent: true });
  const failed = await insecure.setup.settled();
  assert.equal(failed.capabilities.chat.ready, true);
  assert.equal(failed.capabilities.voice.ready, false);
  assert.match(failed.error, /Python package index must use HTTPS/);
  assert.equal(insecure.commands.length, 0);
  for (const modelUrl of ['http://packages.contoso.test/model.whl', 'https://user:password@packages.contoso.test/model.whl', 'file:///C:/model.whl']) {
    const invalid = localFixture(context, { env: { LOCAL_SPACY_MODEL_URL: modelUrl } });
    invalid.setup.start({ consent: true });
    assert.match((await invalid.setup.settled()).error, /spaCy model URL must use HTTPS/);
    assert.equal(invalid.commands.length, 0);
  }
});

test('cached chat resumes after restart when Kokoro installation was incomplete', windowsSetup, async context => {
  const fixtureSetup = localFixture(context, {
    run: async (executable, args, options) => {
      if (args.includes('venv')) {
        mkdirSync(path.dirname(fixtureSetup.paths.python), { recursive: true });
        writeFileSync(fixtureSetup.paths.python, 'fixture Python');
      }
      if (args.includes('pip')) throw new Error('Kokoro mirror unavailable');
    },
  });
  fixtureSetup.setup.start({ consent: true });
  const failed = await fixtureSetup.setup.settled();
  assert.equal(failed.capabilities.chat.ready, true);
  const completionFile = path.join(fixtureSetup.paths.home, 'local-setup.json');
  assert.equal(existsSync(completionFile), true);
  const completed = JSON.parse(readFileSync(completionFile, 'utf8'));
  mkdirSync(fixtureSetup.paths.receiptDir, { recursive: true });
  for (const asset of ASSETS.filter(candidate => ['ling', 'llama'].includes(candidate.id))) {
    const destination = completed.paths[asset.id];
    const stat = statSync(destination);
    const receipt = path.join(fixtureSetup.paths.receiptDir, `${asset.id}-${createHash('sha256').update(destination).digest('hex').slice(0, 20)}.json`);
    writeFileSync(receipt, JSON.stringify({ sourceUrl: asset.sourceUrl, files: [{ path: destination, size: stat.size, mtimeMs: stat.mtimeMs }] }));
  }
  await fixtureSetup.setup.close();
  for (const key of ['LOCAL_LLM_PATH', 'MOONSHINE_MODEL', 'LLAMA_SERVER_BIN', 'CRISPASR_BIN', 'VAD_MODEL', 'PYTHON_BIN']) delete fixtureSetup.env[key];

  let activations = 0;
  const restarted = createLocalSetup({
    env: fixtureSetup.env,
    provision: async () => { throw new Error('Offline resume must not download'); },
    activateLLM: async () => {
      activations++;
      return { llama: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() {} }) };
    },
    warm: async () => false,
  });
  context.after(() => restarted.close());
  restarted.resume();
  const resumed = await restarted.settled();
  assert.equal(activations, 1);
  assert.equal(resumed.capabilities.chat.ready, true);
  assert.equal(resumed.capabilities.voice.ready, false);
});

test('saved configuration retains valid fields beside malformed values', context => {
  const { directory } = fixture(context);
  writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ version: 1, values: { LLAMA_THREADS: '0', OPENAI_MODEL: 0, GEMINI_MODEL: 'gemini-valid' } }));
  const env = {};
  const config = createRuntimeConfig({ dataDir: directory, env });
  assert.equal(env.GEMINI_MODEL, 'gemini-valid');
  assert.equal(env.LLAMA_THREADS, undefined);
  assert.deepEqual(config.snapshot().warnings.map(warning => warning.match(/LLAMA_THREADS|OPENAI_MODEL/)?.[0]), ['LLAMA_THREADS', 'OPENAI_MODEL']);
  assert.equal(config.snapshot().fields.find(field => field.key === 'GEMINI_MODEL').value, 'gemini-valid');

  const malformedDirectory = mkdtempSync(path.join(os.tmpdir(), 'voice-config-malformed-'));
  context.after(() => rmSync(malformedDirectory, { recursive: true, force: true }));
  writeFileSync(path.join(malformedDirectory, 'config.json'), '{');
  assert.match(createRuntimeConfig({ dataDir: malformedDirectory, env: {} }).snapshot().warnings[0], /file is invalid/);
});