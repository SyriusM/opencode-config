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
LISTA="$CONF_DIR/zainstalowane.txt"
VENV_DOMYSLNY="$HOME/.local/share/opencode-config/venv"
TS="$(date +%Y%m%d-%H%M%S)"
TAK=0; TRYB=install

for a in "$@"; do
  case "$a" in
    -y|--yes) TAK=1 ;;
    --check) TRYB=check ;;
    --uninstall) TRYB=uninstall ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Nieznana opcja: $a" >&2; exit 2 ;;
  esac
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
uwaga(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
blad() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
pytaj() { # pytaj "Pytanie" domyślna → echo odpowiedź
  local odp
  if [ "$TAK" = 1 ] || [ ! -t 0 ]; then echo "$2"; return; fi
  read -r -p "  $1 [$2]: " odp </dev/tty || true
  echo "${odp:-$2}"
}
tak_nie() { # tak_nie "Pytanie" t|n
  local d="$2" odp
  if [ "$TAK" = 1 ] || [ ! -t 0 ]; then [ "$d" = t ]; return; fi
  read -r -p "  $1 [$([ "$d" = t ] && echo T/n || echo t/N)]: " odp </dev/tty || true
  odp="${odp:-$d}"; [[ "$odp" =~ ^[tTyY] ]]
}

# ── deinstalacja ─────────────────────────────────────────────────────────────────────────────
if [ "$TRYB" = uninstall ]; then
  echo "Deinstalacja opencode-config"
  [ -f "$LISTA" ] || { blad "brak $LISTA — nic nie wiem o instalacji"; exit 1; }
  if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user disable --now audyt-retencja.timer >/dev/null 2>&1 || true
  fi
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    rm -f "$f" && ok "usunięto $f"
    rmdir "$(dirname "$f")" 2>/dev/null || true
  done < "$LISTA"
  command -v systemctl >/dev/null && systemctl --user daemon-reload >/dev/null 2>&1 || true
  rm -f "$LISTA"
  ok "gotowe (dane: ~/oc-audyt, ~/.mempalace-opencode, $CONF i venv zostają — usuń ręcznie, jeśli chcesz)"
  exit 0
fi

# ── autotest ─────────────────────────────────────────────────────────────────────────────────
autotest() {
  local bledy=0 py
  echo "Autotest"
  for n in tool-input-fix lesson-draft palace-kontekst error-hook auto-kopie; do
    if [ -f "$PLUGINS/$n/index.ts" ]; then ok "wtyczka $n"; else blad "brak wtyczki $n"; bledy=$((bledy+1)); fi
  done
  for f in palace-kontekst audyt-retencja oc-wniosek oc-regula oc-kopie; do
    if [ -x "$BIN/$f" ]; then ok "skrypt ~/bin/$f"; else blad "brak ~/bin/$f"; bledy=$((bledy+1)); fi
  done
  py="$(head -1 "$BIN/palace-kontekst" | sed 's/^#!//')"
  if "$py" -I -c "import mempalace.mcp_server" 2>/dev/null; then ok "MemPalace importuje się ($py)"
  else uwaga "MemPalace nie importuje się w $py — palace-kontekst i oc-wniosek będą milczeć"; fi
  local tmp; tmp="$(mktemp -d "$HOME/.oc-config-test.XXXX")"
  if out="$(timeout 120 "$BIN/palace-kontekst" "$tmp" 2>&1)"; then ok "palace-kontekst działa (wynik: ${out:-pusty — palace bez notatek dla tego katalogu})"
  else blad "palace-kontekst padł: $out"; bledy=$((bledy+1)); fi
  rmdir "$tmp" 2>/dev/null || true
  if out="$(timeout 120 "$BIN/oc-wniosek" 2>&1)"; then ok "oc-wniosek: $(echo "$out" | tail -1)"
  else blad "oc-wniosek padł: $(echo "$out" | tail -2)"; bledy=$((bledy+1)); fi
  if command -v node >/dev/null && command -v npx >/dev/null; then
    for n in tool-input-fix lesson-draft palace-kontekst error-hook auto-kopie; do
      if npx -y esbuild "$PLUGINS/$n/index.ts" --log-level=error --outfile=/dev/null >/dev/null 2>&1; then ok "składnia $n"
      else blad "błąd składni $n"; bledy=$((bledy+1)); fi
    done
  else uwaga "brak node/npx — pomijam kontrolę składni wtyczek"; fi
  if command -v opencode >/dev/null; then ok "opencode: $(opencode --version 2>&1 | tail -1)"
  else uwaga "opencode nie jest zainstalowany (npm i -g @opencode/cli) — wtyczki zadziałają po instalacji"; fi
  [ "$bledy" = 0 ] && echo "Autotest: OK" || echo "Autotest: $bledy błędów"
  return "$bledy"
}
if [ "$TRYB" = check ]; then autotest; exit $?; fi

# ── instalacja ───────────────────────────────────────────────────────────────────────────────
echo "opencode-config — instalacja"
echo "1. Wymagania"
command -v python3 >/dev/null || { blad "brak python3"; exit 1; }
python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' || { blad "potrzebny Python ≥ 3.10"; exit 1; }
ok "python3 $(python3 -c 'import platform; print(platform.python_version())')"
command -v opencode >/dev/null && ok "opencode $(opencode --version 2>&1 | tail -1)" || uwaga "opencode nie znaleziony — zainstaluj: npm i -g @opencode/cli"

echo "2. MemPalace"
PY=""
for kand in "${MEMPALACE_PYTHON:-}" "$HOME/mempalace/.venv/bin/python" "$VENV_DOMYSLNY/bin/python" python3; do
  [ -n "$kand" ] || continue
  if command -v "$kand" >/dev/null 2>&1 && "$kand" -I -c "import mempalace.mcp_server" 2>/dev/null; then PY="$(command -v "$kand")"; break; fi
done
if [ -n "$PY" ]; then
  ok "MemPalace znaleziony: $PY"
elif tak_nie "MemPalace nie znaleziony. Utworzyć venv w $VENV_DOMYSLNY i zainstalować mempalace z PyPI?" t; then
  python3 -m venv "$VENV_DOMYSLNY"
  "$VENV_DOMYSLNY/bin/pip" install -q --upgrade pip
  "$VENV_DOMYSLNY/bin/pip" install -q mempalace
  PY="$VENV_DOMYSLNY/bin/python"
  ok "zainstalowano mempalace $("$PY" -m pip show mempalace 2>/dev/null | sed -n 's/^Version: //p')"
else
  PY="$(command -v python3)"
  uwaga "bez MemPalace: palace-kontekst i oc-wniosek będą milczeć (wtyczki samonaprawy działają)"
fi

echo "3. Ustawienia"
echo "  Embeddingi MemPalace (standardowe porty):"
echo "    0     — wbudowane w MemPalace, bez serwera (domyślnie)"
echo "    8080  — llama.cpp llama-server (domyślny port)"
echo "    11434 — Ollama (domyślny port)"
PORT="$(pytaj "Port serwera embeddingów do kontroli zdrowia" "${PALACE_EMBED_PORT:-0}")"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -le 65535 ] || { uwaga "„$PORT” to nie port — ustawiam 0"; PORT=0; }
WINGS="$(pytaj "Skrzydła palace widoczne dla modelu (lista po przecinku, * = wszystkie)" "${PALACE_WINGS:-*}")"
mkdir -p "$CONF_DIR"
[ -f "$CONF" ] && cp -p "$CONF" "$CONF.bak-$TS"
cat > "$CONF" <<EOF
# opencode-config — czytane przez ~/bin/palace-kontekst
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
  else uwaga "nie udało się pobrać modelu embeddingów — pobierze się przy pierwszym użyciu"; fi
