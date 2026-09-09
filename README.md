# Cline Body-Timeout Fix

Workaround for `terminated: BodyTimeoutError: Body Timeout Error (UND_ERR_BODY_TIMEOUT)`
while Cline waits for a slow local Ollama model. Includes a rerunnable **macOS/Linux
Bash launcher** and the original Windows launcher.

This is an unofficial patch to installed extension files, not a Cline setting.
It reuses the repository's JavaScript/undici runtime patch; it does not modify
Ollama, models, VS Code itself, or your shell startup files.

## macOS quick start

You need **Node.js 20.18.1 or newer and npm** (prefer a supported Node LTS).
The VS Code extension host also needs a compatible Node runtime; keep VS Code
up to date. Having VS Code installed does not put `node`/`npm` on your terminal's PATH.

If needed, install Node using the official installer or, if you use Homebrew:

```bash
brew install node
```

For testing, you can preview the target without changing anything:

```bash
bash "./cline-patch.sh" --dry-run
```

Then apply it:

```bash
bash "./cline-patch.sh"
```

You can run the script from any working
directory; paths with spaces are supported. No `sudo` or `chmod` is needed when
invoking it with `bash`.

The script:

1. Checks prerequisites and validates the extension target before changing files.
2. Installs the locked `undici` dependency locally with
   `npm ci --ignore-scripts --no-audit --no-fund` if missing or out of date.
   Initial setup requires network access; ordinary reruns do not reinstall it.
3. Finds the newest non-obsolete Cline version in each standard VS Code/Insiders/
   VS Code Server extension root under your home directory.
4. Reads `package.json` → `main`, verifies it is a supported CommonJS entry point,
   and checks that the patch initializes in the installer's Node runtime.
5. Keeps a byte-for-byte `.orig-bak` beside the entry file, then atomically injects
   the guard. Existing backups are never overwritten, and mismatched backups or
   unfamiliar patch layouts cause a refusal rather than a destructive guess.

**Finish by pressing Cmd+Shift+P → Developer: Reload Window** (or fully restart
VS Code). Do this when no important Cline request is in progress. The already
running extension does not pick up file changes until it reloads.

### After every Cline update

Run the **same apply command** again, then reload the window. Cline updates replace
the extension files. Rerunning on an already patched version is a no-op; backups
are kept per entry file/version. No scheduled job or startup hook is installed.

Keep this repository **and its `node_modules` folder** in place: the extension
loads the guard by absolute path. If you move/rename this repository, rerun the
script from its new location to update the injected path, then reload VS Code.
Do not delete it before restoring the patch.

## Status and verification

Check the injection on disk (does not load the guard or install dependencies):

```bash
bash "./cline-patch.sh" --status
```

After reloading VS Code and opening Cline, inspect the activation log:

```bash
node "./check-log.cjs"
```

The log is `cline-patch-log.txt` for
this checkout. Look for a **new timestamp with both `ok=true` and `marker=true`**.
An old successful entry is not proof that a newly updated extension loaded the
patch. `--status` only reports the on-disk injection; it does not prove runtime
activation or validate that all dependencies are still present.

Then retry a real Ollama task that previously failed. If there is no new successful
log entry, check VS Code's extension host logs for `[cline-undici-guard]` or
`[cline-timeout-fix]`. The log includes process arguments; inspect it before sharing.

## Custom installations, Linux, and remote development

The Bash launcher also works on Linux with Node/npm installed. It searches these
extension roots beneath your home directory:

- `.vscode/extensions`
- `.vscode-insiders/extensions`
- `.vscode-server/extensions`
- `.vscode-server-insiders/extensions`

Use `--extensions-dir` for a custom extensions root, or `--extension-dir` to
target one exact version instead of automatic newest-version selection. For
example, to explicitly target the version inspected on this Mac:

```bash
bash "./cline-patch.sh" \
  --extension-dir ".vscode/extensions/saoudrizwan.claude-dev-4.1.17"
```

These selectors also work with `--dry-run`, `--status`, and `--restore`. Use them
for portable VS Code, VSCodium, pinned older versions, or nonstandard paths.
Automatic selection patches one version **in each discovered root**, so use an
explicit selector if you only want to change one installation.

For SSH/dev containers/other remote hosts, run the script **on the host where
Cline executes**, with a persistent copy of this repository there. A Mac-local
path will not be accessible inside another machine/container.

## Restore / uninstall

```bash
bash "./cline-patch.sh" --restore
```

Then reload VS Code. The script verifies that the backup matches the current
entry with only the recognized injection removed and restores those original
bytes. The backup is retained. Restoring an already unpatched entry is a no-op.
Restoration needs Node but not npm, undici, or a working guard.

