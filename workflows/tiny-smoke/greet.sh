#!/usr/bin/env sh
set -eu

# tiny-smoke's one step: greet a name into a file.
#
# Invoked by the script executor as `sh greet.sh <name> <output-path>` with the
# run directory as cwd, so the output path it receives (artifacts/greeting.txt)
# is relative to the run dir, whose artifacts/ subdir createRunDir already made.
# Uses printf, not echo, so the bytes are deterministic across shells.

name="$1"
out="$2"

printf 'Hello, %s!\n' "$name" > "$out"
