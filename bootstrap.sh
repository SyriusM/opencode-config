#!/usr/bin/env bash
# Start from zero: llama.cpp + a model from Hugging Face + opencode + opencode-config + freecode, no AI needed.
# Detects the hardware (GPU, VRAM, RAM, driver) and picks the llama.cpp build, the model and the flags.
#
#   ./bootstrap.sh                 interactive (asks before installing packages and downloading)
#   ./bootstrap.sh -y              no questions (sudo still asks for the password)
#   ./bootstrap.sh --dry-run       only show the detected hardware and the plan, download nothing
#   ./bootstrap.sh --profile 9b    force the model: 35b | 9b | 4b
#   ./bootstrap.sh --backend cpu   force the llama.cpp build: cuda-13 | cuda-12 | vulkan | cpu
#   ./bootstrap.sh --llama-tag latest  another llama.cpp build (number bNNNNN or latest = newest, untested)
#   ./bootstrap.sh --port 8080     model server port (default: first free from 8080)
#   ./bootstrap.sh --url http://127.0.0.1:8085/v1 --model ID   your own OpenAI-compatible server (no llama.cpp)
#   ./bootstrap.sh --dir ~/src/opencode-config                  where to clone the repo
#   ./bootstrap.sh --no-smoke      no test conversation at the end
#   ./bootstrap.sh --idle 30       the model starts on demand and stops after N min idle (default 15; 0 = always on)
#
# Also works as: curl -fsSL https://raw.githubusercontent.com/SyriusM/opencode-config/main/bootstrap.sh | bash
# `~` and “quotes” in messages are deliberate (text for a human)
# shellcheck disable=SC2088,SC1111
set -euo pipefail

# Everything in a function: with `curl | bash` bash reads the whole script before running anything,
# so no program inside can “eat” the rest of the script from standard input.
main() {
REPO_URL="https://github.com/SyriusM/opencode-config"
LLAMA_RELEASES="https://api.github.com/repos/ggml-org/llama.cpp/releases"
# Pinned build: llama.cpp ships several nightly builds a day and changes defaults
# (e.g. port 9931 instead of 8080). Change it by hand, after a test on real hardware.
LLAMA_TAG="b11819"
HF="https://huggingface.co"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/freecode"
CFG="${XDG_CONFIG_HOME:-$HOME/.config}"
UNIT="freecode-llama.service"
PROXY="freecode-llama-proxy.service"
SOCKET="freecode-llama-proxy.socket"
YES=0; DRY=0; KEEP=0; SMOKE=1; PROFILE=""; BACKEND=""; PORT=""; URL=""; MODEL=""; IDLE=15
DIR="$HOME/opencode-config"
BIN="$HOME/bin"

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1 ;;
    --dry-run) DRY=1 ;;
    --profile) PROFILE="$2"; shift ;;
    --backend) BACKEND="$2"; shift ;;
    --port) PORT="$2"; shift ;;
    --llama-tag) LLAMA_TAG="$2"; shift ;;
    --url) URL="$2"; shift ;;
    --model) MODEL="$2"; shift ;;
    --dir) DIR="$2"; shift ;;
    --no-smoke) SMOKE=0 ;;
    --idle) IDLE="$2"; shift ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" 2>/dev/null || echo "help: $REPO_URL"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$PROFILE" in ""|35b|9b|4b) ;; *) echo "--profile: 35b | 9b | 4b" >&2; exit 2 ;; esac
