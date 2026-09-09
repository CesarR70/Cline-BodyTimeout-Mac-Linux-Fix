#!/bin/bash
# macOS ships Bash 3.2; avoid newer Bash features and GNU-only utilities.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js is required (20.18.1 or newer; a supported LTS is recommended).' >&2
  printf '%s\n' 'On macOS with Homebrew: brew install node' 'Then rerun this script. No extension files were changed.' >&2
  exit 1
fi

if ! node -e 'const [a,b,c] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && (b > 18 || (b === 18 && c >= 1))) ? 0 : 1)'; then
  printf '%s\n' 'Node.js 20.18.1 or newer is required. Update Node.js and rerun.' >&2
  exit 1
fi

# Validate arguments before installing anything. These operations must never
# install dependencies; restore must work even if node_modules was deleted.
node -e 'try { require(process.argv[1]).parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }' -- "$SCRIPT_DIR/patch-cline.cjs" "$@"
READ_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --help|-h|--dry-run|--status|--restore) READ_ONLY=true ;;
  esac
done

if [ "$READ_ONLY" = false ]; then
  # Check the target before downloading dependencies or modifying files.
  node "$SCRIPT_DIR/patch-cline.cjs" --dry-run "$@"
  if ! node -e 'const p = require("path"), root = process.argv[1]; const want = require(p.join(root,"package-lock.json")).packages["node_modules/undici"].version; if (require(p.join(root,"node_modules/undici/package.json")).version !== want) process.exit(1); require(p.join(root,"node_modules/undici"));' "$SCRIPT_DIR" >/dev/null 2>&1; then
    if ! command -v npm >/dev/null 2>&1; then
      printf '%s\n' 'npm is required to install the locked undici dependency. Install Node.js with npm, then rerun.' >&2
      exit 1
    fi
    printf '%s\n' "Installing locked dependencies in $SCRIPT_DIR ..."
    (cd -- "$SCRIPT_DIR" && npm ci --ignore-scripts --no-audit --no-fund)
  fi
fi

exec node "$SCRIPT_DIR/patch-cline.cjs" "$@"