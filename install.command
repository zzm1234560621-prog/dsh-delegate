#!/bin/sh
# One-click installer for dsh-delegate on macOS: double-click this file in Finder.
#
# Terminal opens and runs install.sh from this folder; the window stays open on the
# result. Flags work the same when run from a terminal:
#   ./install.command --dry-run
#
# First run blocked by macOS ("cannot be opened" / "could not verify")? Right-click
# the file → Open, or allow it under System Settings → Privacy & Security.

cd "$(dirname "$0")" || exit 1
sh ./install.sh "$@"
status=$?

# Only wait when a person is watching (Finder opens a terminal); scripts and tests
# get the exit code straight away.
if [ -t 0 ] && [ -t 1 ]; then
  printf '\n安装结束（退出码 %s），按回车关闭窗口… ' "$status"
  read -r _
fi
exit "$status"