case "$BACKEND" in ""|cuda-13|cuda-12|vulkan|cpu) ;; *) echo "--backend: cuda-13 | cuda-12 | vulkan | cpu" >&2; exit 2 ;; esac
[[ "$IDLE" =~ ^[0-9]+$ ]] || { echo "--idle: number of minutes (0 = always on)" >&2; exit 2; }
[ -z "$URL" ] || [ -n "$MODEL" ] || { echo "--url requires --model (id from ADDRESS/models)" >&2; exit 2; }

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }
yes_no() { # yes_no "Question" — default yes; with curl | bash it asks via /dev/tty
  local answer
  if [ "$YES" = 1 ] || [ ! -r /dev/tty ]; then return 0; fi
  read -r -p "  $1 [Y/n]: " answer </dev/tty || true
  [[ "${answer:-t}" =~ ^[tTyY] ]]
}
models_at() { # models_at URL → model ids, one per line (empty = no server)
  curl -s -m 3 "${1%/}/models" 2>/dev/null |
    python3 -c 'import json,sys; [print(m["id"]) for m in json.load(sys.stdin).get("data", []) if m.get("id")]' 2>/dev/null || true
}
quote() { # arguments with spaces in quotes (systemd and shell syntax)
  local a out=()
  for a in "$@"; do [[ "$a" == *[[:space:]]* ]] && out+=("\"$a\"") || out+=("$a"); done
  echo "${out[*]}"
}
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
download() { # download URL FILE — with a progress bar, resumes interrupted ones (.part)
  [ -f "$2" ] && return 0
  mkdir -p "$(dirname "$2")"
  curl -fL --retry 3 -C - --progress-bar -o "$2.part" "$1" || return 1
  if [ -z "$3" ]; then warn "the source gave no sha256 for $(basename "$2") — not verified"
  elif ! echo "$3  $2.part" | sha256sum -c --quiet - >/dev/null 2>&1; then
    rm -f "$2.part"; fail "wrong sha256 for $(basename "$2") — deleted, run again"
  fi
  mv "$2.part" "$2"
}
hf_sha256() { # hf_sha256 URL — sha256 of an LFS file from the Hugging Face X-Linked-ETag header
  curl -fsI -m 20 "$1" 2>/dev/null | tr -d '\r"' | awk 'tolower($1)=="x-linked-etag:" && $2 ~ /^[0-9a-f]{64}$/ {print $2}'
}

# ── 0. obecna konfiguracja ───────────────────────────────────────────────────────────────────
# A working opencode (model in opencode.json + a server that answers) = no download and no new service:
# the same address goes to `freecode --configure`, which does not overwrite an existing file.
if [ -z "$URL" ]; then
  current="$(python3 - "$CFG/opencode" <<'PY' 2>/dev/null || true
import json, os, sys, urllib.request
d = sys.argv[1]
path = next((os.path.join(d, n) for n in ("opencode.json", "opencode.jsonc") if os.path.isfile(os.path.join(d, n))), None)
c = json.load(open(path, encoding="utf-8"))   # .jsonc with comments = exception = no result
pid, _, model = (c.get("model") or "").partition("/")
url = (((c.get("provider") or {}).get(pid) or {}).get("options") or {}).get("baseURL")
# an on-demand server (socket + proxy) takes a dozen or so seconds to wake
with urllib.request.urlopen(url.rstrip("/") + "/models", timeout=60) as r:
    ids = [m.get("id") for m in json.load(r).get("data", [])]
print(url, model, path, "ok" if model in ids else "?")
PY
)"
  if [ -n "$current" ]; then
    read -r cur_url cur_model cur_file cur_state <<<"$current"
    echo "[bootstrap 0/6] Current configuration"
    ok "$cur_file: model $cur_model at $cur_url"
    [ "$cur_state" = ok ] || warn "the server answers but does not list the model “$cur_model” (llama.cpp with --alias or a multi-model server — usually fine)"
    if yes_no "Keep the current server and model (no llama.cpp or model download)?"; then
      URL="$cur_url"; MODEL="$cur_model"; KEEP=1
    fi
  fi
fi

# ── 1. hardware ─────────────────────────────────────────────────────────────────────────────
echo "[bootstrap 1/6] Hardware"
RAM_GIB=$(( $(sed -n 's/^MemTotal: *\([0-9]*\) kB/\1/p' /proc/meminfo) / 1048576 ))
GPU="none"; VRAM_MIB=0; DRIVER=0; IGPU=""
if command -v nvidia-smi >/dev/null && q="$(nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>/dev/null | head -1)" && [ -n "$q" ]; then
  GPU="$(cut -d, -f1 <<<"$q" | xargs)"; [[ "$GPU" == NVIDIA* ]] || GPU="NVIDIA $GPU"
  VRAM_MIB=$(cut -d, -f2 <<<"$q" | xargs)
  DRIVER=$(cut -d, -f3 <<<"$q" | xargs | cut -d. -f1)
else
  for d in /sys/class/drm/card[0-9]*/device; do
    case "$d" in */card*-*/device) continue ;; esac   # monitor outputs (card1-DP-1), not cards
    vendor="$(cat "$d/vendor" 2>/dev/null || true)"
    mib=$(( $(cat "$d/mem_info_vram_total" 2>/dev/null || echo 0) / 1048576 ))
    case "$vendor" in
      # graphics in the CPU (APU) has only a small slice of RAM as “VRAM” — not separate memory
      0x1002) if [ "$mib" -ge 4096 ]; then [ "$mib" -gt "$VRAM_MIB" ] && GPU="AMD" && VRAM_MIB=$mib; else IGPU="AMD"; fi ;;
      0x8086) IGPU="Intel" ;;
      0x10de) [ "$GPU" = none ] && GPU="NVIDIA (no nvidia-smi)" ;;   # llama.cpp reports the memory during calibration
    esac
  done
