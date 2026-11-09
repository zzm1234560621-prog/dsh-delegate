#!/bin/sh
# One-click installer for dsh-delegate (macOS / Linux).
#
#   ./install.sh                        # install everything we can find
#   ./install.sh --dry-run              # show what would change
#   ./install.sh --targets=claude-code  # only wire one client
#   ./install.sh --copy-credentials     # copy DEEPSEEK_API_KEY from DSH's store
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 18 或更高版本：https://nodejs.org/" >&2
  exit 1
fi

exec node "$here/bin/dsh-delegate.js" install "$@"
