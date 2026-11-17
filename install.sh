#!/usr/bin/env bash
# opencode-config installer: self-repair plugins for tool-call errors + MemPalace context.
#
#   ./install.sh            interactive (asks about MemPalace, embedding port, wings)
#   ./install.sh -y         default values, no questions
#   ./install.sh --check    self-test of an existing installation only
#   ./install.sh --uninstall
#
# Existing files overwritten by the installer get a *.bak-YYYYMMDD-HHMMSS backup.
# `~` and “quotes” in messages are deliberate (text for a human, not paths or syntax)
# shellcheck disable=SC2088,SC1111
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HOME/bin"
CFG="${XDG_CONFIG_HOME:-$HOME/.config}"   # opencode and systemd read XDG_CONFIG_HOME too
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
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
ask() { # ask "Question" default → echo answer
  local answer
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then echo "$2"; return; fi
  read -r -p "  $1 [$2]: " answer </dev/tty || true
  echo "${answer:-$2}"
}
yes_no() { # yes_no "Question" t|n  (t = yes; answers t/T/y/Y count as yes)
  local def="$2" answer
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then [ "$def" = t ]; return; fi
  read -r -p "  $1 [$([ "$def" = t ] && echo Y/n || echo y/N)]: " answer </dev/tty || true
  answer="${answer:-$def}"; [[ "$answer" =~ ^[tTyY] ]]
}

# ── uninstall ────────────────────────────────────────────────────────────────────────────────
if [ "$MODE" = uninstall ]; then
  echo "Uninstalling opencode-config"
  # installations before 2026-10-21 kept the list as zainstalowane.txt
  [ -f "$MANIFEST" ] || [ ! -f "$CONF_DIR/zainstalowane.txt" ] || mv "$CONF_DIR/zainstalowane.txt" "$MANIFEST"
  [ -f "$MANIFEST" ] || { fail "no $MANIFEST — I know nothing about an installation"; exit 1; }
  if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user disable --now audit-retention.timer >/dev/null 2>&1 || true
  fi
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    rm -f "$f" && ok "removed $f"
    rmdir "$(dirname "$f")" 2>/dev/null || true
  done < "$MANIFEST"
  command -v systemctl >/dev/null && systemctl --user daemon-reload >/dev/null 2>&1 || true
  rm -f "$MANIFEST"
  ok "done (data: ~/oc-audyt, ~/.mempalace-opencode, $CONF and the venv stay — remove them by hand if you want)"
  exit 0
fi

# ── autotest ─────────────────────────────────────────────────────────────────────────────────
autotest() {
  local errors=0 py
  echo "Autotest"
  for n in tool-input-fix lesson-draft palace-context error-hook auto-backup no-call-guard danger-guard site-lint-hook work-mode; do
    if [ -f "$PLUGINS/$n/index.ts" ]; then ok "plugin $n"; else fail "missing plugin $n"; errors=$((errors+1)); fi
  done
  for f in palace-context audit-retention lesson-note agent-rule backup-copy freecode-tune site-lint; do
    if [ -x "$BIN/$f" ]; then ok "script ~/bin/$f"; else fail "missing ~/bin/$f"; errors=$((errors+1)); fi
  done
  py="$(head -1 "$BIN/palace-context" | sed 's/^#!//')"
  if "$py" -I -c "import mempalace.mcp_server" 2>/dev/null; then ok "MemPalace imports ($py)"
  else warn "MemPalace does not import in $py — palace-context and lesson-note will stay silent"; fi
  local tmp; tmp="$(mktemp -d "$HOME/.oc-config-test.XXXX")"
  if out="$(timeout 120 "$BIN/palace-context" "$tmp" 2>&1)"; then ok "palace-context works (output: ${out:-empty — the palace has no notes for this directory})"
  else fail "palace-context failed: $out"; errors=$((errors+1)); fi
  rmdir "$tmp" 2>/dev/null || true
  if out="$(timeout 120 "$BIN/lesson-note" 2>&1)"; then ok "lesson-note: $(echo "$out" | tail -1)"
  else fail "lesson-note failed: $(echo "$out" | tail -2)"; errors=$((errors+1)); fi
  if command -v node >/dev/null && command -v npx >/dev/null; then
    for n in tool-input-fix lesson-draft palace-context error-hook auto-backup no-call-guard danger-guard site-lint-hook work-mode; do
      if npx -y esbuild "$PLUGINS/$n/index.ts" --log-level=error --outfile=/dev/null >/dev/null 2>&1; then ok "syntax $n"
      else fail "syntax error in $n"; errors=$((errors+1)); fi
    done
  else warn "no node/npx — skipping the plugin syntax check"; fi
  if command -v opencode >/dev/null; then ok "opencode: $(opencode --version 2>&1 | tail -1)"
  else warn "opencode is not installed (npm i -g @opencode/cli) — the plugins will work after it is installed"; fi
  [ "$errors" = 0 ] && echo "Autotest: OK" || echo "Autotest: $errors error(s)"
  return "$errors"
}
if [ "$MODE" = check ]; then autotest; exit $?; fi

