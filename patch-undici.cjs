/**
 * patch-undici.cjs
 * ----------------
 * Core patch that stops long local LLM streams (Cline <-> Ollama) from
 * being aborted by undici's default 300-second body/headers timeouts:
 *
 *     terminated: BodyTimeoutError: Body Timeout Error (UND_ERR_BODY_TIMEOUT)
 *
 * What it does:
 *   1. Creates an undici Agent with NO body/headers timeout and registers it
 *      as the global dispatcher (stored on globalThis under the shared
 *      "undici.globalDispatcher.1" symbol, so undici-based fetch
 *      implementations pick it up).
 *   2. Wraps globalThis.fetch so that ANY request heading to Ollama
 *      (host:port on port 11434, or a host listed in OLLAMA_FIX_HOSTS)
 *      is explicitly dispatched through that Agent. This guarantees the fix
 *      regardless of which undici copy (Node built-in vs. bundled in an
 *      extension) actually performs the request.
 *
 * Tunables (environment variables):
 *   OLLAMA_FIX_HOSTS             comma-separated hostnames to always treat as
 *                                Ollama even when not on port 11434
 *                                (default: "127.0.0.1,localhost")
 *   OLLAMA_FIX_BODY_TIMEOUT_MS   bodyTimeout in ms (default: 0 = never time out)
 *   OLLAMA_FIX_HEADERS_TIMEOUT_MS headersTimeout in ms (default: 0 = never time out)
 *
 * Fail-safe: if anything in here fails, it logs to the console and leaves
 * the runtime completely untouched.
 */
'use strict';

function main() {
  const hosts = (process.env.OLLAMA_FIX_HOSTS || '127.0.0.1,localhost')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const bodyTimeout = Number.isFinite(+process.env.OLLAMA_FIX_BODY_TIMEOUT_MS)
    ? (+process.env.OLLAMA_FIX_BODY_TIMEOUT_MS | 0) : 0;
  const headersTimeout = Number.isFinite(+process.env.OLLAMA_FIX_HEADERS_TIMEOUT_MS)
    ? (+process.env.OLLAMA_FIX_HEADERS_TIMEOUT_MS | 0) : 0;

  const undici = require('undici');
  const agent = new undici.Agent({
    bodyTimeout,        // 0 = disabled (infinite)
    headersTimeout,     // 0 = disabled (infinite)
    connectTimeout: 60_000,
    keepAliveTimeout: 60_000,
  });

  // 1) Global dispatcher: any undici fetch that reads the shared
  //    "undici.globalDispatcher.1" globalThis symbol will use this Agent.
  try { undici.setGlobalDispatcher(agent); } catch (_) { /* best effort */ }

  // 2) Wrap global fetch so Ollama traffic is GUARANTEED to use our Agent.
  const origFetch = globalThis.fetch;
  if (typeof origFetch !== 'function' || origFetch.__ollamaTimeoutFixPatched) return;

  const isOllamaUrl = (raw) => {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      if (u.port === '11434') return true;
      return hosts.includes(u.hostname.toLowerCase());
    } catch (_) { return false; }
  };

  // Normalize anything that is not a plain string/URL into (url, init).
  // (Node's built-in Request class is a different "copy" from this undici's
  // Request, so we flatten foreign Request objects before handing them off.)
  const normalize = (input, init) => {
    if (typeof input === 'string' || input instanceof URL) {
      return [input, init || {}];
    }
    const url = input.url || String(input);
    const merged = { ...(init || {}) };
    if (input.method) merged.method = input.method;
    if (input.headers) {
      const headers = {};
      for (const [k, v] of input.headers.entries()) headers[k] = v;
      merged.headers = headers;
    }
    if (input.signal && !merged.signal) merged.signal = input.signal;
    if (input.body && merged.body === undefined) merged.body = input.body;
    return [url, merged];
  };

  const patched = (input, init) => {
    let raw = '';
    try { raw = typeof input === 'string' ? input : (input && input.url) || ''; } catch (_) { /* ignore */ }
    if (raw && isOllamaUrl(raw)) {
      try {
        const [url, opts] = normalize(input, init);
        opts.dispatcher = agent;
        return undici.fetch(url, opts);
      } catch (e) {
        // Fall back to the original fetch if our path misbehaves.
        return origFetch(input, init);
      }
    }
    return origFetch(input, init);
  };
  patched.__ollamaTimeoutFixPatched = true;

  try {
    Object.defineProperty(globalThis, 'fetch', {
      value: patched,
      writable: true,
      configurable: true,
    });
  } catch (_) {
    globalThis.fetch = patched;
  }

  // Marker so tests (and this file's docs) can detect the patch.
  // cline-undici-guard.cjs writes the per-load proof to cline-patch-log.txt.
  globalThis.__OLLAMA_TIMEOUT_FIX__ = {
    loaded: true,
    bodyTimeout,
    headersTimeout,
    hosts,
  };
}

try {
  main();
} catch (e) {
  try {
    console.error('[ollama-timeout-fix] patch NOT applied:', (e && e.message) ? e.message : e);
  } catch (_) { /* ignore */ }
}