fi
LLM_URL=""; LLM_MODEL=""
if command -v curl >/dev/null; then
  if m="$(curl -s -m 3 http://127.0.0.1:8080/v1/models 2>/dev/null)" && [ -n "$m" ]; then
    LLM_MODEL="$(printf '%s' "$m" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("data") or [{}])[0].get("id",""))' 2>/dev/null || true)"
    if [ -n "$LLM_MODEL" ]; then LLM_URL="http://127.0.0.1:8080/v1"; ok "llama.cpp na :8080 (model: $LLM_MODEL)"
    else uwaga ":8080 odpowiada, ale to nie serwer modeli (np. Open WebUI) — pomijam"; fi
  fi
  if [ -z "$LLM_URL" ] && t="$(curl -s -m 3 http://127.0.0.1:11434/api/tags 2>/dev/null)" && [ -n "$t" ]; then
    LLM_URL="http://127.0.0.1:11434/v1"
    LLM_MODEL="$(printf '%s' "$t" | python3 -c 'import json,sys; d=json.load(sys.stdin); import re; m=[x.get("name","") for x in d.get("models") or [] if not re.search("embed|bge|minilm|e5-|rerank", x.get("name",""), re.I)]; print(m[0] if m else "")' 2>/dev/null || true)"
    if [ -z "$LLM_MODEL" ] && command -v ollama >/dev/null && tak_nie "Ollama nie ma modeli. Pobrać qwen3:8b (~5 GB, wywołuje narzędzia)?" n; then
      ollama pull qwen3:8b && LLM_MODEL="qwen3:8b"
    fi
    ok "Ollama na :11434 (model: ${LLM_MODEL:-brak})"
  fi
  [ -n "$LLM_URL" ] || uwaga "nie wykryto lokalnego serwera modeli (llama.cpp :8080, Ollama :11434) — opencode potrzebuje dostawcy w opencode.json"
