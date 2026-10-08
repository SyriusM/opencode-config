#!/usr/bin/env bash
# Test całości bez prawdziwego modelu: instalacja → autotest → sesja `opencode run` na atrapie
# serwera OpenAI (tests/atrapa.py, :8080) → sprawdzenie śladów każdej wtyczki → deinstalacja.
# Działa na czystym, tymczasowym $HOME. Tylko w CI albo w kontenerze — nie dotyka prawdziwej konfiguracji.
set -uo pipefail

if [ "${CI:-}" != true ] && [ ! -f /.dockerenv ] && [ ! -f /run/.containerenv ]; then
  echo "e2e.sh: uruchamiaj w CI albo w kontenerze (CI=true wymusza)" >&2; exit 2
fi
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HOME; HOME="$(mktemp -d)"
# runnery GitHuba ustawiają XDG_CONFIG_HOME itd. — wszystko ma siedzieć w tymczasowym $HOME
unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME
export PATH="$HOME/bin:$PATH"
BLEDY=0
sprawdz() { # sprawdz "opis" polecenie…
  local opis="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  ok   $opis"; else echo "  BŁĄD $opis"; BLEDY=$((BLEDY + 1)); fi
}

python3 "$REPO/tests/atrapa.py" 8080 & ATRAPA=$!
trap 'kill $ATRAPA 2>/dev/null' EXIT
sleep 1

echo "== instalacja"
"$REPO/install.sh" -y | tail -3
sprawdz "opencode.json wygenerowany dla atrapy" grep -q '"local/atrapa"' "$HOME/.config/opencode/opencode.json"
sprawdz "opencode.json ma enabled_providers i small_model" grep -q '"small_model": "local/atrapa"' "$HOME/.config/opencode/opencode.json"
sprawdz "freecode --sprawdz" freecode --sprawdz
sprawdz "freecode --version" bash -c 'freecode --version | grep -q "nakładka na opencode 2\.0\.24"'
sprawdz "install.sh --check" bash -c "'$REPO/install.sh' --check | grep -q 'Autotest: OK'"

echo "== notatka w palace dla katalogu sesji"
PY="$(head -1 "$HOME/bin/palace-kontekst" | sed 's/^#!//')"
"$PY" -I -c "
from mempalace import mcp_server as m
m.tool_add_drawer(wing='projects', room='decisions', content='demo — projekt w ~/demo, ZNACZNIK-PALACE. DECYZJA: pliki tekstowe zawsze w UTF-8, wyniki zaokrąglamy do 2 miejsc.')" >/dev/null 2>&1

echo "== sesja freecode run (2× błąd read, potem odpowiedź)"
mkdir -p "$HOME/demo" && cd "$HOME/demo" || exit 1
FREECODE_TAK=1 timeout 120 freecode run "przeczytaj plik nie-istnieje.txt" > /tmp/oc-run.out 2>&1; KOD=$?
cd "$REPO" || exit 1
L="$HOME/.mempalace/hook_state"
sprawdz "freecode run kod 0" test "$KOD" = 0
sprawdz "odpowiedź atrapy dotarła" grep -q "Koniec." /tmp/oc-run.out
sprawdz "tool-input-fix załadowany" grep -q "\] loaded" "$L/tool_input_fix.log"
sprawdz "auto-kopie załadowany" grep -q "auto-kopie loaded" "$L/tool_input_fix.log"
sprawdz "error-hook zapisał błędy" bash -c "grep -h 'File not found' '$HOME'/mempalace/audit/errors_*.jsonl | wc -l | grep -qx 2"
sprawdz "lesson-draft zapisał szkic" grep -q "wzorzec błędu" "$HOME/tmp-opencode/lessons-draft.md"
sprawdz "palace-kontekst dokleił notatkę" grep -q "doklejono" "$L/palace_kontekst.log"
sprawdz "notatka dotarła do modelu" grep -q '"palace": true' /tmp/atrapa.log

echo "== freecode odmawia przy uszkodzonym configu"
cp "$HOME/.config/opencode/opencode.json" /tmp/oc-ok.json
echo '{"model":' > "$HOME/.config/opencode/opencode.json"
sprawdz "freecode run odmawia" bash -c '! FREECODE_TAK=1 freecode run x'
cp /tmp/oc-ok.json "$HOME/.config/opencode/opencode.json"

echo "== deinstalacja"
"$REPO/install.sh" --uninstall >/dev/null
sprawdz "freecode usunięty" test ! -e "$HOME/bin/freecode"
sprawdz "wtyczki usunięte" test ! -e "$HOME/.config/opencode/plugins/lesson-draft/index.ts"
sprawdz "opencode.json usunięty" test ! -e "$HOME/.config/opencode/opencode.json"

if [ "$BLEDY" != 0 ]; then
  echo "--- opencode run:"; tail -20 /tmp/oc-run.out
  echo "--- logi wtyczek:"; tail -n 5 "$L"/*.log 2>/dev/null
  echo "e2e: $BLEDY błędów"; exit 1
fi
echo "e2e: OK"
