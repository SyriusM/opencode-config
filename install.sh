#!/usr/bin/env bash
# Instalator opencode-config: wtyczki samonaprawy błędów narzędzi + kontekst z MemPalace.
#
#   ./install.sh            interaktywnie (pyta o MemPalace, port embeddingów, skrzydła)
#   ./install.sh -y         wartości domyślne, bez pytań
#   ./install.sh --check    tylko autotest istniejącej instalacji
#   ./install.sh --uninstall
#
# Istniejące pliki nadpisywane przez instalator dostają kopię *.bak-RRRRMMDD-GGMMSS.
# `~` i „cudzysłowy” w komunikatach są celowe (tekst dla człowieka, nie ścieżki ani składnia)
# shellcheck disable=SC2088,SC1111
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HOME/bin"
CFG="${XDG_CONFIG_HOME:-$HOME/.config}"   # opencode i systemd też czytają XDG_CONFIG_HOME
PLUGINS="$CFG/opencode/plugins"
CONF_DIR="$CFG/opencode-config"
CONF="$CONF_DIR/config"
MANIFEST="$CONF_DIR/installed.txt"
DEFAULT_VENV="$HOME/.local/share/opencode-config/venv"
TS="$(date +%Y%m%d-%H%M%S)"
YES=0; MODE=install

for a in "$@"; do
  case "$a" in
    -y|--yes) YES=1 ;;
    --check) MODE=check ;;
    --uninstall) MODE=uninstall ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Nieznana opcja: $a" >&2; exit 2 ;;
  esac
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
ask() { # ask "Pytanie" domyślna → echo odpowiedź
  local answer
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then echo "$2"; return; fi
  read -r -p "  $1 [$2]: " answer </dev/tty || true
  echo "${answer:-$2}"
}
yes_no() { # yes_no "Pytanie" t|n
  local def="$2" answer
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then [ "$def" = t ]; return; fi
  read -r -p "  $1 [$([ "$def" = t ] && echo T/n || echo t/N)]: " answer </dev/tty || true
  answer="${answer:-$def}"; [[ "$answer" =~ ^[tTyY] ]]
}

# ── deinstalacja ─────────────────────────────────────────────────────────────────────────────
if [ "$MODE" = uninstall ]; then
  echo "Deinstalacja opencode-config"
  # installations before 2026-10-21 kept the list as zainstalowane.txt
  [ -f "$MANIFEST" ] || [ ! -f "$CONF_DIR/zainstalowane.txt" ] || mv "$CONF_DIR/zainstalowane.txt" "$MANIFEST"
  [ -f "$MANIFEST" ] || { fail "brak $MANIFEST — nic nie wiem o instalacji"; exit 1; }
  if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user disable --now audit-retention.timer >/dev/null 2>&1 || true
  fi
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    rm -f "$f" && ok "usunięto $f"
    rmdir "$(dirname "$f")" 2>/dev/null || true
  done < "$MANIFEST"
  command -v systemctl >/dev/null && systemctl --user daemon-reload >/dev/null 2>&1 || true
  rm -f "$MANIFEST"
  ok "gotowe (dane: ~/oc-audyt, ~/.mempalace-opencode, $CONF i venv zostają — usuń ręcznie, jeśli chcesz)"
  exit 0
fi

