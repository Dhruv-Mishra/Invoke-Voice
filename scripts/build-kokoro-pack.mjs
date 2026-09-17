import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, createReadStream, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import { verifyKokoroPack } from '../src/kokoro-pack.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const recipe = path.join(root, 'requirements-kokoro-pack.in');
const output = path.join(root, 'artifacts', 'kokoro-offline-pack');
const torchIndex = process.env.LOCAL_TORCH_INDEX_URL || 'https://download.pytorch.org/whl/cpu';
const pythonIndex = process.env.LOCAL_PYPI_INDEX_URL || 'https://pypi.org/simple';

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr?.trim() || `${executable} exited with code ${result.status}`);
  return result.stdout?.trim();
}

function findPython() {
  const candidates = process.env.KOKORO_PACK_PYTHON
    ? [[process.env.KOKORO_PACK_PYTHON, []]]
    : [[path.join(root, '.venv', 'Scripts', 'python.exe'), []], ['py', ['-3.12']], ['python', []]];
  const probe = 'import platform,struct,sys; assert sys.version_info[:2] == (3,12) and platform.system() == "Windows" and platform.machine().lower() in ("amd64","x86_64") and struct.calcsize("P") == 8';
  for (const [executable, prefix] of candidates) {
    const result = spawnSync(executable, [...prefix, '-I', '-c', probe], { cwd: root, stdio: 'ignore' });
    if (!result.error && result.status === 0) return { executable, prefix };
  }
  throw new Error('Kokoro pack build requires CPython 3.12 Windows x64. Set KOKORO_PACK_PYTHON to its python.exe.');
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function wheelMetadata(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, archive) => {
      if (error) return reject(error);
      archive.readEntry();
      archive.on('entry', entry => {
        if (!/\.dist-info\/METADATA$/i.test(entry.fileName)) return archive.readEntry();
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            const metadata = Buffer.concat(chunks).toString('utf8');
            const name = /^Name:\s*(.+)$/mi.exec(metadata)?.[1]?.trim();
            const version = /^Version:\s*(.+)$/mi.exec(metadata)?.[1]?.trim();
            if (!name || !version) reject(new Error(`Wheel metadata is missing Name or Version: ${path.basename(file)}`));
            else resolve({ name, version });
          });
        });
      });
      archive.on('end', () => reject(new Error(`Wheel metadata was not found: ${path.basename(file)}`)));
      archive.on('error', reject);
    });
  });
}

async function buildManifest(packDir) {
  const wheelhouse = path.join(packDir, 'wheelhouse');
  const wheels = [];
  for (const filename of readdirSync(wheelhouse).filter(name => name.toLowerCase().endsWith('.whl')).sort()) {
    const file = path.join(wheelhouse, filename);
    const metadata = await wheelMetadata(file);
    wheels.push({ ...metadata, filename, size: statSync(file).size, sha256: await sha256(file) });
  }
  const duplicates = wheels.map(wheel => wheel.name.toLowerCase().replace(/[_.]+/g, '-')).filter((name, index, names) => names.indexOf(name) !== index);
  if (duplicates.length) throw new Error(`Pack resolved duplicate projects: ${[...new Set(duplicates)].join(', ')}`);
  const lockText = wheels.map(wheel => `${wheel.name}==${wheel.version} --hash=sha256:${wheel.sha256}`).join('\n') + '\n';
  const lockFile = path.join(packDir, 'requirements.lock');
  writeFileSync(lockFile, lockText, 'utf8');
  const manifest = {
    schemaVersion: 1,
    platform: 'win32',
    arch: 'x64',
    python: '3.12',
    abi: 'cp312',
    recipeSha256: await sha256(recipe),
    lock: { filename: 'requirements.lock', size: Buffer.byteLength(lockText), sha256: await sha256(lockFile) },
    wheels,
  };
  writeFileSync(path.join(packDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

async function verifyInstall(python, packDir) {
  const verifyDir = path.join(packDir, '.verify');
  const verifyPython = path.join(verifyDir, 'Scripts', 'python.exe');
  run(python.executable, [...python.prefix, '-I', '-m', 'venv', verifyDir]);
  run(verifyPython, ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', '--no-input', 'install', '--no-index', '--find-links', path.join(packDir, 'wheelhouse'), '--only-binary', ':all:', '--require-hashes', '-r', path.join(packDir, 'requirements.lock')]);
  run(verifyPython, ['-I', '-m', 'pip', 'check']);
  run(verifyPython, ['-I', '-c', 'import en_core_web_sm,kokoro,soundfile,spacy,torch; assert kokoro.__version__ == "0.9.4"; assert soundfile.__version__ == "0.13.1"; assert spacy.__version__.startswith("3.8."); assert en_core_web_sm.__version__ == "3.8.0"; assert torch.__version__ == "2.8.0+cpu" and torch.version.cuda is None and not torch.cuda.is_available(); en_core_web_sm.load()']);
  rmSync(verifyDir, { recursive: true, force: true });
}

function publishPack(staging) {
  rmSync(output, { recursive: true, force: true });
  mkdirSync(path.dirname(output), { recursive: true });
  try {
    renameSync(staging, output);
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    mkdirSync(path.join(output, 'wheelhouse'), { recursive: true });
    for (const filename of ['manifest.json', 'requirements.lock']) copyFileSync(path.join(staging, filename), path.join(output, filename));
    for (const filename of readdirSync(path.join(staging, 'wheelhouse'))) copyFileSync(path.join(staging, 'wheelhouse', filename), path.join(output, 'wheelhouse', filename));
    rmSync(staging, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Kokoro pack builds are supported only on Windows x64.');
  const recipeSha256 = await sha256(recipe);
  const existing = await verifyKokoroPack(output);
  if (!process.argv.includes('--force') && existing?.manifest.recipeSha256 === recipeSha256) {
    console.log(`Verified Kokoro offline pack is current: ${output}`);
    return;
  }

  const python = findPython();
  const staging = `${output}.staging-${process.pid}`;
  const wheelhouse = path.join(staging, 'wheelhouse');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(wheelhouse, { recursive: true });
  try {
    run(python.executable, [...python.prefix, '-I', '-m', 'pip', 'download', '--disable-pip-version-check', '--no-deps', '--only-binary', ':all:', '--platform', 'win_amd64', '--python-version', '3.12', '--implementation', 'cp', '--abi', 'cp312', '--index-url', torchIndex, '--dest', wheelhouse, 'torch==2.8.0']);
    run(python.executable, [...python.prefix, '-I', '-m', 'pip', 'wheel', '--disable-pip-version-check', '--no-deps', '--wheel-dir', wheelhouse, 'docopt==0.6.2']);
    run(python.executable, [...python.prefix, '-I', '-m', 'pip', 'download', '--disable-pip-version-check', '--only-binary', ':all:', '--platform', 'win_amd64', '--python-version', '3.12', '--implementation', 'cp', '--abi', 'cp312', '--index-url', pythonIndex, '--find-links', wheelhouse, '--dest', wheelhouse, '-r', recipe]);
    await buildManifest(staging);
    if (!await verifyKokoroPack(staging)) throw new Error('Generated Kokoro pack failed manifest verification.');
    await verifyInstall(python, staging);
    publishPack(staging);
    if (!await verifyKokoroPack(output)) throw new Error('Published Kokoro pack failed manifest verification.');
    console.log(`Built and verified Kokoro offline pack: ${output}`);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
