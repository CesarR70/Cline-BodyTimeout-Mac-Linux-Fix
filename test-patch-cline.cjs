'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test } = require('node:test');
const { compareVersions } = require('./patch-cline.cjs');

const MARKER = '/* CLINE-UNDICI-GUARD:INJECT */';
const ORIGINAL = '"use strict";\r\nmodule.exports = 42;\r\n';

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-patch-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, process.platform === 'win32' ? 'patch with spaces' : 'patch with spaces and "quotes"');
  fs.mkdirSync(repo);
  for (const name of ['patch-cline.cjs', 'cline-patch.sh', 'cline-undici-guard.cjs', 'patch-undici.cjs', 'package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(repo, name));
  }
  fs.symlinkSync(path.join(__dirname, 'node_modules'), path.join(repo, 'node_modules'), 'junction');
  const root = path.join(temp, 'extensions');
  fs.mkdirSync(root);
  return { temp, repo, root };
}

function extension(f, version = '4.1.17', main = './extension.js', extra = {}, source = ORIGINAL) {
  const directory = path.join(f.root, 'saoudrizwan.claude-dev-' + version + '-darwin-arm64');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: 'claude-dev', publisher: 'saoudrizwan', version, main, ...extra,
  }));
  const entry = path.resolve(directory, main);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, source, { mode: 0o640 });
  return { directory, entry, backup: entry + '.orig-bak' };
}

function run(f, args = [], expected = 0) {
  const result = spawnSync(process.execPath, [path.join(f.repo, 'patch-cline.cjs'), '--extensions-dir', f.root, ...args], {
    encoding: 'utf8', timeout: 20000, cwd: f.temp,
  });
  assert.equal(result.status, expected, result.stdout + result.stderr + (result.error || ''));
  return result.stdout + result.stderr;
}

test('preview/status do not write; apply is idempotent; restore is byte-exact', (t) => {
  const f = fixture(t);
  const e = extension(f);
  assert.match(run(f, ['--dry-run']), /\[dry-run\] Patched/);
  assert.equal(fs.readFileSync(e.entry, 'utf8'), ORIGINAL);
  assert.equal(fs.existsSync(e.backup), false);
  assert.match(run(f, ['--status']), /NOT PATCHED/);
  assert.match(run(f), /Patched:/);
  assert.equal(fs.readFileSync(e.backup, 'utf8'), ORIGINAL);
  const patched = fs.readFileSync(e.entry, 'utf8');
  assert.equal(patched.split(MARKER).length, 2);
  if (process.platform !== 'win32') assert.equal(fs.statSync(e.entry).mode & 0o777, 0o640);
  assert.match(run(f), /Already patched/);
  assert.equal(fs.readFileSync(e.entry, 'utf8'), patched);
  assert.match(run(f, ['--status']), /PATCHED:.*backup present/);
  const loaded = spawnSync(process.execPath, ['-e', 'if(require(' + JSON.stringify(e.entry) + ')!==42)process.exit(1)'], { encoding: 'utf8' });
  assert.equal(loaded.status, 0, loaded.stderr);
  const log = JSON.parse(fs.readFileSync(path.join(f.repo, 'cline-patch-log.txt'), 'utf8').trim());
  assert.equal(log.ok, true);
  assert.equal(log.marker, true);
  assert.match(run(f, ['--restore', '--dry-run']), /\[dry-run\] Restored/);
  assert.equal(fs.readFileSync(e.entry, 'utf8'), patched);
  // Restore does not need undici or the guard.
  fs.unlinkSync(path.join(f.repo, 'node_modules'));
  fs.unlinkSync(path.join(f.repo, 'cline-undici-guard.cjs'));
  assert.match(run(f, ['--restore']), /Restored:/);
  assert.equal(fs.readFileSync(e.entry, 'utf8'), ORIGINAL);
  assert.match(run(f, ['--restore']), /Already unpatched/);
});

test('select newest manifest version (not platform suffix); ignore obsolete versions; reapply after update', (t) => {
  const f = fixture(t);
  const old = extension(f, '4.9.0');
  const newest = extension(f, '4.10.0', './dist/extension.cjs');
  const obsolete = extension(f, '5.0.0');
  fs.writeFileSync(path.join(f.root, '.obsolete'), JSON.stringify({ [path.basename(obsolete.directory)]: true }));
  run(f);
  assert.equal(fs.existsSync(old.backup), false);
  assert.equal(fs.existsSync(obsolete.backup), false);
  assert.equal(fs.readFileSync(newest.backup, 'utf8'), ORIGINAL);
  const updated = extension(f, '4.11.0');
  assert.match(run(f), /4\.11\.0/);
  assert.equal(fs.readFileSync(updated.backup, 'utf8'), ORIGINAL);
});