Automatic restore selects the newest non-obsolete version in each default root,
just like apply. If you previously patched other roots or older versions, restore
each with its own directory selector before deleting this repository.

If a backup is missing or mismatched, the script refuses to replace the file.
Reinstall that Cline version through VS Code to recover a clean extension rather
than copying a backup from a different version. For manual recovery, the backup
is beside the manifest's entry point with `.orig-bak` appended.

## How it works and limitations

Undici normally uses a **300-second body idle timeout** (time between response
chunks), not a limit on total generation time. A slow model can exceed that idle
interval during prefill/thinking. Headers have a separate timeout.

The injector loads the guard before Cline's CommonJS bundle. The guard:

1. Installs an undici Agent with `bodyTimeout: 0` and `headersTimeout: 0` as the
   global dispatcher, using the shared `undici.globalDispatcher.1` symbol.
2. Wraps global `fetch` so requests recognized as Ollama (port 11434 or a listed
   host) use that Agent through this repository's undici copy.
3. Writes a per-activation log; if loading fails, it logs the problem rather than
   intentionally preventing Cline from loading.

**Important caveats inherited from the original fix:**

- The dispatcher is **process-wide**, not local-provider-only. Remote providers
  and other extensions sharing that process can also be affected. Do not treat
  `OLLAMA_FIX_HOSTS` as a boundary restricting the global change.
- Zero body/headers timeouts can leave genuinely stalled requests waiting
  indefinitely. Cancel the task manually if necessary. The patch still has a
  60-second connection-establishment timeout.
- This does not override every possible SDK deadline, AbortSignal, proxy/server
  timeout, custom dispatcher, or network failure. Future Cline/undici changes can
  bypass the workaround. Verify after updates; this is not a guaranteed fix for
  all providers or all timeout errors.
- Future ESM entry points and unfamiliar injection layouts are rejected rather
  than patched blindly. Compatibility with later Cline releases must be checked.
- If the guard fails partway through initialization, some global changes may
  already have happened; restore and restart VS Code to fully reset the process.

The original upstream README reported success on Windows with Cline 4.1.16 and
Ollama 0.33.2. For this macOS port, Cline 4.1.17's manifest/entry was inspected
read-only and automated fixture/HTTP tests were run; **a real long-running model
conversation inside VS Code has not been verified here**.

### Optional environment variables

| Variable | Default | Meaning |
|---|---|---|
| `OLLAMA_FIX_HOSTS` | `127.0.0.1,localhost` | Comma-separated hosts explicitly routed through the wrapped fetch; setting it replaces this list |
| `OLLAMA_FIX_BODY_TIMEOUT_MS` | `0` | Body idle cap in milliseconds; e.g. `3600000` for one hour |
| `OLLAMA_FIX_HEADERS_TIMEOUT_MS` | `0` | Headers wait cap in milliseconds |

These are read from the **VS Code extension host's environment when Cline loads**,
not stored by the installer. Setting them only while running the patch script
does not configure an already-running VS Code, and macOS Dock launches do not
normally inherit exports from your terminal. Defaults require no environment
setup. Use nonnegative millisecond integers within the signed 32-bit range.

## Windows

The original `Cline-Body-Timeout-Fix/cline-patch.bat` file
remains available in the repository (use its actual Windows checkout path there).
Install Node/npm and run `npm ci --ignore-scripts --no-audit --no-fund` from that
checkout once before using the batch file. The shared JavaScript injector also
accepts the options above when invoked directly with Node. Reload with
Ctrl+Shift+P → Developer: Reload Window. The Bash port does not require Windows.

## Tests and files

From this checkout:

```bash
npm --prefix "/Users/yourUsername/yourDownloadFolder/Cline-Body-Timeout-Fix" test
```

The installer tests create temporary fake extensions and cover idempotence,
version selection/updates, custom entry paths, folder moves and quoting, backups,
restoration, strict mode, legacy injections, failure logging, and the Bash wrapper.
They never patch your real extension. Streaming tests run a loopback HTTP server:
a 4-second body timeout must fail during a 15-second stall; zero must survive it.
They use Node's built-in test/assert modules and the existing undici dependency.

| File (beneath this checkout) | Purpose |
|---|---|
| `cline-patch.sh` | macOS/Linux setup and reapply launcher |
| `cline-patch.bat` | Original Windows launcher |
| `patch-cline.cjs` | Cross-platform discovery, injection, status, restore |
| `cline-undici-guard.cjs` | Runtime patch loader and activation log |
| `patch-undici.cjs` | Existing Agent/global fetch patch |
| `check-log.cjs` | Readable activation-log viewer |
| `test-patch-cline.cjs` | Isolated installer/launcher regression tests |
| `test-all.cjs`, `test-run.cjs` | Real stalled-response tests |
