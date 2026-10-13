import { randomBytes, createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const usage = 'node scripts/prepare-native-install.mjs --prepare-only --app-exe <absolute .exe> --original-cli <absolute .exe> --node <absolute .exe> --launcher <release .exe> --broker <release .exe> --config-path <existing absolute config file> [--target <new D: directory>]';
const options = new Map();
let prepareOnly = false;
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key === '--prepare-only') {
    if (prepareOnly) throw Error('--prepare-only may be specified once');
    prepareOnly = true;
    continue;
  }
  if (!key.startsWith('--') || index + 1 >= process.argv.length || process.argv[index + 1].startsWith('--')) {
    throw Error(`Invalid arguments. Usage: ${usage}`);
  }
  if (options.has(key)) throw Error(`Duplicate argument: ${key}`);
  options.set(key, process.argv[++index]);
}
if (!prepareOnly) throw Error(`--prepare-only is required; this script never launches Codex. Usage: ${usage}`);

const required = ['--app-exe', '--original-cli', '--node', '--launcher', '--broker', '--config-path'];
for (const key of required) if (!options.has(key)) throw Error(`Missing ${key}. Usage: ${usage}`);
if (process.platform !== 'win32') throw Error('Preparation is supported only on Windows.');

function absoluteExecutable(name) {
  const value = options.get(name);
  if (!isAbsolute(value) || extname(value).toLowerCase() !== '.exe' || !existsSync(value) || !statSync(value).isFile()) {
    throw Error(`${name} must be an existing absolute .exe path.`);
  }
  return realpathSync(value);
}

const appExe = absoluteExecutable('--app-exe');
const originalCli = absoluteExecutable('--original-cli');
const nodeExe = absoluteExecutable('--node');
const launcherExe = absoluteExecutable('--launcher');
const brokerExe = absoluteExecutable('--broker');
const nodeVersionProbe = spawnSync(nodeExe, ['--version'], { encoding: 'utf8', windowsHide: true });
if (nodeVersionProbe.status !== 0 || !/^v(?:22|2[3-9]|[3-9]\d)\./.test(nodeVersionProbe.stdout.trim())) {
  throw Error('--node must run Node.js 22 or newer.');
}
const nodeVersion = nodeVersionProbe.stdout.trim();

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = realpathSync(resolve(moduleDirectory, '..'));
const packageMetadata = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'));
const cargoManifest = readFileSync(join(sourceRoot, 'native-launcher', 'Cargo.toml'), 'utf8');
const launcherVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!launcherVersion) throw Error('Unable to read native launcher version.');

const defaultBase = 'D:/dev/codex-quota-resume/.test-evidence/native-install';
const targetInput = options.get('--target') ?? join(defaultBase, randomBytes(16).toString('hex'));
if (!isAbsolute(targetInput) || !/^D:[\\/]/i.test(targetInput)) throw Error('Install target must be an explicitly absolute D: path.');
const target = resolve(targetInput);
if (existsSync(target)) throw Error('Install target already exists; refusing to overwrite it.');
let existingAncestor = target;
while (!existsSync(existingAncestor)) {
  const parent = dirname(existingAncestor);
  if (parent === existingAncestor) throw Error('Unable to locate an existing install target ancestor.');
  existingAncestor = parent;
}
if (!/^D:[\\/]/i.test(realpathSync(existingAncestor))) {
  throw Error('Install target resolves through an existing junction/symlink outside D:.');
}

const configInput = options.get('--config-path');
if (!isAbsolute(configInput) || !existsSync(configInput) || !statSync(configInput).isFile()) {
  throw Error('--config-path must be an existing absolute config file; it will only be referenced, never read or changed.');
}
const configPath = realpathSync(configInput);
if (!/^D:[\\/]/i.test(configPath)) throw Error('--config-path must resolve to an existing D: file.');
const dataDirectory = dirname(configPath);

