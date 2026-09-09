'use strict';
// Shared injector for the Windows and macOS/Linux launchers.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PREFIX = 'saoudrizwan.claude-dev-';
const GUARD_PATH = path.join(__dirname, 'cline-undici-guard.cjs');
const MARKER = '/* CLINE-UNDICI-GUARD:INJECT */';
const HELP = `Usage: cline-patch.sh [options] (or: node patch-cline.cjs [options])

  --dry-run                Preview changes; do not install dependencies or write files
  --status                 Report whether the on-disk patch points to this folder
  --restore                Restore the verified original entry file from its backup
  --extensions-dir DIR     Look for the newest Cline version in this extensions root
  --extension-dir DIR      Target one specific Cline extension folder
  --help, -h               Show this help

Without a directory option, inspect standard VS Code, Insiders, and VS Code
Server extension roots under your home folder. Patch the newest non-obsolete
Cline version in each root. No sudo is needed. Reload VS Code after changes.
Keep this repository (including node_modules) in place while the patch is used.
The inherited global dispatcher patch also affects remote-provider requests.
`;

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--status') options.status = true;
    else if (arg === '--restore') options.restore = true;
    else if (arg === '--extensions-dir' || arg === '--extension-dir') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(arg + ' requires a path.');
      if (options.root || options.directory) throw new Error('Use only one directory option.');
      options[arg === '--extensions-dir' ? 'root' : 'directory'] = path.resolve(args[++i]);
    } else throw new Error('Unknown option: ' + arg + '. Use --help.');
  }
  if (options.status && (options.restore || options.dryRun)) {
    throw new Error('--status cannot be combined with --restore or --dry-run.');
  }
  return options;
}

function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error('Unsupported Cline version: ' + version);
  return { numbers: match.slice(1, 4).map(Number), pre: match[4] };
}

function compareVersions(a, b) {
  const va = versionParts(a.version);
  const vb = versionParts(b.version);
  for (let i = 0; i < 3; i++) {
    if (va.numbers[i] !== vb.numbers[i]) return vb.numbers[i] - va.numbers[i];
  }
  if (va.pre === vb.pre) return a.directory.localeCompare(b.directory);
  if (!va.pre) return -1;
  if (!vb.pre) return 1;
  const pa = va.pre.split('.');
  const pb = vb.pre.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return 1;
    if (pb[i] === undefined) return -1;
    if (pa[i] === pb[i]) continue;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb) return Number(pb[i]) - Number(pa[i]);
    if (na !== nb) return na ? 1 : -1;
    return pa[i] < pb[i] ? 1 : -1;
  }
  return 0;
}

function readExtension(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (manifest.publisher !== 'saoudrizwan' || manifest.name !== 'claude-dev') {
    throw new Error('Not a Cline extension: ' + directory);
  }
  versionParts(manifest.version);
  return { directory, version: manifest.version, manifest };
}

function discover(options) {
  if (options.directory) return [readExtension(options.directory)];
  const roots = options.root ? [options.root] : [
    '.vscode', '.vscode-insiders', '.vscode-server', '.vscode-server-insiders',
  ].map((name) => path.join(os.homedir(), name, 'extensions'));
  const targets = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const obsoletePath = path.join(root, '.obsolete');
    const obsolete = fs.existsSync(obsoletePath)
      ? JSON.parse(fs.readFileSync(obsoletePath, 'utf8')) : {};
    const candidates = fs.readdirSync(root, { withFileTypes: true })
      .filter((item) => item.isDirectory() && item.name.startsWith(PREFIX) && !obsolete[item.name])
      .map((item) => readExtension(path.join(root, item.name)))
      .sort(compareVersions);
    if (candidates.length) targets.push(candidates[0]);
  }
  if (!targets.length) {
    throw new Error('No Cline installation found. Searched:\n  ' + roots.join('\n  ') +
      '\nUse --extensions-dir or --extension-dir for a custom/portable installation.');
  }
  return targets;
}

function entryPath(target) {
  const { directory, manifest } = target;
  if (typeof manifest.main !== 'string' || !manifest.main) {
    throw new Error('Missing package.json main in ' + directory);
  }
  const entry = path.resolve(directory, manifest.main);
  const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(entry));
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Entry point escapes the extension folder: ' + entry);
  }
  if (fs.lstatSync(entry).isSymbolicLink() || !fs.statSync(entry).isFile()) {
    throw new Error('Entry point must be a regular, non-symlink file: ' + entry);
  }
  const ext = path.extname(entry);
  if (ext !== '.cjs' && (ext !== '.js' || manifest.type === 'module')) {
    throw new Error('Unsupported non-CommonJS entry point; refusing to patch: ' + entry);
  }
  return entry;
}

