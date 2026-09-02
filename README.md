# Cline Body-Timeout Fix

Stops `terminated: BodyTimeoutError: Body Timeout Error (UND_ERR_BODY_TIMEOUT)` from
killing Cline's conversations with a local Ollama model.
It should also work out of the box for LM studio, Openai, Anthropic or any other provider that works with Cline.

one edge case
If you ever run LM Studio __not__ on localhost — e.g., on another machine, on your LAN (`http://192.168.1.50:1234`) — add that hostname:
```javascript
setx OLLAMA_FIX_HOSTS "127.0.0.1,localhost,192.168.1.50"
```

**Status: verified working** (2026-08-31 — Cline 4.1.16 + Ollama 0.33.2 with
Qwen3.8 27B bf16; long thinking sessions no longer die mid-stream).

## Why this happens

Cline talks to Ollama over Node's `fetch` (undici). Undici's **default
`bodyTimeout` is 300 s**: if a streaming response goes silent for 5 minutes
(no bytes between chunks), the request is aborted mid-stream. A large local
model that is "thinking" or prefilling a big context can easily exceed that
silence — so the whole model response dies and Cline has to start over.
Neither Cline nor undici exposes a setting to change this.

## History: 
The first approach was a `NODE_OPTIONS=--require` preload applied via a
launcher .bat. It works perfectly in plain Node (see the tests in this
folder), but VS Code is a packaged Electron app and **Electron refuses to
apply `NODE_OPTIONS` (`--require`) in packaged apps**:

    ERROR:electron\shell\common\node_bindings.cc:509
    Most NODE_OPTIONs are not supported in packaged apps.

So that approach was abandoned (its launcher .bat and preload machinery
were removed from this folder).


ooh I broke it by renaming the folder because The injector bakes an __absolute path__ into Cline's `extension.js`
it is fixed now but there is 1 caveat
the zero-timeout Agent is installed as undici's __global__ dispatcher in Cline's process, so requests to *remote* providers also lose the 300 s safety cap. In practice that just means a genuinely dead connection hangs instead of failing after 5 minutes — usually a non-issue but I thought you should know.


## How the fix works now

`patch-cline.cjs` injects two lines at the very top of Cline's extension
entry file (`%USERPROFILE%\.vscode\extensions\saoudrizwan.claude-dev-<ver>\extension.js`),
which is the entry point for both the "next" and "legacy" Cline bundles:

    /* CLINE-UNDICI-GUARD:INJECT */
    try{require("C:/ollama-timeout-fix/cline-undici-guard.cjs");}catch(e){...}

When Cline's code loads in whatever process hosts it (extension host / agent
host), that guard runs **before any Cline code** and:

1. registers a **zero-timeout** undici Agent (`bodyTimeout: 0`,
   `headersTimeout: 0`) as the global dispatcher on the shared
   `globalThis[Symbol.for("undici.globalDispatcher.1")]` slot — so Cline's
   *bundled* undici keeps ours instead of installing its 300 s default;
2. wraps `globalThis.fetch` so every request to Ollama (port **11434**, or a
   host in `OLLAMA_FIX_HOSTS`) is *guaranteed* to use that Agent, whatever
   undici copy performs the request.

A pristine copy of the original entry file is kept as `extension.js.orig-bak`.
Everything is fail-safe: if the guard fails to apply, Cline continues
unpatched (same behavior as before the fix).

## Files

| File | Purpose |
|---|---|
| `patch-cline.cjs` | injector — run after every Cline update |
| `reapply-cline-patch.bat` | double-clickable wrapper around the injector (for after Cline updates) |
| `cline-undici-guard.cjs` | loaded by Cline; applies the patch + writes the log line |
| `patch-undici.cjs` | the actual patch logic (Agent + fetch wrapper), shared with the guard |
| `cline-patch-log.txt` | one JSON line per guard load — proof it ran, and in which process |
| `check-log.cjs` | readable view of the load log: `node C:\ollama-timeout-fix\check-log.cjs` |
| `test-all.cjs` / `test-run.cjs` | end-to-end tests: `node test-all.cjs` |
| `package.json` + `node_modules/` | local `undici` used by the patch |

## When / how to run the injector

- Initial setup: copy the Cline-timeout-fix folder to anywhere you like, I just put it on the C: drive.
  run the bat file 
  
- After **every Cline update** (it replaces the extension files):
  
  then reload the VS Code window. The script is idempotent — running it
  twice is safe.

  - After **moving or renaming this folder**: the path baked into Cline is absolute, so re-run the
    injector - it detects a stale path and re-points it automatically.

  You don't run it on normal startup.
  The patch is written directly into Cline's files on disk and persists across reboots/reloads

## Activating and verifying

1. `Ctrl+Shift+P` → **Developer: Reload Window** (or restart VS Code).
2. Open `cline-patch-log.txt` (or run `node C:\Cline-timeout-fix\check-log.cjs`
   for a readable view) — a new JSON line appears each time Cline loads, with
   the `argv` of the process that hosted it. The latest line must have
   `"ok":true`.
3. Use Cline with Ollama as normal. Long thinking no longer kills the stream.

## Tunables (env vars, optional)

| Variable | Default | Meaning |
|---|---|---|
| `OLLAMA_FIX_HOSTS` | `127.0.0.1,localhost` | extra hosts always routed via the no-timeout Agent |
| `OLLAMA_FIX_BODY_TIMEOUT_MS` | `0` (never) | if you want a safety cap, e.g. `3600000` = 1 h |
| `OLLAMA_FIX_HEADERS_TIMEOUT_MS` | `0` (never) | time-to-first-byte cap, same idea |

Read by the guard when Cline loads (from the environment of the VS Code
process; normally unset, defaults apply).

Tested with Cline 4.1.x. After a Cline major update, verify the entry file is still `extension.js` at the extension root (check `package.json` → `main`) before running the injector.

hopefuly cline will just include this fix in their code, then this patch will no longer be required.


## Uninstall

Restore the pristine entry file, then reload the window:

```
copy /Y "%USERPROFILE%\.vscode\extensions\saoudrizwan.claude-dev-<ver>\extension.js.orig-bak" "%USERPROFILE%\.vscode\extensions\saoudrizwan.claude-dev-<ver>\extension.js"
```

Optionally delete this folder. Nothing system-wide was changed.