const binDirectory = join(target, 'bin');
const scriptDirectory = join(target, 'scripts');
const secretDirectory = join(target, 'secrets');
const tempDirectory = join(target, 'tmp');
mkdirSync(dirname(target), { recursive: true });
mkdirSync(target);
mkdirSync(binDirectory);
mkdirSync(scriptDirectory);
mkdirSync(secretDirectory);
mkdirSync(tempDirectory);

const copied = [];
function register(relativePath, absolutePath) {
  const bytes = readFileSync(absolutePath);
  copied.push({ path: relativePath.replaceAll('\\', '/'), sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex') });
}
function copyNew(source, destination, relativePath) {
  copyFileSync(source, destination, 1); // COPYFILE_EXCL: never overwrite a package file.
  register(relativePath, destination);
}

copyNew(launcherExe, join(binDirectory, 'quota-resume-launcher.exe'), 'bin/quota-resume-launcher.exe');
copyNew(brokerExe, join(binDirectory, 'pipe-broker.exe'), 'bin/pipe-broker.exe');

function copyScriptModules(from, to, relativePrefix = '') {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const rel = relativePrefix ? join(relativePrefix, entry.name) : entry.name;
    if (entry.isSymbolicLink()) throw Error(`Refusing symlink in runtime scripts: ${rel}`);
    if (entry.isDirectory()) {
      mkdirSync(join(to, entry.name));
      copyScriptModules(source, join(to, entry.name), rel);
    } else if (entry.isFile() && entry.name === 'prepare-native-install.mjs') {
      continue;
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      copyNew(source, join(to, entry.name), `scripts/${rel}`);
    } else if (!entry.isFile()) {
      throw Error(`Unsupported runtime source entry: ${rel}`);
    }
  }
}
copyScriptModules(join(sourceRoot, 'scripts'), scriptDirectory);

for (const relativePath of ['package.json', 'plugin.json', '.codex-plugin/plugin.json',
  'hooks/hooks.json', 'scripts/run.cmd', 'skills/quota-resume/SKILL.md', 'README.md',
  'docs/requirements.md', 'docs/development-plan.md', 'docs/native-bridge-plan.md',
  'docs/native-installation.md', 'docs/acceptance-2026-10-12.md',
  'docs/capability-verification.md', 'docs/gap-progress-2026-10-13.md']) {
  const source = join(sourceRoot, relativePath);
  if (!existsSync(source) || !statSync(source).isFile()) throw Error(`Required plugin runtime file is missing: ${relativePath}`);
  const destination = join(target, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  copyNew(source, destination, relativePath);
}

const token = randomBytes(32).toString('base64url');
const tokenPath = join(secretDirectory, 'bridge-token');
writeFileSync(tokenPath, token, { flag: 'wx', mode: 0o600 });
register('secrets/bridge-token', tokenPath);
const userSid = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
if (userSid.status !== 0) throw Error('Unable to determine the current Windows user SID for token ACL.');
const sid = userSid.stdout.match(/"(S-1-[0-9-]+)"/)?.[1];
if (!sid) throw Error('Unable to parse current Windows user SID for token ACL.');
const acl = spawnSync('icacls.exe', [tokenPath, '/inheritance:r', '/grant:r', `*${sid}:(R)`], {
  encoding: 'utf8', windowsHide: true,
});
if (acl.status !== 0) throw Error('icacls failed to restrict the bridge-token file to the current user.');

const startupScript = `#Requires -Version 7.0
# Run with D:/app/PowerShell-7.6.3-win-x64/pwsh.exe -File start-codex.ps1 ...
param(
  [Parameter(Mandatory = $true)][string]$AppExe,
  [Parameter(Mandatory = $true)][string]$OriginalCli,
  [Parameter(Mandatory = $true)][string]$NodeExe,
  [string]$AppArgumentsJson = '[]'
)
$ErrorActionPreference = 'Stop'
foreach ($candidate in @($AppExe, $OriginalCli, $NodeExe)) {
  if (-not [IO.Path]::IsPathFullyQualified($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf) -or [IO.Path]::GetExtension($candidate) -ine '.exe') {
    throw 'AppExe, OriginalCli, and NodeExe must be explicit existing absolute .exe paths.'
  }
}
$resolvedAppExe = (Resolve-Path -LiteralPath $AppExe).Path
$runningMatch = Get-CimInstance Win32_Process -ErrorAction Stop |
  Where-Object { $_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), [IO.Path]::GetFullPath($resolvedAppExe), [StringComparison]::OrdinalIgnoreCase) }
if ($runningMatch) { throw 'The requested desktop executable is already running; refusing a single-instance handoff to an existing process.' }
$AppArguments = ConvertFrom-Json -InputObject $AppArgumentsJson -NoEnumerate
if ($AppArguments -isnot [array] -or @($AppArguments | Where-Object { $_ -isnot [string] }).Count -gt 0) {
  throw 'AppArgumentsJson must be a JSON string array. Each argument is passed unchanged, including a literal --.'
}
$installRoot = $PSScriptRoot
$configPath = '${configPath.replaceAll("'", "''")}'
$dataDirectory = Split-Path -Parent $configPath
$tempDirectory = Join-Path $installRoot 'tmp'
$launcherPath = Join-Path $installRoot 'bin/quota-resume-launcher.exe'
$brokerPath = Join-Path $installRoot 'bin/pipe-broker.exe'
$hostScript = Join-Path $installRoot 'scripts/native-host.mjs'
$tokenPath = Join-Path $installRoot 'secrets/bridge-token'
foreach ($requiredFile in @($launcherPath, $brokerPath, $hostScript, $configPath, $tokenPath)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) { throw "Prepared runtime file missing: $requiredFile" }
}
$token = [IO.File]::ReadAllText($tokenPath)
if ($token.Length -lt 32) { throw 'Prepared bridge token is invalid.' }
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $AppExe
$start.WorkingDirectory = Split-Path -Parent $AppExe
$start.UseShellExecute = $false
foreach ($argument in $AppArguments) {
  [void]$start.ArgumentList.Add($argument)
}
$start.Environment['CODEX_CLI_PATH'] = $launcherPath
$start.Environment['QUOTA_RESUME_BROKER'] = $brokerPath
$start.Environment['QUOTA_RESUME_ORIGINAL_CLI'] = $OriginalCli
$start.Environment['QUOTA_RESUME_NODE'] = $NodeExe
$start.Environment['QUOTA_RESUME_HOST_SCRIPT'] = $hostScript
$start.Environment['QUOTA_RESUME_CONFIG_PATH'] = $configPath
$start.Environment['QUOTA_RESUME_BRIDGE_TOKEN'] = $token
$start.Environment['CODEX_QUOTA_RESUME_DATA'] = $dataDirectory
$start.Environment['TEMP'] = $tempDirectory
$start.Environment['TMP'] = $tempDirectory
$start.Environment['TMPDIR'] = $tempDirectory
$process = [Diagnostics.Process]::Start($start)
if ($null -eq $process) { throw 'Codex desktop process did not start.' }
$process.WaitForExit()
exit $process.ExitCode
`;
const startPath = join(target, 'start-codex.ps1');
writeFileSync(startPath, startupScript, { flag: 'wx', encoding: 'utf8' });
register('start-codex.ps1', startPath);

const manifest = {
  formatVersion: 1,
  pluginVersion: packageMetadata.version,
  launcherVersion,
  nodeVersion,
  preparedAt: new Date().toISOString(),
  files: copied.sort((left, right) => left.path.localeCompare(right.path)),
};
const manifestPath = join(target, 'manifest.json');
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' });

console.log(JSON.stringify({ prepared: true, prepareOnly: true, target,
  manifest: manifestPath, fileCount: copied.length + 1, tokenAclRestrictedToCurrentUser: true,
  existingUserConfigRead: false, existingUserConfigWritten: false, codexLaunched: false }, null, 2));