fi
ok "GPU: $GPU${IGPU:+ + integrated $IGPU}, VRAM $(( VRAM_MIB / 1024 )) GiB, RAM ${RAM_GIB} GiB, CPU $(nproc) threads"
# minimum (README “Minimum requirements”): the smallest model 4B + a 16k window takes ~5 GB; a computer with 8 GB RAM
# shows 7 GiB. Less = remote server only (--url), because locally the model pushes the system into swap.
if [ -z "$URL" ] && [ "$RAM_GIB" -lt 7 ] && [ $(( VRAM_MIB / 1024 )) -lt 6 ]; then
  fail "not enough memory for a local model (RAM ${RAM_GIB} GiB, minimum 8 GB RAM or 6 GB VRAM) — use a server on another computer: --url http://ADDRESS:PORT/v1 --model ID"
fi
grep -qw avx2 /proc/cpuinfo 2>/dev/null || warn "CPU without AVX2 — a model on the CPU will be several times slower"

# llama.cpp build: CUDA on NVIDIA with a driver (fastest); for other cards Vulkan, which also works
# on the CPU alone (-dev none) — which card to use, if any, is decided by a measurement after the model download
if [ -z "$BACKEND" ]; then
  if [[ "$GPU" == NVIDIA* ]] && [ "$DRIVER" -ge 580 ]; then BACKEND=cuda-13
  elif [[ "$GPU" == NVIDIA* ]] && [ "$DRIVER" -ge 570 ]; then BACKEND=cuda-12
  elif { [ "$GPU" != none ] || [ -n "$IGPU" ]; } && ldconfig -p 2>/dev/null | grep 'libvulkan\.so\.1' >/dev/null; then BACKEND=vulkan
  else BACKEND=cpu; fi
fi
[ "$BACKEND" = cpu ] && VRAM_MIB=0
VRAM_GIB=$(( VRAM_MIB / 1024 ))

# Model profile. Qwen3.6-35B-A3B is MoE (3B active): the experts fit in RAM, the rest goes to the GPU
# + an expert cache, so it is fast from 8 GB VRAM. In our opencode task tests:
# 35B 97%, 9B 78% (9B can invent a result without calling a tool), 4B is not fit to be the main model.
if [ -z "$PROFILE" ]; then
  if [ "$RAM_GIB" -ge 28 ] || [ "$VRAM_GIB" -ge 22 ]; then PROFILE=35b
  elif [ "$RAM_GIB" -ge 14 ] || [ "$VRAM_GIB" -ge 8 ]; then PROFILE=9b
  else PROFILE=4b; fi
fi
case "$PROFILE" in
  35b) HF_REPO="unsloth/Qwen3.6-35B-A3B-GGUF"; HF_FILE="Qwen3.6-35B-A3B-UD-IQ4_NL.gguf"; ALIAS="qwen3.6-35b-a3b"; SIZE_GB=18 ;;
  9b)  HF_REPO="unsloth/Qwen3.5-9B-GGUF"; HF_FILE="Qwen3.5-9B-UD-Q4_K_XL.gguf"; ALIAS="qwen3.5-9b"; SIZE_GB=6 ;;
  4b)  HF_REPO="unsloth/Qwen3-4B-Instruct-2507-GGUF"; HF_FILE="Qwen3-4B-Instruct-2507-Q4_K_M.gguf"; ALIAS="qwen3-4b"; SIZE_GB=3 ;;