else
  uwaga "brak curl — pomijam wykrywanie serwera modeli"
fi
OC_JSON="$CFG/opencode/opencode.json"
OC_NOWY=""
if [ -n "$LLM_URL" ] && [ -n "$LLM_MODEL" ]; then
  if [ -f "$OC_JSON" ]; then
    uwaga "$OC_JSON istnieje — nie ruszam. Dostawca do dopisania: \"local\": {\"npm\": \"@ai-sdk/openai-compatible\", \"options\": {\"baseURL\": \"$LLM_URL\"}, \"models\": {\"$LLM_MODEL\": {}}}"
  elif tak_nie "Zapisać $OC_JSON z tym modelem jako domyślnym?" t; then
    mkdir -p "$(dirname "$OC_JSON")"
    # enabled_providers + small_model: bez nich opencode wysyła m.in. tytuły sesji do modeli w chmurze
    printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "enabled_providers": ["local"],\n  "model": "local/%s",\n  "small_model": "local/%s",\n  "share": "disabled",\n  "provider": {\n    "local": {\n      "npm": "@ai-sdk/openai-compatible",\n      "options": { "baseURL": "%s" },\n      "models": { "%s": { "name": "%s (lokalnie)" } }\n    }\n  }\n}\n' \
      "$LLM_MODEL" "$LLM_MODEL" "$LLM_URL" "$LLM_MODEL" "$LLM_MODEL" > "$OC_JSON"
    OC_NOWY="$OC_JSON"; ok "zapisano $OC_JSON"
  fi
fi

echo "4. Pliki"
: > "$LISTA.nowa"
[ -n "$OC_NOWY" ] && echo "$OC_NOWY" >> "$LISTA.nowa"
instaluj() { # instaluj źródło cel tryb
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ -f "$dst" ] && ! cmp -s "$src" "$dst"; then cp -p "$dst" "$dst.bak-$TS"; uwaga "kopia: $dst.bak-$TS"; fi
  install -m "$3" "$src" "$dst"
  echo "$dst" >> "$LISTA.nowa"
}
for d in "$REPO"/plugins/*/; do
  n="$(basename "$d")"; instaluj "$d/index.ts" "$PLUGINS/$n/index.ts" 644; ok "wtyczka $n"
done
for f in "$REPO"/bin/*; do
  [ -f "$f" ] || continue  # np. __pycache__ po sprawdzaniu składni
  n="$(basename "$f")"; tmp="$(mktemp)"
  # shebang Pythona → wybrany interpreter z MemPalace; /home/user → ten katalog domowy
  sed -e "1s|^#!/home/user/mempalace/.venv/bin/python|#!$PY|" -e "s|/home/user|$HOME|g" "$f" > "$tmp"
  instaluj "$tmp" "$BIN/$n" 755; rm -f "$tmp"; ok "~/bin/$n"
done
instaluj "$REPO/freecode/freecode" "$BIN/freecode" 755; ok "~/bin/freecode (opencode tylko na lokalnych modelach)"
mkdir -p "$HOME/oc-audyt/kopalnia" "$HOME/oc-audyt/auto-kopie" "$HOME/tmp-opencode" "$HOME/mempalace/audit"
if [ -z "$(ls -A "$HOME/oc-audyt/kopalnia" 2>/dev/null)" ]; then
  cp "$REPO/kopalnia/PRZYKLAD.md" "$HOME/oc-audyt/kopalnia/" && ok "przykładowy wniosek w ~/oc-audyt/kopalnia"
fi
case ":$PATH:" in *":$BIN:"*) ;; *) uwaga "~/bin nie jest w PATH — dopisz do profilu powłoki" ;; esac

echo "5. Usługi systemd (--user)"
if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  for f in "$REPO"/systemd/*; do instaluj "$f" "$CFG/systemd/user/$(basename "$f")" 644; done
  systemctl --user daemon-reload
  systemctl --user enable --now audyt-retencja.timer >/dev/null 2>&1 && ok "audyt-retencja.timer włączony"
else
  uwaga "brak systemd --user — retencję audytu uruchamiaj ręcznie: ~/bin/audyt-retencja"
fi

{ cat "$LISTA.nowa"; [ -f "$LISTA" ] && cat "$LISTA"; true; } | sort -u > "$LISTA.tmp" && mv "$LISTA.tmp" "$LISTA" && rm -f "$LISTA.nowa"
echo "6. Gotowe — wtyczki wczytają się przy następnym starcie opencode."
autotest || true