# ── autotest ─────────────────────────────────────────────────────────────────────────────────
autotest() {
  local errors=0 py
  echo "Autotest"
  for n in tool-input-fix lesson-draft palace-context error-hook auto-backup no-call-guard danger-guard site-lint-hook; do
    if [ -f "$PLUGINS/$n/index.ts" ]; then ok "wtyczka $n"; else fail "brak wtyczki $n"; errors=$((errors+1)); fi
  done
  for f in palace-context audit-retention lesson-note agent-rule backup-copy freecode-tune site-lint; do
    if [ -x "$BIN/$f" ]; then ok "skrypt ~/bin/$f"; else fail "brak ~/bin/$f"; errors=$((errors+1)); fi
  done
  py="$(head -1 "$BIN/palace-context" | sed 's/^#!//')"
  if "$py" -I -c "import mempalace.mcp_server" 2>/dev/null; then ok "MemPalace importuje się ($py)"
  else warn "MemPalace nie importuje się w $py — palace-context i lesson-note będą milczeć"; fi
  local tmp; tmp="$(mktemp -d "$HOME/.oc-config-test.XXXX")"
  if out="$(timeout 120 "$BIN/palace-context" "$tmp" 2>&1)"; then ok "palace-context działa (wynik: ${out:-pusty — palace bez notatek dla tego katalogu})"
  else fail "palace-context padł: $out"; errors=$((errors+1)); fi
  rmdir "$tmp" 2>/dev/null || true
  if out="$(timeout 120 "$BIN/lesson-note" 2>&1)"; then ok "lesson-note: $(echo "$out" | tail -1)"
  else fail "lesson-note padł: $(echo "$out" | tail -2)"; errors=$((errors+1)); fi
  if command -v node >/dev/null && command -v npx >/dev/null; then
    for n in tool-input-fix lesson-draft palace-context error-hook auto-backup no-call-guard danger-guard site-lint-hook; do
      if npx -y esbuild "$PLUGINS/$n/index.ts" --log-level=error --outfile=/dev/null >/dev/null 2>&1; then ok "składnia $n"
      else fail "błąd składni $n"; errors=$((errors+1)); fi
    done
  else warn "brak node/npx — pomijam kontrolę składni wtyczek"; fi
  if command -v opencode >/dev/null; then ok "opencode: $(opencode --version 2>&1 | tail -1)"
  else warn "opencode nie jest zainstalowany (npm i -g @opencode/cli) — wtyczki zadziałają po instalacji"; fi
  [ "$errors" = 0 ] && echo "Autotest: OK" || echo "Autotest: $errors błędów"
  return "$errors"
}
if [ "$MODE" = check ]; then autotest; exit $?; fi

# ── instalacja ───────────────────────────────────────────────────────────────────────────────
echo "opencode-config — instalacja"
echo "1. Wymagania"
command -v python3 >/dev/null || { fail "brak python3"; exit 1; }
python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' || { fail "potrzebny Python ≥ 3.10"; exit 1; }
ok "python3 $(python3 -c 'import platform; print(platform.python_version())')"
command -v opencode >/dev/null && ok "opencode $(opencode --version 2>&1 | tail -1)" || warn "opencode nie znaleziony — zainstaluj: npm i -g @opencode/cli"

echo "2. MemPalace"
PY=""
for cand in "${MEMPALACE_PYTHON:-}" "$HOME/mempalace/.venv/bin/python" "$DEFAULT_VENV/bin/python" python3; do
  [ -n "$cand" ] || continue
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -I -c "import mempalace.mcp_server" 2>/dev/null; then PY="$(command -v "$cand")"; break; fi
done
if [ -n "$PY" ]; then
  ok "MemPalace znaleziony: $PY"
elif yes_no "MemPalace nie znaleziony. Utworzyć venv w $DEFAULT_VENV i zainstalować mempalace z PyPI?" t; then
  python3 -m venv "$DEFAULT_VENV"
  "$DEFAULT_VENV/bin/pip" install -q --upgrade pip
  "$DEFAULT_VENV/bin/pip" install -q mempalace
  PY="$DEFAULT_VENV/bin/python"
  ok "zainstalowano mempalace $("$PY" -m pip show mempalace 2>/dev/null | sed -n 's/^Version: //p')"
else
  PY="$(command -v python3)"
  warn "bez MemPalace: palace-context i lesson-note będą milczeć (wtyczki samonaprawy działają)"
fi

echo "3. Ustawienia"
# ponowna instalacja: domyślne wartości z istniejących ustawień (zmienne środowiska mają pierwszeństwo)
if [ -f "$CONF" ]; then
  : "${PALACE_EMBED_PORT:=$(sed -n 's/^PALACE_EMBED_PORT=//p' "$CONF")}"
  : "${PALACE_WINGS:=$(sed -n 's/^PALACE_WINGS=//p' "$CONF")}"