# ── install ──────────────────────────────────────────────────────────────────────────────────
echo "opencode-config — install"
echo "1. Requirements"
command -v python3 >/dev/null || { fail "no python3"; exit 1; }
python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' || { fail "Python ≥ 3.10 required"; exit 1; }
ok "python3 $(python3 -c 'import platform; print(platform.python_version())')"
command -v opencode >/dev/null && ok "opencode $(opencode --version 2>&1 | tail -1)" || warn "opencode not found — install it: npm i -g @opencode/cli"

echo "2. MemPalace"
PY=""
for cand in "${MEMPALACE_PYTHON:-}" "$HOME/mempalace/.venv/bin/python" "$DEFAULT_VENV/bin/python" python3; do
  [ -n "$cand" ] || continue
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -I -c "import mempalace.mcp_server" 2>/dev/null; then PY="$(command -v "$cand")"; break; fi
done
if [ -n "$PY" ]; then
  ok "MemPalace found: $PY"
elif yes_no "MemPalace not found. Create a venv in $DEFAULT_VENV and install mempalace from PyPI?" t; then
  python3 -m venv "$DEFAULT_VENV"
  "$DEFAULT_VENV/bin/pip" install -q --upgrade pip
  "$DEFAULT_VENV/bin/pip" install -q mempalace
  PY="$DEFAULT_VENV/bin/python"
  ok "installed mempalace $("$PY" -m pip show mempalace 2>/dev/null | sed -n 's/^Version: //p')"
else
  PY="$(command -v python3)"
  warn "without MemPalace: palace-context and lesson-note stay silent (the self-repair plugins work)"
fi

echo "3. Settings"
# reinstall: defaults come from the existing settings (environment variables take precedence)
if [ -f "$CONF" ]; then
  : "${PALACE_EMBED_PORT:=$(sed -n 's/^PALACE_EMBED_PORT=//p' "$CONF")}"
  : "${PALACE_WINGS:=$(sed -n 's/^PALACE_WINGS=//p' "$CONF")}"
fi
echo "  MemPalace embeddings (standard ports):"
echo "    0     — built into MemPalace, no server (default)"
echo "    8080  — llama.cpp llama-server (default port)"
echo "    11434 — Ollama (default port)"
PORT="$(ask "Embedding server port for the health check" "${PALACE_EMBED_PORT:-0}")"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -le 65535 ] || { warn "“$PORT” is not a port — using 0"; PORT=0; }
WINGS="$(ask "Palace wings visible to the model (comma-separated, * = all)" "${PALACE_WINGS:-*}")"
mkdir -p "$CONF_DIR"
[ -f "$CONF" ] && cp -p "$CONF" "$CONF.bak-$TS"
cat > "$CONF" <<EOF
# opencode-config — read by ~/bin/palace-context
PALACE_EMBED_PORT=$PORT
PALACE_WINGS=$WINGS
MEMPALACE_SRC=$HOME/mempalace
EOF
ok "saved $CONF"