test('sort prerelease versions numerically and prefer stable over its prerelease', () => {
  const versions = ['4.1.0-beta.2', '4.1.0', '4.1.0-beta.10', '4.0.9'];
  const result = versions.map((version) => ({ version, directory: version })).sort(compareVersions);
  assert.deepEqual(result.map((item) => item.version), ['4.1.0', '4.1.0-beta.10', '4.1.0-beta.2', '4.0.9']);
});

test('relocating the repository replaces only the injection and keeps the original backup', (t) => {
  const f = fixture(t);
  const e = extension(f);
  run(f);
  const moved = f.repo + ' moved';
  fs.renameSync(f.repo, moved);
  f.repo = moved;
  assert.match(run(f, ['--status']), /STALE GUARD PATH/);
  assert.match(run(f), /Re-pointed patch/);
  assert.equal(fs.readFileSync(e.entry, 'utf8').split(MARKER).length, 2);
  assert.equal(fs.readFileSync(e.backup, 'utf8'), ORIGINAL);
  run(f, ['--restore']);
  assert.equal(fs.readFileSync(e.entry, 'utf8'), ORIGINAL);
});

test('legacy two-line injection is upgraded without changing the original bundle', (t) => {
  const f = fixture(t);
  const e = extension(f);
  fs.copyFileSync(e.entry, e.backup);
  fs.writeFileSync(e.entry, MARKER + '\ntry{require("C:/old/cline-undici-guard.cjs");}catch(e){try{console.error("[cline-undici-guard] load failed:",e&&e.message);}catch(_){}}\n' + ORIGINAL);
  run(f);
  run(f, ['--restore']);
  assert.equal(fs.readFileSync(e.entry, 'utf8'), ORIGINAL);
});

test('BOM/shebang survives patch/restore and strict mode remains effective', (t) => {
  const f = fixture(t);
  const source = '#!/usr/bin/env node\n"use strict";\nmodule.exports = (function(){return this;})();\n';
  const e = extension(f, '4.1.17', './extension.cjs', {}, source);
  run(f);
  assert.ok(fs.readFileSync(e.entry, 'utf8').startsWith('#!/usr/bin/env node\n' + MARKER));
  const loaded = spawnSync(process.execPath, ['-e', 'if(require(' + JSON.stringify(e.entry) + ')!==undefined)process.exit(1)'], { encoding: 'utf8' });
  assert.equal(loaded.status, 0, loaded.stderr);
  run(f, ['--restore']);
  assert.equal(fs.readFileSync(e.entry, 'utf8'), source);
  fs.writeFileSync(e.entry, '\uFEFF' + ORIGINAL);
  fs.unlinkSync(e.backup);
  run(f);
  run(f, ['--restore']);
  assert.equal(fs.readFileSync(e.entry, 'utf8'), '\uFEFF' + ORIGINAL);
});

test('do not impose strict mode on a non-strict bundle', (t) => {
  const f = fixture(t);
  const e = extension(f, '4.1.17', './extension.js', {}, 'module.exports = (function(){return this === globalThis;})();\n');
  run(f);
  const loaded = spawnSync(process.execPath, ['-e', 'if(require(' + JSON.stringify(e.entry) + ')!==true)process.exit(1)'], { encoding: 'utf8' });
  assert.equal(loaded.status, 0, loaded.stderr);
});

test('default discovery handles multiple roots and validates all before writing', (t) => {
  const f = fixture(t);
  const stable = extension({ root: path.join(f.temp, '.vscode/extensions') });
  extension({ root: path.join(f.temp, '.vscode-insiders/extensions') }, '4.1.17', './extension.js', { type: 'module' });
  const invoke = () => spawnSync(process.execPath, [path.join(f.repo, 'patch-cline.cjs')], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, HOME: f.temp, USERPROFILE: f.temp },
  });
  const failure = invoke();
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /non-CommonJS/);
  assert.equal(fs.existsSync(stable.backup), false);
  const insiders = extension({ root: path.join(f.temp, '.vscode-insiders/extensions') });
  const success = invoke();
  assert.equal(success.status, 0, success.stderr);
  assert.equal(fs.existsSync(stable.backup), true);
  assert.equal(fs.existsSync(insiders.backup), true);
});

test('refuse conflicting backups, missing backups and malformed injections', (t) => {
  const f = fixture(t);
  const e = extension(f);
  fs.writeFileSync(e.backup, 'wrong version');
  assert.match(run(f, [], 1), /Backup differs/);
  assert.equal(fs.readFileSync(e.entry, 'utf8'), ORIGINAL);
  fs.unlinkSync(e.backup);
  run(f);
  const patched = fs.readFileSync(e.entry, 'utf8');
  fs.unlinkSync(e.backup);
  assert.match(run(f, ['--restore'], 1), /no original backup/);
  assert.equal(fs.readFileSync(e.entry, 'utf8'), patched);
  fs.writeFileSync(e.entry, MARKER + '\nnot a recognized guard\n' + ORIGINAL);
  assert.match(run(f, [], 1), /Unrecognized patch layout/);
});

