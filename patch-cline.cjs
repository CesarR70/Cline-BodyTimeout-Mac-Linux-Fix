'use strict';
/**
 * patch-cline.cjs
 * ---------------
 * Injects cline-undici-guard.cjs into the top of Cline's extension entry
 * file (the root extension.js, which loads both the "next" and "legacy"
 * bundles). Idempotent - safe to run again.
 *
 *   Usage:  node C:\ollama-timeout-fix\patch-cline.cjs
 *
 * After Cline updates to a new version, its files are replaced - just run
 * this script again, then reload the VS Code window.
 */

const fs = require('fs');
const path = require('path');

const PUBLISHER_PREFIX = 'saoudrizwan.claude-dev-';
const GUARD_PATH = path.join(__dirname, 'cline-undici-guard.cjs');
const MARKER = '/* CLINE-UNDICI-GUARD:INJECT */';

function main() {
  if (!fs.existsSync(GUARD_PATH)) {
    console.error('Guard file missing: ' + GUARD_PATH);
    process.exit(1);
  }

  const home = process.env.USERPROFILE || process.env.HOME || '';
  const extRoot = path.join(home, '.vscode', 'extensions');
  const dirs = fs.readdirSync(extRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith(PUBLISHER_PREFIX))
    .map((d) => d.name);

  if (dirs.length === 0) {
    console.error('No Cline extension found in ' + extRoot);
    process.exit(1);
  }

  // Newest version first (compare numeric x.y.z suffixes).
  dirs.sort((a, b) => {
    const pa = a.slice(PUBLISHER_PREFIX.length).split('.').map(Number);
    const pb = b.slice(PUBLISHER_PREFIX.length).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
    }
    return 0;
  });

  const newest = dirs[0];
  const entryFile = path.join(extRoot, newest, 'extension.js');
  if (!fs.existsSync(entryFile)) {
    console.error('Entry file not found: ' + entryFile);
    process.exit(1);
  }

  const src = fs.readFileSync(entryFile, 'utf8');
  if (src.includes(MARKER)) {
    console.log('Already patched (no change): ' + entryFile);
    return;
  }

  const backup = entryFile + '.orig-bak';
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(entryFile, backup);
    console.log('Backup created: ' + backup);
  }

  // Forward slashes in the require() path (works on Windows too).
  const guardRef = GUARD_PATH.replace(/\\/g, '/');
  const inject =
    MARKER + '\n' +
    'try{require("' + guardRef + '");}catch(e){try{console.error("[cline-undici-guard] load failed:",e&&e.message);}catch(_){}}\n';

  fs.writeFileSync(entryFile, inject + src);
  console.log('Patched: ' + entryFile);
  console.log('Now reload the window: Command Palette (Ctrl+Shift+P) > "Developer: Reload Window"');
}

main();