function splitSource(source) {
  // Preserve BOM/shebang and keep strict mode effective despite the new try block.
  const preamble = /^(?:\uFEFF)?(?:#![^\n]*\n)?/.exec(source)[0];
  const body = source.slice(preamble.length);
  if (!body.includes(MARKER)) return { preamble, original: body, patched: false };
  const lines = body.split('\n', 2);
  const prefixLength = lines[0].length + (lines[1] || '').length + 2;
  const match = /^(?:"use strict";)?try\{require\(("(?:\\.|[^"\\])*")\);\}catch\(e\)\{try\{console\.error\("\[cline-undici-guard\] load failed:",e&&e\.message\);\}catch\(_\)\{\}\}\r?$/.exec(lines[1] || '');
  if (lines[0].replace(/\r$/, '') !== MARKER || !match || body.slice(prefixLength).includes(MARKER)) {
    throw new Error('Unrecognized patch layout. Refusing to alter the entry file.');
  }
  return { preamble, original: body.slice(prefixLength), patched: true, guard: JSON.parse(match[1]) };
}

function inspect(target, options) {
  const entry = entryPath(target);
  const current = fs.readFileSync(entry);
  const source = current.toString('utf8');
  if (!Buffer.from(source).equals(current)) throw new Error('Entry is not valid UTF-8: ' + entry);
  const parts = splitSource(source);
  const original = Buffer.from(parts.preamble + parts.original);
  const backup = entry + '.orig-bak';
  const hasBackup = fs.existsSync(backup);
  const status = !parts.patched ? 'NOT PATCHED'
    : parts.guard === GUARD_PATH.replace(/\\/g, '/') ? 'PATCHED' : 'STALE GUARD PATH';
  if (options.status) {
    console.log(status + ': ' + entry + (hasBackup ? ' (backup present)' : ' (no backup)'));
    return null;
  }
  if (hasBackup) {
    if (fs.lstatSync(backup).isSymbolicLink() || !fs.readFileSync(backup).equals(original)) {
      throw new Error('Backup differs from the unpatched entry; refusing to overwrite either file: ' + backup);
    }
  } else if (parts.patched) {
    throw new Error('Patched entry has no original backup: ' + backup);
  }
  if (options.restore) {
    return { entry, backup, current, desired: original, action: parts.patched ? 'Restored' : 'Already unpatched', hasBackup };
  }
  const guardRef = JSON.stringify(GUARD_PATH.replace(/\\/g, '/'));
  const strict = /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*(['"])use strict\1\s*(?:;|\r?\n|$)/.test(parts.original);
  const injection = MARKER + '\n' + (strict ? '"use strict";' : '') + 'try{require(' + guardRef +
    ');}catch(e){try{console.error("[cline-undici-guard] load failed:",e&&e.message);}catch(_){}}\n';
  const desired = Buffer.from(parts.preamble + injection + parts.original);
  return { entry, backup, current, desired, hasBackup,
    action: current.equals(desired) ? 'Already patched (no change)' : parts.patched ? 'Re-pointed patch' : 'Patched' };
}

function atomicWrite(file, contents) {
  const temp = file + '.' + process.pid + '.tmp';
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temp, 'wx', fs.statSync(file).mode & 0o777);
    created = true;
    fs.writeFileSync(fd, contents);
    fs.fchmodSync(fd, fs.statSync(file).mode & 0o777);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created && fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function checkRuntime() {
  // An isolated process verifies the actual patch without logging a guard activation.
  const result = spawnSync(process.execPath, ['-e',
    'require(' + JSON.stringify(path.join(__dirname, 'patch-undici.cjs')) + ');' +
    'if (!globalThis.__OLLAMA_TIMEOUT_FIX__?.loaded) process.exit(1);'],
  { encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0) {
    throw new Error('Patch runtime check failed. Install dependencies with npm ci in ' + __dirname +
      '\n' + (result.stderr || result.error || 'Guard did not initialize.'));
  }
}

function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) { console.log(HELP); return; }
  // Validate all targets before changing any of them.
  const plans = discover(options).map((target) => inspect(target, options)).filter(Boolean);
  if (options.status) return;
  if (!options.restore && !options.dryRun) {
    if (!fs.existsSync(GUARD_PATH)) throw new Error('Guard file missing: ' + GUARD_PATH);
    checkRuntime();
  }
  for (const plan of plans) {
    const { entry, backup, current, desired, hasBackup, action } = plan;
    if (!options.dryRun && !current.equals(desired)) {
      if (!fs.readFileSync(entry).equals(current)) throw new Error('Entry changed during patching: ' + entry);
      if (!options.restore && !hasBackup) fs.copyFileSync(entry, backup, fs.constants.COPYFILE_EXCL);
      atomicWrite(entry, desired);
      if (!fs.readFileSync(entry).equals(desired)) throw new Error('Verification failed: ' + entry);
    }
    console.log((options.dryRun ? '[dry-run] ' : '') + action + ': ' + entry);
  }
  if (!options.dryRun) {
    console.log('Reload VS Code: Command Palette (Cmd+Shift+P on macOS) > Developer: Reload Window.');
    if (!options.restore) console.log('Verify a new ok=true AND marker=true entry in ' + path.join(__dirname, 'cline-patch-log.txt'));
  }
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error('[cline-patch] ' + error.message);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs, compareVersions, splitSource };