esac
MODEL_FILE="$DATA/models/$HF_FILE"
DEV_FLAGS=()   # device choice from the Vulkan calibration (empty = llama.cpp default)
set_flags() { # FLAGS for PROFILE at VRAM_MIB (dedicated GPU memory) + DEV_FLAGS
  VRAM_GIB=$(( VRAM_MIB / 1024 ))
  # sampling per the Qwen recommendations; a thinking limit so the model does not “think” forever
  FLAGS=(--jinja -fa on -np 1 --cache-ram 2048 --spec-type ngram-mod --top-k 20)
  local thinking=(--temp 0.6 --top-p 0.95) budget_msg="Thinking budget reached, answering now."
  VERIFIED=0
  case "$PROFILE" in
    35b) FLAGS+=("${thinking[@]}" --reasoning-budget 6144 --reasoning-budget-message "$budget_msg")
         if [ "$VRAM_GIB" -ge 22 ]; then
           FLAGS+=(-ngl all -c 131072)                    # everything on the GPU
         elif [ "$VRAM_GIB" -ge 7 ]; then
           # measured on RTX 3080 10 GB + 32 GB RAM: ~118 tok/s chat (CUDA; via Vulkan ~64), 41k prompt without OOM
           local cache=$(( VRAM_MIB - 5200 )); [ "$cache" -gt 8000 ] && cache=8000
           FLAGS+=(--cpu-moe --moe-cache-mib "$cache" -c 65536)
           [ "$VRAM_GIB" -ge 9 ] && [ "$VRAM_GIB" -le 11 ] && VERIFIED=1
         else
           FLAGS+=(-c 32768)                              # CPU / small GPU: --fit spreads the layers
         fi ;;
    9b)  FLAGS+=("${thinking[@]}" --reasoning-budget 3072 --reasoning-budget-message "$budget_msg" -c 32768) ;;
    4b)  FLAGS+=(-c 16384 --temp 0.7 --top-p 0.8) ;;   # Instruct version without thinking: different recommendations
  esac
  FLAGS+=("${DEV_FLAGS[@]}")
}
set_flags
if [ -z "$URL" ]; then
  echo "  plan: llama.cpp $BACKEND, model $HF_FILE (~$SIZE_GB GB)"
  echo "        flags: $(quote "${FLAGS[@]}")"
  if [ "$BACKEND" = vulkan ]; then ok "karta (albo samo CPU) zostanie wybrana pomiarem po pobraniu modelu"
  elif [ "$VERIFIED" = 1 ]; then ok "this setup is verified (RTX 3080 10 GB + 32 GB RAM)"
  else warn "this setup has NOT been tested on such hardware yet — llama.cpp --fit picks the GPU/RAM split; please report the result"; fi
  [ "$PROFILE" = 4b ] && warn "the 4B model is weak at working with tools — with ≥ 14 GB RAM choose --profile 9b"
fi
[ "$KEEP" = 1 ] && echo "  plan: current server $URL (model $MODEL) — no llama.cpp or model; then opencode, plugins and ~/bin (overwritten files get a .bak-* backup)"
[ "$DRY" = 1 ] && { echo "--dry-run: end, nothing downloaded"; exit 0; }

# ── 2. pakiety systemowe ─────────────────────────────────────────────────────────────────────
echo "[bootstrap 2/6] Requirements"
missing=()
for c in curl git python3 node npm tar; do command -v "$c" >/dev/null || missing+=("$c"); done
if [ ${#missing[@]} -gt 0 ]; then
  pkgs=("${missing[@]/node/nodejs}")
  if command -v pacman >/dev/null; then cmd=(sudo pacman -S --needed --noconfirm "${pkgs[@]}")
  elif command -v apt-get >/dev/null; then cmd=(sudo apt-get install -y "${pkgs[@]}" python3-venv)
  elif command -v dnf >/dev/null; then cmd=(sudo dnf install -y "${pkgs[@]}")
  else fail "missing: ${missing[*]} — install them with your package manager and run again"; fi
  yes_no "Missing: ${missing[*]}. Run: ${cmd[*]}?" || fail "cannot continue without ${missing[*]}"
  "${cmd[@]}"
fi
python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' || fail "potrzebny Python ≥ 3.10"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || fail "Node ≥ 20 required (found $(node --version))"
ok "python3 $(python3 -c 'import platform; print(platform.python_version())'), node $(node --version), git, curl"

# ── 3. llama.cpp + model ─────────────────────────────────────────────────────────────────────
echo "[bootstrap 3/6] Model server"
if [ -n "$URL" ]; then
  [ "$KEEP" = 1 ] || models_at "$URL" | grep -qxF "$MODEL" || fail "$URL has no model “$MODEL” (available: $(models_at "$URL" | tr '\n' ' '))"
  ok "your own server $URL, model $MODEL"
else
  need_gb=$(( SIZE_GB + 3 )); [ -f "$MODEL_FILE" ] && need_gb=1
  free_gb=$(( $(df -Pk "$(mkdir -p "$DATA" && echo "$DATA")" | awk 'NR==2 {print $4}') / 1048576 ))
  [ "$free_gb" -ge "$need_gb" ] || fail "not enough space in $DATA: $free_gb GB free, ~$need_gb GB needed"

  # a ready release from GitHub (CUDA in the package together with the cudart libraries — no CUDA install)
  case "$BACKEND" in
    cuda-13) suffix="ubuntu-cuda-13.4-x64"; extra="cudart-" ;;
    cuda-12) suffix="ubuntu-cuda-12.8-x64"; extra="cudart-" ;;
    vulkan)  suffix="ubuntu-vulkan-x64"; extra="" ;;
    cpu)     suffix="ubuntu-x64"; extra="" ;;
  esac
  [ "$(uname -m)" = x86_64 ] || fail "ready llama.cpp releases are picked only for x86_64 — build llama.cpp yourself and pass --url"
  tag="$LLAMA_TAG"
  if [ "$tag" = latest ]; then
    tag="$(curl -fsS -m 20 "$LLAMA_RELEASES?per_page=20" | python3 -c "