echo "3b. Models"
if [ "$PORT" != 0 ]; then
  ok "embeddings from the server on :$PORT — skipping the built-in model download"
elif "$PY" -I -c "import mempalace.mcp_server" 2>/dev/null; then
  echo "  downloading the MemPalace embedding model (once, ~80 MB)…"
  if "$PY" -I -c "
from mempalace import mcp_server as m
c = m._get_collection(create=True)
c.query(query_texts=['warm-up'], n_results=1)" >/dev/null 2>&1; then ok "embedding model ready"
  else warn "could not download the embedding model — it will be downloaded on first use"; fi
fi
LLM_URL=""; LLM_MODEL=""
if command -v curl >/dev/null; then
  if m="$(curl -s -m 3 http://127.0.0.1:8080/v1/models 2>/dev/null)" && [ -n "$m" ]; then
    LLM_MODEL="$(printf '%s' "$m" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("data") or [{}])[0].get("id",""))' 2>/dev/null || true)"
    if [ -n "$LLM_MODEL" ]; then LLM_URL="http://127.0.0.1:8080/v1"; ok "llama.cpp on :8080 (model: $LLM_MODEL)"
    else warn ":8080 answers, but it is not a model server (e.g. Open WebUI) — skipping"; fi
  fi
  if [ -z "$LLM_URL" ] && t="$(curl -s -m 3 http://127.0.0.1:11434/api/tags 2>/dev/null)" && [ -n "$t" ]; then
    LLM_URL="http://127.0.0.1:11434/v1"
    LLM_MODEL="$(printf '%s' "$t" | python3 -c 'import json,sys; d=json.load(sys.stdin); import re; m=[x.get("name","") for x in d.get("models") or [] if not re.search("embed|bge|minilm|e5-|rerank", x.get("name",""), re.I)]; print(m[0] if m else "")' 2>/dev/null || true)"
    if [ -z "$LLM_MODEL" ] && command -v ollama >/dev/null && yes_no "Ollama has no models. Download qwen3:8b (~5 GB, can call tools)?" n; then
      ollama pull qwen3:8b && LLM_MODEL="qwen3:8b"
    fi
    ok "Ollama on :11434 (model: ${LLM_MODEL:-none})"
  fi
  [ -n "$LLM_URL" ] || warn "no local model server detected (llama.cpp :8080, Ollama :11434) — opencode needs a provider in opencode.json"
else
  warn "no curl — skipping model server detection"
fi
OC_JSON="$CFG/opencode/opencode.json"
OC_NEW=""
if [ -n "$LLM_URL" ] && [ -n "$LLM_MODEL" ]; then
  if [ -f "$OC_JSON" ]; then
    warn "$OC_JSON exists — not touching it. Provider to add: \"local\": {\"npm\": \"@ai-sdk/openai-compatible\", \"options\": {\"baseURL\": \"$LLM_URL\"}, \"models\": {\"$LLM_MODEL\": {}}}"
  elif yes_no "Save $OC_JSON with this model as the default?" t; then
    mkdir -p "$(dirname "$OC_JSON")"
    # enabled_providers + small_model: without them opencode sends e.g. session titles to cloud models
    printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "enabled_providers": ["local"],\n  "model": "local/%s",\n  "small_model": "local/%s",\n  "share": "disabled",\n  "provider": {\n    "local": {\n      "npm": "@ai-sdk/openai-compatible",\n      "options": { "baseURL": "%s" },\n      "models": { "%s": { "name": "%s (local)" } }\n    }\n  }\n}\n' \
      "$LLM_MODEL" "$LLM_MODEL" "$LLM_URL" "$LLM_MODEL" "$LLM_MODEL" > "$OC_JSON"
    OC_NEW="$OC_JSON"; ok "saved $OC_JSON"
  fi
fi