test('missing dependencies fail before creating a backup; guard logs failure honestly', (t) => {
  const f = fixture(t);
  const e = extension(f);
  fs.unlinkSync(path.join(f.repo, 'node_modules'));
  assert.match(run(f, [], 1), /runtime check failed/);
  assert.equal(fs.existsSync(e.backup), false);
  assert.equal(fs.readFileSync(e.entry, 'utf8'), ORIGINAL);
  spawnSync(process.execPath, [path.join(f.repo, 'cline-undici-guard.cjs')]);
  const log = JSON.parse(fs.readFileSync(path.join(f.repo, 'cline-patch-log.txt'), 'utf8').trim());
  assert.equal(log.ok, false);
  assert.equal(log.marker, false);
});

test('reject unsupported ESM, wrong publisher and escaped entry paths', (t) => {
  const f = fixture(t);
  const e = extension(f, '4.1.17', './extension.js', { type: 'module' });
  assert.match(run(f, [], 1), /non-CommonJS/);
  extension(f, '4.1.17', './extension.js', { publisher: 'someone-else' });
  assert.match(run(f, [], 1), /Not a Cline extension/);
  extension(f, '4.1.17', '../outside.js');
  assert.match(run(f, [], 1), /escapes/);
  assert.equal(fs.existsSync(e.backup), false);
});

test('reject symlink entry paths', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  extension(f, '4.1.17', '../outside.js');
  const e = extension(f);
  fs.unlinkSync(e.entry);
  fs.symlinkSync(path.join(f.root, 'outside.js'), e.entry);
  assert.match(run(f, [], 1), /escapes|non-symlink/);
  assert.equal(fs.existsSync(e.backup), false);
});

test('report missing installations and invalid arguments without writing', (t) => {
  const f = fixture(t);
  assert.match(run(f, [], 1), /No Cline installation found/);
  assert.match(run(f, ['--bogus'], 1), /Unknown option/);
  assert.match(run(f, ['--status', '--restore'], 1), /cannot be combined/);
  assert.match(run(f, ['--extension-dir'], 1), /requires a path/);
  assert.match(run(f, ['--help']), /Usage:/);
});

test('Bash launcher works from another directory with quoted paths, without npm when dependencies exist', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  const e = extension(f);
  const bin = path.join(f.temp, 'bin');
  fs.mkdirSync(bin);
  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/bash\nexec ' + quote(process.execPath) + ' "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/bash\necho "npm must not run" >&2\nexit 99\n', { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
  const invoke = (args) => {
    const result = spawnSync('/bin/bash', [path.join(f.repo, 'cline-patch.sh'), '--extension-dir', path.relative(f.temp, e.directory), ...args], {
      cwd: f.temp, env, encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  assert.match(invoke(['--dry-run']), /\[dry-run\]/);
  assert.equal(fs.existsSync(e.backup), false);
  assert.match(invoke([]), /Patched:/);
  assert.match(invoke([]), /Already patched/);
  fs.unlinkSync(path.join(f.repo, 'node_modules'));
  assert.match(invoke(['--status']), /PATCHED:/);
  assert.match(invoke(['--restore']), /Restored:/);
  assert.equal(fs.readFileSync(e.entry, 'utf8'), ORIGINAL);
});

test('Bash dependency setup uses locked install flags and never patches after npm failure', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  const e = extension(f);
  fs.unlinkSync(path.join(f.repo, 'node_modules'));
  const bin = path.join(f.temp, 'bin');
  fs.mkdirSync(bin);
  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/bash\nexec ' + quote(process.execPath) + ' "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/bash\nexit 42\n', { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
  const invoke = (args) => spawnSync('/bin/bash', [path.join(f.repo, 'cline-patch.sh'), '--extension-dir', e.directory, ...args], {
    cwd: f.temp, env, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(invoke(['--dry-run']).status, 0);
  assert.equal(invoke(['--status']).status, 0);
  assert.equal(invoke([]).status, 42);
  assert.equal(fs.existsSync(e.backup), false);
  assert.equal(fs.readFileSync(e.entry, 'utf8'), ORIGINAL);
  // Simulate npm's install without a network dependency in the unit suite.
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/bash\nset -e\n' +
    '[ "$*" = "ci --ignore-scripts --no-audit --no-fund" ]\n' +
    '[ "$PWD" = ' + quote(fs.realpathSync(f.repo)) + ' ]\n' +
    'ln -s ' + quote(path.join(__dirname, 'node_modules')) + ' node_modules\n');
  const success = invoke([]);
  assert.equal(success.status, 0, success.stdout + success.stderr);
  assert.equal(fs.existsSync(e.backup), true);
});