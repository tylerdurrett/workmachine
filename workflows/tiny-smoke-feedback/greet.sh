#!/usr/bin/env sh
set -eu

# tiny-smoke-feedback's one script step: greet a name into a file, optionally
# threading the reviewer's revision feedback into the greeting so a re-run after
# request_changes legitimately differs from the first dispatch.
#
# Invoked by the script executor as
# `sh greet.sh <name> <output-path> <feedback>` with the run directory as cwd,
# so the output path it receives (artifacts/greeting.txt) is relative to the run
# dir, whose artifacts/ subdir createRunDir already made. On the first dispatch
# the resolver substitutes {{feedback.note}} to an empty string, so <feedback>
# is empty and the revision line is omitted; after request_changes it carries
# the reviewer's note. Uses printf, not echo, so the bytes are deterministic
# across shells.

name="$1"
out="$2"
feedback="${3:-}"

printf 'Hello, %s!\n' "$name" > "$out"
if [ -n "$feedback" ]; then
  printf 'Revision: %s\n' "$feedback" >> "$out"
fi