echo "4. Files"
: > "$MANIFEST.new"
[ -n "$OC_NEW" ] && echo "$OC_NEW" >> "$MANIFEST.new"
install_file() { # install_file source target mode
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ -f "$dst" ] && ! cmp -s "$src" "$dst"; then cp -p "$dst" "$dst.bak-$TS"; warn "backup: $dst.bak-$TS"; fi
  install -m "$3" "$src" "$dst"
  echo "$dst" >> "$MANIFEST.new"
}
for d in "$REPO"/plugins/*/; do
  n="$(basename "$d")"
  for f in index.ts tui.tsx tariff.ts package.json; do  # tui.tsx + package.json: plugins with a TUI part
    [ -f "$d/$f" ] && install_file "$d/$f" "$PLUGINS/$n/$f" 644
  done
  ok "plugin $n"
done
for d in "$REPO"/skills/*/; do  # opencode loads skills from ~/.config/opencode/skills/<name>/SKILL.md
  n="$(basename "$d")"; install_file "$d/SKILL.md" "$CFG/opencode/skills/$n/SKILL.md" 644; ok "skill $n"
done
for f in "$REPO"/bin/*; do
  [ -f "$f" ] || continue  # e.g. __pycache__ after the syntax check
  n="$(basename "$f")"; tmp="$(mktemp)"
  # Python shebang → the chosen MemPalace interpreter; /home/user → this home directory
  sed -e "1s|^#!/home/user/mempalace/.venv/bin/python|#!$PY|" -e "s|/home/user|$HOME|g" "$f" > "$tmp"
  install_file "$tmp" "$BIN/$n" 755; rm -f "$tmp"; ok "~/bin/$n"
done
for f in AGENTS.md prompts/general.txt prompts/coder.txt prompts/reasoner.txt prompts/reviewer.txt; do
  # work rules and agent prompts: only when missing — we never overwrite your own
  if [ -f "$CFG/opencode/$f" ]; then ok "$f — keeping yours"; else install_file "$REPO/agents/$f" "$CFG/opencode/$f" 644; ok "$f"; fi
done
for f in AGENTS.md prompts/general.txt prompts/coder.txt prompts/reasoner.txt prompts/reviewer.txt; do
  # templates for `freecode --configure` (stage 2) (compared with your files); these are repo copies, not your files
  install_file "$REPO/agents/$f" "${XDG_DATA_HOME:-$HOME/.local/share}/freecode/agents/$f" 644
done
ok "agents/ templates for freecode --configure"
install_file "$REPO/freecode/freecode" "$BIN/freecode" 755; ok "~/bin/freecode (opencode on local models only)"
mkdir -p "$HOME/oc-audyt/kopalnia" "$HOME/oc-audyt/auto-kopie" "$HOME/tmp-opencode" "$HOME/mempalace/audit"
if [ -z "$(ls -A "$HOME/oc-audyt/kopalnia" 2>/dev/null)" ]; then
  cp "$REPO/lessons/EXAMPLE.md" "$HOME/oc-audyt/kopalnia/" && ok "example lesson in ~/oc-audyt/kopalnia"
fi
case ":$PATH:" in *":$BIN:"*) ;; *) warn "~/bin is not in PATH — add it to your shell profile" ;; esac

echo "5. systemd services (--user)"
if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  for f in "$REPO"/systemd/*; do install_file "$f" "$CFG/systemd/user/$(basename "$f")" 644; done
  systemctl --user daemon-reload
  systemctl --user enable --now audit-retention.timer >/dev/null 2>&1 && ok "audit-retention.timer enabled"
else
  warn "no systemd --user — run the audit retention by hand: ~/bin/audit-retention"
fi

{ cat "$MANIFEST.new"; [ -f "$MANIFEST" ] && cat "$MANIFEST"; true; } | sort -u > "$MANIFEST.tmp" && mv "$MANIFEST.tmp" "$MANIFEST" && rm -f "$MANIFEST.new"
echo "6. Done — the plugins load at the next opencode start."
autotest || true
