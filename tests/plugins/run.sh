#!/bin/bash
# Behaviour tests of the plugins. Each test runs with HOME set to a fresh fake home directory,
# so nothing depends on (or touches) the real one.
# Usage: tests/plugins/run.sh [PLUGINS_DIR]   (default: plugins/ of this repository)
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PLUGINS=$(cd "${1:-$HERE/../../plugins}" && pwd)
NODE=(node --experimental-strip-types --no-warnings)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fail=0

# fake home: the paths the case files and hints expect to exist
new_home() {
  local h
  h=$(mktemp -d "$WORK/XXXXXX")/home/tester
  mkdir -p "$h/Projekty/ed-trade-overlay" "$h/tmp-opencode" "$h/Pobrane" "$h/oc-audyt/kopalnia" "$h/.config/opencode"
  touch "$h/CLAUDE.md" "$h/Projekty/ed-trade-overlay/README.md"
  cp "$HERE"/lessons/*.md "$h/oc-audyt/kopalnia/"
  echo "$h"
}

# plugins are imported from a copy, so a test can never write next to the source
cp "$PLUGINS/tool-input-fix/index.ts" "$WORK/tool-input-fix.ts"
cp "$PLUGINS/no-call-guard/index.ts" "$WORK/no-call-guard.ts"

run() {
  local name=$1 out
  shift
  if out=$(HOME=$(new_home) "$@" 2>&1) && ! grep -q FAIL <<<"$out"; then
    echo "PASS $name: $(tail -1 <<<"$out" | cut -c1-90)"
  else
    echo "FAIL $name"
    tail -15 <<<"$out"
    fail=1
  fi
}

run cases "${NODE[@]}" "$HERE/cases.test.mjs" "$WORK/tool-input-fix.ts" "$HERE/cases.json"
for t in hint-text loop-escalation nochanges-stop nonblockable-deliver read-first-hint; do
  run "$t" "${NODE[@]}" "$HERE/$t.test.mjs" "$WORK/tool-input-fix.ts"
done
run no-call-guard "${NODE[@]}" "$HERE/no-call-guard.test.mjs" "$WORK/no-call-guard.ts"
run no-call-guard-act env NO_CALL_GUARD=act "${NODE[@]}" "$HERE/no-call-guard.test.mjs" "$WORK/no-call-guard.ts"
exit $fail
