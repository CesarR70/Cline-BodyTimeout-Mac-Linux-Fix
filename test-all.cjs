'use strict';
// Spawns test-run.cjs in fresh child processes with the patch preloaded.
const { spawnSync } = require('child_process');
const path = require('path');

function run(mode, bodyTimeoutMs) {
  const env = { ...process.env };
  if (bodyTimeoutMs !== undefined) env.OLLAMA_FIX_BODY_TIMEOUT_MS = String(bodyTimeoutMs);
  delete env.OLLAMA_FIX_HOSTS;
  delete env.OLLAMA_FIX_DEBUG;
  console.log(`\n===== mode=${mode} bodyTimeout=${bodyTimeoutMs} =====`);
  const r = spawnSync(process.execPath,
    ['--require', path.join(__dirname, 'patch-undici.cjs'), path.join(__dirname, 'test-run.cjs'), mode],
    { env, encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status;
}

const a = run('timeout4000', 4000); // must TIME OUT after ~4s  (proves our Agent governs)
const b = run('timeout0', 0);        // must SURVIVE the 15s stall (proves fix works)
console.log(`\nexit codes: timeout4000=${a} timeout0=${b}`);
process.exit(a === 0 && b === 0 ? 0 : 1);