fi
echo "  Embeddingi MemPalace (standardowe porty):"
echo "    0     — wbudowane w MemPalace, bez serwera (domyślnie)"
echo "    8080  — llama.cpp llama-server (domyślny port)"
echo "    11434 — Ollama (domyślny port)"
PORT="$(ask "Port serwera embeddingów do kontroli zdrowia" "${PALACE_EMBED_PORT:-0}")"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -le 65535 ] || { warn "„$PORT” to nie port — ustawiam 0"; PORT=0; }
WINGS="$(ask "Skrzydła palace widoczne dla modelu (lista po przecinku, * = wszystkie)" "${PALACE_WINGS:-*}")"
mkdir -p "$CONF_DIR"
[ -f "$CONF" ] && cp -p "$CONF" "$CONF.bak-$TS"
cat > "$CONF" <<EOF
# opencode-config — czytane przez ~/bin/palace-context
PALACE_EMBED_PORT=$PORT
PALACE_WINGS=$WINGS
MEMPALACE_SRC=$HOME/mempalace
EOF
ok "zapisano $CONF"

echo "3b. Modele"
if [ "$PORT" != 0 ]; then
  ok "embeddingi z serwera na :$PORT — pomijam pobieranie wbudowanego modelu"
elif "$PY" -I -c "import mempalace.mcp_server" 2>/dev/null; then
  echo "  pobieranie modelu embeddingów MemPalace (jednorazowo, ~80 MB)…"
  if "$PY" -I -c "
from mempalace import mcp_server as m
c = m._get_collection(create=True)
c.query(query_texts=['rozgrzewka'], n_results=1)" >/dev/null 2>&1; then ok "model embeddingów gotowy"
  else warn "nie udało się pobrać modelu embeddingów — pobierze się przy pierwszym użyciu"; fi
fi
LLM_URL=""; LLM_MODEL=""
if command -v curl >/dev/null; then
  if m="$(curl -s -m 3 http://127.0.0.1:8080/v1/models 2>/dev/null)" && [ -n "$m" ]; then
    LLM_MODEL="$(printf '%s' "$m" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("data") or [{}])[0].get("id",""))' 2>/dev/null || true)"
    if [ -n "$LLM_MODEL" ]; then LLM_URL="http://127.0.0.1:8080/v1"; ok "llama.cpp na :8080 (model: $LLM_MODEL)"
    else warn ":8080 odpowiada, ale to nie serwer modeli (np. Open WebUI) — pomijam"; fi
  fi
  if [ -z "$LLM_URL" ] && t="$(curl -s -m 3 http://127.0.0.1:11434/api/tags 2>/dev/null)" && [ -n "$t" ]; then
    LLM_URL="http://127.0.0.1:11434/v1"
    LLM_MODEL="$(printf '%s' "$t" | python3 -c 'import json,sys; d=json.load(sys.stdin); import re; m=[x.get("name","") for x in d.get("models") or [] if not re.search("embed|bge|minilm|e5-|rerank", x.get("name",""), re.I)]; print(m[0] if m else "")' 2>/dev/null || true)"
    if [ -z "$LLM_MODEL" ] && command -v ollama >/dev/null && yes_no "Ollama nie ma modeli. Pobrać qwen3:8b (~5 GB, wywołuje narzędzia)?" n; then
      ollama pull qwen3:8b && LLM_MODEL="qwen3:8b"
    fi
    ok "Ollama na :11434 (model: ${LLM_MODEL:-brak})"
  fi
  [ -n "$LLM_URL" ] || warn "nie wykryto lokalnego serwera modeli (llama.cpp :8080, Ollama :11434) — opencode potrzebuje dostawcy w opencode.json"
else
  warn "brak curl — pomijam wykrywanie serwera modeli"
fi
OC_JSON="$CFG/opencode/opencode.json"
OC_NEW=""
if [ -n "$LLM_URL" ] && [ -n "$LLM_MODEL" ]; then
  if [ -f "$OC_JSON" ]; then
    warn "$OC_JSON istnieje — nie ruszam. Dostawca do dopisania: \"local\": {\"npm\": \"@ai-sdk/openai-compatible\", \"options\": {\"baseURL\": \"$LLM_URL\"}, \"models\": {\"$LLM_MODEL\": {}}}"
  elif yes_no "Zapisać $OC_JSON z tym modelem jako domyślnym?" t; then
    mkdir -p "$(dirname "$OC_JSON")"
    # enabled_providers + small_model: bez nich opencode wysyła m.in. tytuły sesji do modeli w chmurze
    printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "enabled_providers": ["local"],\n  "model": "local/%s",\n  "small_model": "local/%s",\n  "share": "disabled",\n  "provider": {\n    "local": {\n      "npm": "@ai-sdk/openai-compatible",\n      "options": { "baseURL": "%s" },\n      "models": { "%s": { "name": "%s (lokalnie)" } }\n    }\n  }\n}\n' \
      "$LLM_MODEL" "$LLM_MODEL" "$LLM_URL" "$LLM_MODEL" "$LLM_MODEL" > "$OC_JSON"
    OC_NEW="$OC_JSON"; ok "zapisano $OC_JSON"
  fi