import json, sys
for r in json.load(sys.stdin):
    names = {a['name'] for a in r['assets']}
    if f\"llama-{r['tag_name']}-bin-$suffix.tar.gz\" in names:
        print(r['tag_name']); break")" || fail "could not read the llama.cpp releases from GitHub"
    warn "llama.cpp $tag — newest build, not tested with freecode"
  fi
  [ -n "$tag" ] || fail "no llama.cpp release for $suffix"
  LLAMA_DIR="$DATA/llama.cpp/$tag-$BACKEND"
  if [ ! -x "$LLAMA_DIR/llama-server" ]; then
    yes_no "Download llama.cpp $tag ($BACKEND)$([ -n "$extra" ] && echo ' + CUDA libraries, ~600 MB')?" || fail "cannot go on without llama.cpp"
    digests="$(curl -fsS -m 20 "$LLAMA_RELEASES/tags/$tag" | python3 -c "
import json, sys
for a in json.load(sys.stdin)['assets']:
    print(a['name'], (a.get('digest') or '').removeprefix('sha256:'))" 2>/dev/null || true)"
    for pkg in "llama-$tag-bin-$suffix.tar.gz" ${extra:+"${extra}llama-$tag-bin-$suffix.tar.gz"}; do
      download "https://github.com/ggml-org/llama.cpp/releases/download/$tag/$pkg" "$DATA/download/$pkg" \
        "$(awk -v n="$pkg" '$1==n {print $2}' <<<"$digests")" || fail "pobieranie $pkg przerwane"
      mkdir -p "$LLAMA_DIR"; tar xzf "$DATA/download/$pkg" -C "$LLAMA_DIR" --strip-components=1
    done
    rm -rf "$DATA/download"
  fi
  "$LLAMA_DIR/llama-server" --version >/dev/null 2>&1 || fail "$LLAMA_DIR/llama-server does not start"
  ok "llama.cpp $tag ($BACKEND) in $LLAMA_DIR"

  if [ ! -f "$MODEL_FILE" ]; then
    yes_no "Download the model $HF_FILE from Hugging Face (~$SIZE_GB GB)?" || fail "freecode cannot run without a model"
    download "$HF/$HF_REPO/resolve/main/$HF_FILE" "$MODEL_FILE" "$(hf_sha256 "$HF/$HF_REPO/resolve/main/$HF_FILE")" || fail "model download interrupted — run again, it resumes where it stoppedwania"
  fi
  ok "model $MODEL_FILE"

  if [ "$BACKEND" = vulkan ] && [ ${#DEV_FLAGS[@]} -eq 0 ]; then
    # Vulkan sees all cards at once, the integrated one too, and splits the model between them by default.
    # Weak CPU graphics can be slower than the CPU alone (Radeon 610M: 35B 8.7 tok/s, CPU 15.5),
    # so every candidate gets a short llama-bench and the fastest generation wins.
    echo "  calibration: which card (or the CPU alone) generates fastest…"
    bench_log="$DATA/tune-bench.log"; : >"$bench_log"
    moe=(); [ "$PROFILE" = 35b ] && moe=(-ncmoe 99)   # experts in RAM, like --cpu-moe in the server
    # the first disk read would lower the first candidate's score (measured: 2.5 instead of ~10 tok/s)
    [ "$RAM_GIB" -gt $(( SIZE_GB + 4 )) ] && cat "$MODEL_FILE" >/dev/null
    # When RAM is short the result measures waiting for memory, not the card (measured: 3080 6.8 tok/s instead of 29,
    # while the system pushed programs into zram). So two runs, the better wins, shown next to the share of time
    # spent waiting for memory (PSI “full”; no /proc/pressure = 0).
    psi_full() { sed -n 's/^full .*total=\([0-9]*\)/\1/p' /proc/pressure/memory 2>/dev/null || echo 0; }
    measure() { # measure ARGS… → "tok/s %waiting" (0 = did not start, details in $bench_log)
      local best="0 0" i p0 t0 ts stall
      for i in 1 2; do
        p0=$(psi_full); t0=$(date +%s%N)
        ts=$("$LLAMA_DIR/llama-bench" -m "$MODEL_FILE" -p 0 -n 64 -r 1 -o json "$@" 2>>"$bench_log" |
          python3 -c 'import json,sys; print(round(json.load(sys.stdin)[0]["avg_ts"], 1))' 2>/dev/null) || ts=0
        stall=$(( ( $(psi_full) - ${p0:-0} ) * 100000 / ( $(date +%s%N) - t0 ) ))   # µs / ns → %
        awk -v a="$ts" -v b="${best%% *}" 'BEGIN { exit !(a > b) }' && best="$ts $stall"
        [ "$ts" = 0 ] && break   # did not start — a second run will not change anything
      done
      echo "$best"
    }
    results=("cpu $(measure -dev none -ngl 0) 0 0")   # device, tok/s, %waiting, MiB, uma
    while read -r dev mib; do
      # uma: 1 = graphics sharing memory with the CPU; without --no-host the driver rejects jobs (out of memory)
      uma=$(sed -n "s/^ggml_vulkan: ${dev#Vulkan} = .*| uma: \([01]\) |.*/\1/p" "$bench_log" | head -1)
      host=(); [ "${uma:-0}" = 1 ] && host=(--no-host 1)
      results+=("$dev $(measure -dev "$dev" -ngl 99 "${host[@]}" "${moe[@]}") $mib ${uma:-0}")
    done < <("$LLAMA_DIR/llama-server" --list-devices 2>/dev/null |
             sed -n 's/^ *\(Vulkan[0-9]*\): .*(\([0-9]*\) MiB, [0-9]* MiB free)$/\1 \2/p')
    printf '%s\n' "${results[@]}" | awk '{printf "      %-8s %6s tok/s  memory wait %s%%%s\n", $1, $2, $3, ($5 == 1 ? "  (integrated)" : "")}'
    read -r dev ts stall mib uma < <(printf '%s\n' "${results[@]}" | sort -k2 -gr | head -1)
    [ "$ts" != 0 ] || fail "no variant started — log: $bench_log"
    [ "$stall" -lt 10 ] || warn "measurement disturbed by lack of RAM ($stall% of the time waiting) — close big programs and run bootstrap again (downloaded files stay)"
    if [ "$dev" = cpu ]; then DEV_FLAGS=(-dev none); VRAM_MIB=0
    elif [ "$uma" = 1 ]; then
      DEV_FLAGS=(-dev "$dev" -ngl all --no-host); VRAM_MIB=0   # shared memory: an expert cache gives nothing
      [ "$PROFILE" = 35b ] && DEV_FLAGS+=(--cpu-moe)
    else DEV_FLAGS=(-dev "$dev"); VRAM_MIB=$mib; fi
    set_flags
    python3 - "$DATA/tune-report.json" "$dev" "$(quote "${FLAGS[@]}")" "${results[@]}" <<'PY'
import json, sys, time
path, chosen, flags, *rows = sys.argv[1:]
cands = [dict(zip(("device", "tok_s", "mem_stall_pct", "mib", "uma"), r.split())) for r in rows]
for c in cands:
    c.update(tok_s=float(c["tok_s"]), mem_stall_pct=int(c["mem_stall_pct"]), mib=int(c["mib"]), uma=c["uma"] == "1")
json.dump({"date": time.strftime("%F %T"), "test": "llama-bench tg64", "candidates": cands,
           "chosen": chosen, "flags": flags}, open(path, "w"), indent=1, ensure_ascii=False)
PY
    ok "chosen: $dev ($ts tok/s in the test) — report $DATA/tune-report.json"
  fi

  have_systemd=0
  command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1 && have_systemd=1
  # bootstrap run again: first free the port from the previous install
  [ "$have_systemd" = 1 ] && systemctl --user stop "$SOCKET" "$PROXY" "$UNIT" >/dev/null 2>&1 || true
  if [ -z "$PORT" ]; then PORT=8080; while ! port_free "$PORT"; do PORT=$((PORT + 1)); done; fi
  URL="http://127.0.0.1:$PORT/v1"; MODEL="$ALIAS"
  proxyd=""
  for p in /usr/lib/systemd/systemd-socket-proxyd /lib/systemd/systemd-socket-proxyd; do [ -x "$p" ] && proxyd="$p" && break; done
  if [ "$have_systemd" = 1 ] && [ "$IDLE" -gt 0 ] && [ -n "$proxyd" ]; then
    # start on demand: the socket on PORT wakes the model on the first request,
    # the proxy stops after IDLE min idle, and the server with it (StopWhenUnneeded) — VRAM and RAM are freed
    SERVER_PORT=$((PORT + 1)); while ! port_free "$SERVER_PORT"; do SERVER_PORT=$((SERVER_PORT + 1)); done
  else
    SERVER_PORT="$PORT"
  fi
  args=(-m "$MODEL_FILE" --host 127.0.0.1 --port "$SERVER_PORT" --alias "$ALIAS" "${FLAGS[@]}")
  if [ "$have_systemd" = 1 ]; then
    units="$CFG/systemd/user"; mkdir -p "$units"
    stamp="$(date +%Y%m%d-%H%M%S)"
    for u in "$UNIT" "$PROXY" "$SOCKET"; do [ -f "$units/$u" ] && cp -p "$units/$u" "$units/$u.bak-$stamp"; done
    systemctl --user disable "$UNIT" "$SOCKET" >/dev/null 2>&1 || true
    if [ "$SERVER_PORT" != "$PORT" ]; then
      cat >"$units/$UNIT" <<EOF
# freecode: local model server (generated by bootstrap.sh; GPU: $GPU, RAM ${RAM_GIB} GiB)
# Starts on demand via $SOCKET (port $PORT), stops after $IDLE min idle.
[Unit]
Description=llama.cpp for freecode ($ALIAS)
StopWhenUnneeded=yes

[Service]
ExecStart=$(quote "$LLAMA_DIR/llama-server" "${args[@]}")
# the proxy lets the first request through only once the model is in memory
ExecStartPost=/bin/sh -c 'for i in \$\$(seq 900); do curl -sf -m 2 http://127.0.0.1:$SERVER_PORT/health >/dev/null && exit 0; sleep 1; done; exit 1'
TimeoutStartSec=16min
# weights in swap/zram = several times slower (measured: 35B dropped from ~100 to 15–29 tok/s)
MemorySwapMax=0
Restart=on-failure
RestartSec=5
EOF
      cat >"$units/$PROXY" <<EOF
[Unit]
Description=Proxy $PORT -> llama.cpp freecode (stops after $IDLE min idle)
Requires=$UNIT
After=$UNIT

[Service]
ExecStart=$proxyd --exit-idle-time=${IDLE}min 127.0.0.1:$SERVER_PORT
EOF
      cat >"$units/$SOCKET" <<EOF
[Unit]
Description=Socket $PORT for freecode (the model starts on the first request)

[Socket]
ListenStream=127.0.0.1:$PORT

[Install]
WantedBy=sockets.target
EOF
      systemctl --user daemon-reload
      systemctl --user enable --now "$SOCKET" >/dev/null 2>&1
      ok "start on demand: $SOCKET (the model stops after $IDLE min idle)"
    else
      rm -f "$units/$PROXY" "$units/$SOCKET"
      cat >"$units/$UNIT" <<EOF
# freecode: local model server (generated by bootstrap.sh; GPU: $GPU, RAM ${RAM_GIB} GiB)
# Always on (--idle 0 or no systemd-socket-proxyd).
[Unit]
Description=llama.cpp for freecode ($ALIAS)

[Service]
ExecStart=$(quote "$LLAMA_DIR/llama-server" "${args[@]}")
# weights in swap/zram = several times slower (measured: 35B dropped from ~100 to 15–29 tok/s)
MemorySwapMax=0
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
      systemctl --user daemon-reload
      systemctl --user enable "$UNIT" >/dev/null 2>&1
      systemctl --user restart "$UNIT"
      ok "service $UNIT is always on"
      [ -n "$proxyd" ] || warn "no systemd-socket-proxyd — the model holds memory all the time"
    fi
    logs="journalctl --user -u $UNIT -n 30 --no-pager"
  else
    nohup "$LLAMA_DIR/llama-server" "${args[@]}" >"$DATA/llama-server.log" 2>&1 &
    warn "no systemd --user: the server runs in the background only until logout (log $DATA/llama-server.log)"
    logs="tail -30 $DATA/llama-server.log"
  fi
  echo "  loading the model on :$PORT…"
  for _ in $(seq 300); do curl -sf -m 2 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 2; done
  if ! curl -sf -m 2 "http://127.0.0.1:$PORT/health" >/dev/null; then
    $logs | tail -15 | sed 's/^/      /'
    fail "the server did not start within 10 min — if memory is short try a smaller model: --profile 9b or 4b"
  fi
  ok "server answers: $URL (model $ALIAS)"
fi

# ── 4. opencode ──────────────────────────────────────────────────────────────────────────────
echo "[bootstrap 4/6] opencode"
if ! command -v opencode >/dev/null; then
  if ! npm i -g @opencode/cli >/dev/null 2>&1; then
    # no rights to the global npm directory: install to ~/.npm-global, no sudo
    npm config set prefix "$HOME/.npm-global"
    export PATH="$HOME/.npm-global/bin:$PATH"
    npm i -g @opencode/cli >/dev/null
    warn "opencode is in ~/.npm-global/bin — add this directory to PATH in your shell profile"
  fi
fi
ok "opencode $(opencode --version 2>&1 | tail -1)"

# ── 5. repo + freecode + wtyczki ─────────────────────────────────────────────────────────────
echo "[bootstrap 5/6] opencode-config (installer steps follow)"
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$here" ] && [ -f "$here/install.sh" ] && [ -f "$here/freecode/freecode" ]; then
  REPO="$here"
elif [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only -q || fail "$DIR: git pull --ff-only failed (local changes?) — resolve it by hand"
  REPO="$DIR"
else
  git clone -q "$REPO_URL" "$DIR"; REPO="$DIR"
fi
ok "repo $REPO ($(git -C "$REPO" log -1 --format='%h %cs' 2>/dev/null || echo 'no git'))"

# freecode BEFORE install.sh: it writes opencode.json with the chosen model; install.sh does not touch an existing file
FREECODE_YES=1 FREECODE_URL="$URL" FREECODE_MODEL="$MODEL" python3 "$REPO/freecode/freecode" --configure 1 ||
  fail "freecode configuration failed — fix ~/.config/opencode/opencode.json per the messages above and run again"

installer=("$REPO/install.sh"); [ "$YES" = 1 ] && installer+=(-y)
"${installer[@]}" </dev/null || fail "install.sh ended with an error"

# stages 2–4: template, model work style, computer description (asks via /dev/tty; with -y default answers)
if [ "$YES" = 1 ]; then FREECODE_YES=1 "$BIN/freecode" --configure 234; else "$BIN/freecode" --configure 234; fi ||
  warn "freecode --configure 234 failed — run it again later"

# ── 6. kontrola ──────────────────────────────────────────────────────────────────────────────
echo "[bootstrap 6/6] Check"
"$BIN/freecode" --check || fail "freecode --check does not pass"
ok "$("$BIN/freecode" --version)"

if [ "$SMOKE" = 1 ]; then
  # a tool test: random text cannot be guessed, so a hit = the model really read the file
  work="$(mktemp -d)"; token="freecode-$RANDOM$RANDOM"; echo "$token" >"$work/probe.txt"
  echo "  test conversation…"
  if out="$(cd "$work" && timeout 600 "$BIN/freecode" run "Read the file probe.txt with the read tool and reply with its content only." 2>&1)" &&
     grep -qF "$token" <<<"$out"; then
    ok "the model answers and calls tools"
  else
    warn "the test failed — the model did not read the file. Last lines:"; tail -5 <<<"$out" | sed 's/^/      /'
    warn "common causes: not enough memory (try --profile 9b), a model without tool calls, a context window too small"
  fi
  rm -rf "$work"
fi

case ":$PATH:" in *":$BIN:"*) ;; *) warn "~/bin is not in PATH — add it to your shell profile or run ~/bin/freecode" ;; esac
echo "Done. Start: freecode   (in opencode: “tune the model” = skill freecode-tune; updates and repairs = skill freecode-autoconfig)"
}

main "$@"
