#!/usr/bin/env bash
# End-to-end test without a real model: install → self-test → an `opencode run` session against a mock
# OpenAI server (tests/mock_llm.py, :8080) → check the traces of every plugin → uninstall.
# Runs in a clean, temporary $HOME. CI or container only — it does not touch the real configuration.
set -uo pipefail

if [ "${CI:-}" != true ] && [ ! -f /.dockerenv ] && [ ! -f /run/.containerenv ]; then
  echo "e2e.sh: run it in CI or in a container (CI=true forces it)" >&2; exit 2
fi
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HOME; HOME="$(mktemp -d)"
# GitHub runners set XDG_CONFIG_HOME etc. — everything must live in the temporary $HOME
unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME
export PATH="$HOME/bin:$PATH"
ERRORS=0
check() { # check "opis" polecenie…
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  ok   $desc"; else echo "  FAIL $desc"; ERRORS=$((ERRORS + 1)); fi
}

python3 "$REPO/tests/mock_llm.py" 8080 & MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
sleep 1

echo "== instalacja"
"$REPO/install.sh" -y | tail -3
check "opencode.json generated for the mock" grep -q '"local/mock"' "$HOME/.config/opencode/opencode.json"
check "opencode.json ma enabled_providers i small_model" grep -q '"small_model": "local/mock"' "$HOME/.config/opencode/opencode.json"
check "freecode --check" freecode --check
check "freecode --version" bash -c 'freecode --version | grep -q "a wrapper around opencode 2\.0\.24"'
check "install.sh --check" bash -c "'$REPO/install.sh' --check | grep -q 'Autotest: OK'"

echo "== palace note for the session directory"
PY="$(head -1 "$HOME/bin/palace-context" | sed 's/^#!//')"
"$PY" -I -c "
from mempalace import mcp_server as m
m.tool_add_drawer(wing='projects', room='decisions', content='demo — project in ~/demo, PALACE-MARKER. DECISION: text files always in UTF-8, results rounded to 2 places.')" >/dev/null 2>&1

echo "== freecode run session (2× read error, then an answer)"
mkdir -p "$HOME/demo" && cd "$HOME/demo" || exit 1
FREECODE_YES=1 timeout 120 freecode run "read the file does-not-exist.txt" > /tmp/oc-run.out 2>&1; RC=$?
cd "$REPO" || exit 1
L="$HOME/.mempalace/hook_state"
check "freecode run kod 0" test "$RC" = 0
check "mock answer arrived" grep -q "The end." /tmp/oc-run.out
check "tool-input-fix loaded" grep -q "\] loaded" "$L/tool_input_fix.log"
check "auto-backup loaded" grep -q "auto-backup loaded" "$L/tool_input_fix.log"
check "error-hook logged the errors" bash -c "grep -h 'File not found' '$HOME'/mempalace/audit/errors_*.jsonl | wc -l | grep -qx 2"
check "lesson-draft wrote a draft" grep -q "error pattern" "$HOME/tmp-opencode/lessons-draft.md"
check "palace-context appended a note" grep -q "appended [0-9]* chars" "$L/palace_context.log"
check "note reached the model" grep -q '"palace": true' /tmp/mock.log

echo "== freecode odmawia przy uszkodzonym configu"
cp "$HOME/.config/opencode/opencode.json" /tmp/oc-ok.json
echo '{"model":' > "$HOME/.config/opencode/opencode.json"
check "freecode run odmawia" bash -c '! FREECODE_YES=1 freecode run x'
cp /tmp/oc-ok.json "$HOME/.config/opencode/opencode.json"

echo "== deinstalacja"
"$REPO/install.sh" --uninstall >/dev/null
check "freecode removed" test ! -e "$HOME/bin/freecode"
check "plugins removed" test ! -e "$HOME/.config/opencode/plugins/lesson-draft/index.ts"
check "opencode.json removed" test ! -e "$HOME/.config/opencode/opencode.json"

if [ "$ERRORS" != 0 ]; then
  echo "--- opencode run:"; tail -20 /tmp/oc-run.out
  echo "--- plugin logs:"; tail -n 5 "$L"/*.log 2>/dev/null
  echo "e2e: $ERRORS error(s)"; exit 1
fi
echo "e2e: OK"
