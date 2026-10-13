import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'node scripts/prepare-legacy-plugin.mjs --prepare-only [--target <new absolute D: directory>] [--marketplace-name <name>]';
let prepareOnly = false;
const options = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key === '--prepare-only') {
    if (prepareOnly) throw Error('--prepare-only may be specified once');
    prepareOnly = true;
    continue;
  }
  if (!['--target', '--marketplace-name'].includes(key) || index + 1 >= process.argv.length || process.argv[index + 1].startsWith('--')) {
    throw Error(`Invalid arguments. Usage: ${usage}`);
  }
  if (options.has(key)) throw Error(`Duplicate argument: ${key}`);
  options.set(key, process.argv[++index]);
}
if (!prepareOnly) throw Error(`--prepare-only is required. This script only prepares files and never installs or launches Codex. Usage: ${usage}`);
if (process.platform !== 'win32') throw Error('Preparation is supported only on Windows.');

const sourceRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const packageMetadata = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'));
const legacyManifestPath = join(sourceRoot, '.codex-plugin', 'plugin.json');
const legacyManifest = JSON.parse(readFileSync(legacyManifestPath, 'utf8'));
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(packageMetadata.version ?? '')
  || legacyManifest.version !== packageMetadata.version
  || legacyManifest.name !== packageMetadata.name
  || typeof legacyManifest.hooks !== 'string'
  || !legacyManifest.hooks.startsWith('./')) {
  throw Error('package.json and .codex-plugin/plugin.json identity/version/hooks do not agree.');
}

const defaultTarget = `D:/dev/codex-quota-resume/.test-evidence/legacy-plugin-probe/${randomBytes(16).toString('hex')}`;
const targetInput = options.get('--target') ?? defaultTarget;
if (!isAbsolute(targetInput) || !/^D:[\\/]/i.test(targetInput)) {
  throw Error('--target must be explicitly absolute and on D:.');
}
const target = resolve(targetInput);
if (existsSync(target)) throw Error('Target already exists; refusing to overwrite it.');
let ancestor = dirname(target);
while (!existsSync(ancestor)) {
  const parent = dirname(ancestor);
  if (parent === ancestor) throw Error('Unable to find an existing target ancestor.');
  ancestor = parent;
}
if (!/^D:[\\/]/i.test(realpathSync(ancestor))) throw Error('Target resolves through an existing junction/symlink outside D:.');

const pluginRoot = join(target, 'codex-quota-resume');
const copied = [];
function addRecord(relativePath, destination) {
  const bytes = readFileSync(destination);
  copied.push({ path: relativePath.replaceAll('\\', '/'), sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex') });
}
function copyNew(source, destination, relativePath) {
  if (!statSync(source).isFile()) throw Error(`Required source is not a file: ${relativePath}`);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination, 1);
  addRecord(relativePath, destination);
}

// Create only beneath the verified new D: target. No source or installed files are moved.
mkdirSync(dirname(target), { recursive: true });
mkdirSync(target);
mkdirSync(join(target, '.agents', 'plugins'), { recursive: true });
mkdirSync(pluginRoot);

for (const relativePath of ['package.json', '.codex-plugin/plugin.json', 'hooks/hooks.json', 'scripts/run.cmd',
  'skills/quota-resume/SKILL.md', 'README.md']) {
  copyNew(join(sourceRoot, relativePath), join(pluginRoot, relativePath), `codex-quota-resume/${relativePath}`);
}

function copyModules(sourceDirectory, destinationDirectory, relativePrefix = '') {
  for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
    const source = join(sourceDirectory, entry.name);
    const relativePath = relativePrefix ? join(relativePrefix, entry.name) : entry.name;
    if (entry.isSymbolicLink()) throw Error(`Refusing symlink in scripts: ${relativePath}`);
    if (entry.isDirectory()) {
      copyModules(source, join(destinationDirectory, entry.name), relativePath);
    } else if (entry.isFile() && entry.name === 'run.cmd') {
      // run.cmd was copied from the explicit runtime list above.
      continue;
    } else if (entry.isFile() && entry.name === 'prepare-native-install.mjs') {
      continue;
    } else if (entry.isFile() && entry.name === 'prepare-legacy-plugin.mjs') {
      continue;
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      copyNew(source, join(pluginRoot, 'scripts', relativePath), `codex-quota-resume/scripts/${relativePath}`);
    } else if (!entry.isFile()) {
      throw Error(`Unsupported scripts entry: ${relativePath}`);
    }
  }
}
copyModules(join(sourceRoot, 'scripts'), join(pluginRoot, 'scripts'));

const docsSource = join(sourceRoot, 'docs');
for (const entry of readdirSync(docsSource, { withFileTypes: true })) {
  if (entry.isSymbolicLink()) throw Error(`Refusing symlink in docs: ${entry.name}`);
  if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue;
  copyNew(join(docsSource, entry.name), join(pluginRoot, 'docs', entry.name), `codex-quota-resume/docs/${entry.name}`);
}

if (existsSync(join(pluginRoot, 'plugin.json'))) throw Error('Legacy-only package unexpectedly contains a root plugin.json.');
const marketplaceName = options.get('--marketplace-name') ?? 'local-quota-resume-legacy-probe';
if (!/^[a-z][a-z0-9-]{0,63}$/.test(marketplaceName)) throw Error('Invalid marketplace name');
const marketplace = {
  name: marketplaceName,
  interface: { displayName: marketplaceName === 'local-quota-resume' ? '本地额度恢复插件' : '额度恢复插件 Legacy 只读验收' },
  plugins: [{ name: legacyManifest.name, source: { source: 'local', path: './codex-quota-resume' } }],
};
const marketplacePath = join(target, '.agents', 'plugins', 'marketplace.json');
writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' });
addRecord('.agents/plugins/marketplace.json', marketplacePath);

const artifactManifest = {
  formatVersion: 1,
  distributionFormat: 'codex-legacy-only',
  pluginName: legacyManifest.name,
  pluginVersion: legacyManifest.version,
  marketplaceName,
  generatedAt: new Date().toISOString(),
  files: copied.sort((left, right) => left.path.localeCompare(right.path)),
};
const artifactManifestPath = join(target, 'generation-manifest.json');
writeFileSync(artifactManifestPath, `${JSON.stringify(artifactManifest, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' });

console.log(JSON.stringify({ prepared: true, prepareOnly: true, target,
  pluginRoot, marketplacePath, marketplaceName, pluginName: legacyManifest.name,
  pluginVersion: legacyManifest.version, manifestHashCount: copied.length,
  rootPluginJsonPresent: false, CodexInstalled: false, hooksTrusted: false, hooksExecuted: false }, null, 2));