fi

echo "4. Pliki"
: > "$MANIFEST.new"
[ -n "$OC_NEW" ] && echo "$OC_NEW" >> "$MANIFEST.new"
install_file() { # install_file źródło cel tryb
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ -f "$dst" ] && ! cmp -s "$src" "$dst"; then cp -p "$dst" "$dst.bak-$TS"; warn "kopia: $dst.bak-$TS"; fi
  install -m "$3" "$src" "$dst"
  echo "$dst" >> "$MANIFEST.new"
}
for d in "$REPO"/plugins/*/; do
  n="$(basename "$d")"
  for f in index.ts tui.tsx tariff.ts package.json; do  # tui.tsx + package.json: wtyczki z częścią w TUI
    [ -f "$d/$f" ] && install_file "$d/$f" "$PLUGINS/$n/$f" 644
  done
  ok "wtyczka $n"
done
for d in "$REPO"/skills/*/; do  # opencode wczytuje skille z ~/.config/opencode/skills/<nazwa>/SKILL.md
  n="$(basename "$d")"; install_file "$d/SKILL.md" "$CFG/opencode/skills/$n/SKILL.md" 644; ok "skill $n"
done
for f in "$REPO"/bin/*; do
  [ -f "$f" ] || continue  # np. __pycache__ po sprawdzaniu składni
  n="$(basename "$f")"; tmp="$(mktemp)"
  # shebang Pythona → wybrany interpreter z MemPalace; /home/user → ten katalog domowy
  sed -e "1s|^#!/home/user/mempalace/.venv/bin/python|#!$PY|" -e "s|/home/user|$HOME|g" "$f" > "$tmp"
  install_file "$tmp" "$BIN/$n" 755; rm -f "$tmp"; ok "~/bin/$n"
done
for f in AGENTS.md prompts/general.txt prompts/coder.txt prompts/reasoner.txt prompts/reviewer.txt; do
  # zasady pracy i prompty agentów: tylko gdy ich brak — własnych nie nadpisujemy
  if [ -f "$CFG/opencode/$f" ]; then ok "$f — zostaje twój"; else install_file "$REPO/agents/$f" "$CFG/opencode/$f" 644; ok "$f"; fi
done
install_file "$REPO/freecode/freecode" "$BIN/freecode" 755; ok "~/bin/freecode (opencode tylko na lokalnych modelach)"
mkdir -p "$HOME/oc-audyt/kopalnia" "$HOME/oc-audyt/auto-kopie" "$HOME/tmp-opencode" "$HOME/mempalace/audit"
if [ -z "$(ls -A "$HOME/oc-audyt/kopalnia" 2>/dev/null)" ]; then
  cp "$REPO/lessons/EXAMPLE.md" "$HOME/oc-audyt/kopalnia/" && ok "przykładowy wniosek w ~/oc-audyt/kopalnia"
fi
case ":$PATH:" in *":$BIN:"*) ;; *) warn "~/bin nie jest w PATH — dopisz do profilu powłoki" ;; esac

echo "5. Usługi systemd (--user)"
if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  for f in "$REPO"/systemd/*; do install_file "$f" "$CFG/systemd/user/$(basename "$f")" 644; done
  systemctl --user daemon-reload
  systemctl --user enable --now audit-retention.timer >/dev/null 2>&1 && ok "audit-retention.timer włączony"
else
  warn "brak systemd --user — retencję audytu uruchamiaj ręcznie: ~/bin/audit-retention"
fi

{ cat "$MANIFEST.new"; [ -f "$MANIFEST" ] && cat "$MANIFEST"; true; } | sort -u > "$MANIFEST.tmp" && mv "$MANIFEST.tmp" "$MANIFEST" && rm -f "$MANIFEST.new"
echo "6. Gotowe — wtyczki wczytają się przy następnym starcie opencode."
autotest || true
