'use strict';
/**
 * cline-undici-guard.cjs
 * ----------------------
 * Loaded from the very top of Cline's extension entry file (injected by
 * patch-cline.cjs). Running it:
 *
 *   1. Registers a zero-timeout undici Agent as the global dispatcher on the
 *      shared globalThis[Symbol.for("undici.globalDispatcher.1")] slot, so
 *      Cline's BUNDLED undici (which checks that slot at init) keeps ours
 *      instead of installing its default 300 s-bodyTimeout Agent.
 *   2. Wraps globalThis.fetch so every request to Ollama (port 11434 or a
 *      host in OLLAMA_FIX_HOSTS) is guaranteed to go through that Agent.
 *
 * This kills:  BodyTimeoutError: Body Timeout Error (UND_ERR_BODY_TIMEOUT)
 *
 * It also appends one JSON line per load to cline-patch-log.txt next to this
 * file so we can prove it ran inside the VS Code process that hosts Cline.
 *
 * Fail-safe: if anything here throws, Cline simply continues unpatched.
 */

const fs = require('fs');
const path = require('path');

function log(entry) {
  try {
    fs.appendFileSync(
      path.join(__dirname, 'cline-patch-log.txt'),
      JSON.stringify(entry) + '\n'
    );
  } catch (_) { /* best effort */ }
}

try {
  // The actual patch (undici Agent + global fetch wrapper). Resolves its own
  // undici from C:\cline-timeout-fix\node_modules.
  require('./patch-undici.cjs');

  log({
    ts: new Date().toISOString(),
    pid: process.pid,
    ok: true,
    marker: Boolean(globalThis.__OLLAMA_TIMEOUT_FIX__),
    agent: globalThis.__OLLAMA_TIMEOUT_FIX__ || null,
    argv: (process.argv.join(' ') || '').slice(0, 400),
  });
} catch (e) {
  log({
    ts: new Date().toISOString(),
    pid: process.pid,
    ok: false,
    error: String((e && e.message) || e).slice(0, 300),
  });
  try { console.error('[cline-undici-guard] FAILED (Cline continues unpatched):', (e && e.message) || e); } catch (_) {}
}
