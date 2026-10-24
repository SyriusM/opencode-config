#!/usr/bin/env bash
# Start od zera: llama.cpp + model z Hugging Face + opencode + opencode-config + freecode, bez AI.
# Rozpoznaje sprzęt (GPU, VRAM, RAM, sterownik) i dobiera wersję llama.cpp, model oraz flagi.
#
#   ./bootstrap.sh                 interaktywnie (pyta przed instalacją pakietów i pobieraniem)
#   ./bootstrap.sh -y              bez pytań (sudo i tak zapyta o hasło)
#   ./bootstrap.sh --dry-run       tylko pokaż wykryty sprzęt i plan, nic nie pobieraj
#   ./bootstrap.sh --profile 9b    wymuś model: 35b | 9b | 4b
#   ./bootstrap.sh --backend cpu   wymuś wersję llama.cpp: cuda-13 | cuda-12 | vulkan | cpu
#   ./bootstrap.sh --llama-tag latest  inny build llama.cpp (numer bNNNNN albo latest = najnowszy, niesprawdzony)
#   ./bootstrap.sh --port 8080     port serwera modeli (domyślnie pierwszy wolny od 8080)
#   ./bootstrap.sh --url http://127.0.0.1:8085/v1 --model ID   własny serwer zgodny z OpenAI (bez llama.cpp)
#   ./bootstrap.sh --dir ~/src/opencode-config                  gdzie sklonować repo
#   ./bootstrap.sh --no-smoke      bez próbnej rozmowy na końcu
#   ./bootstrap.sh --idle 30       model startuje na żądanie i wyłącza się po N min bezczynności (domyślnie 15; 0 = działa stale)
#
# Działa też jako: curl -fsSL https://raw.githubusercontent.com/SyriusM/opencode-config/main/bootstrap.sh | bash
# `~` i „cudzysłowy” w komunikatach są celowe (tekst dla człowieka)
# shellcheck disable=SC2088,SC1111
set -euo pipefail

# Całość w funkcji: przy `curl | bash` bash wczytuje cały skrypt, zanim cokolwiek uruchomi,
# więc żaden program w środku nie „zje” reszty skryptu ze standardowego wejścia.
main() {
REPO_URL="https://github.com/SyriusM/opencode-config"
LLAMA_RELEASES="https://api.github.com/repos/ggml-org/llama.cpp/releases"
# Przypięty build: llama.cpp wydaje kilka nocnych buildów dziennie i zmienia ustawienia domyślne
# (np. port 9931 zamiast 8080). Zmieniaj ręcznie, po teście na prawdziwym sprzęcie.
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
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" 2>/dev/null || echo "pomoc: $REPO_URL"; exit 0 ;;
    *) echo "Nieznana opcja: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$PROFILE" in ""|35b|9b|4b) ;; *) echo "--profile: 35b | 9b | 4b" >&2; exit 2 ;; esac
case "$BACKEND" in ""|cuda-13|cuda-12|vulkan|cpu) ;; *) echo "--backend: cuda-13 | cuda-12 | vulkan | cpu" >&2; exit 2 ;; esac
[[ "$IDLE" =~ ^[0-9]+$ ]] || { echo "--idle: liczba minut (0 = stale)" >&2; exit 2; }
[ -z "$URL" ] || [ -n "$MODEL" ] || { echo "--url wymaga --model (id z ADRES/models)" >&2; exit 2; }

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }
yes_no() { # yes_no "Pytanie" — domyślnie tak; przy curl | bash pyta przez /dev/tty
  local answer
  if [ "$YES" = 1 ] || [ ! -r /dev/tty ]; then return 0; fi
  read -r -p "  $1 [T/n]: " answer </dev/tty || true
  [[ "${answer:-t}" =~ ^[tTyY] ]]
}
models_at() { # models_at URL → id modeli, po jednym w linii (pusto = brak serwera)
  curl -s -m 3 "${1%/}/models" 2>/dev/null |
    python3 -c 'import json,sys; [print(m["id"]) for m in json.load(sys.stdin).get("data", []) if m.get("id")]' 2>/dev/null || true
}
quote() { # argumenty ze spacjami w cudzysłowach (składnia systemd i powłoki)
  local a out=()
  for a in "$@"; do [[ "$a" == *[[:space:]]* ]] && out+=("\"$a\"") || out+=("$a"); done
  echo "${out[*]}"
}
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
download() { # download URL PLIK — z paskiem postępu, wznawia przerwane (.part)
  [ -f "$2" ] && return 0
  mkdir -p "$(dirname "$2")"
  curl -fL --retry 3 -C - --progress-bar -o "$2.part" "$1" || return 1
  if [ -z "$3" ]; then warn "źródło nie podało sumy sha256 dla $(basename "$2") — bez sprawdzenia"
  elif ! echo "$3  $2.part" | sha256sum -c --quiet - >/dev/null 2>&1; then
    rm -f "$2.part"; fail "zła suma sha256 pliku $(basename "$2") — usunięty, uruchom ponownie"
  fi
  mv "$2.part" "$2"
}
hf_sha256() { # hf_sha256 URL — sha256 pliku LFS z nagłówka X-Linked-ETag Hugging Face
  curl -fsI -m 20 "$1" 2>/dev/null | tr -d '\r"' | awk 'tolower($1)=="x-linked-etag:" && $2 ~ /^[0-9a-f]{64}$/ {print $2}'
}

# ── 0. obecna konfiguracja ───────────────────────────────────────────────────────────────────
# Działający opencode (model w opencode.json + odpowiadający serwer) = bez pobierania i bez nowej usługi:
# ten sam adres idzie do `freecode --configure`, który istniejącego pliku nie nadpisuje.
if [ -z "$URL" ]; then
  current="$(python3 - "$CFG/opencode" <<'PY' 2>/dev/null || true
import json, os, sys, urllib.request
d = sys.argv[1]
path = next((os.path.join(d, n) for n in ("opencode.json", "opencode.jsonc") if os.path.isfile(os.path.join(d, n))), None)
c = json.load(open(path, encoding="utf-8"))   # .jsonc z komentarzami = wyjątek = brak wyniku
pid, _, model = (c.get("model") or "").partition("/")
url = (((c.get("provider") or {}).get(pid) or {}).get("options") or {}).get("baseURL")
# serwer na żądanie (gniazdo + proxy) budzi się kilkanaście sekund
with urllib.request.urlopen(url.rstrip("/") + "/models", timeout=60) as r:
    ids = [m.get("id") for m in json.load(r).get("data", [])]
print(url, model, path, "ok" if model in ids else "?")
PY
)"
  if [ -n "$current" ]; then
    read -r cur_url cur_model cur_file cur_state <<<"$current"
    echo "[bootstrap 0/6] Obecna konfiguracja"
    ok "$cur_file: model $cur_model na $cur_url"
    [ "$cur_state" = ok ] || warn "serwer odpowiada, ale nie zgłasza modelu „$cur_model” (llama.cpp z --alias albo serwer wielu modeli — zwykle w porządku)"
    if yes_no "Zostawić obecny serwer i model (bez pobierania llama.cpp i modelu)?"; then
      URL="$cur_url"; MODEL="$cur_model"; KEEP=1
    fi
  fi
fi

# ── 1. sprzęt ────────────────────────────────────────────────────────────────────────────────
echo "[bootstrap 1/6] Sprzęt"
RAM_GIB=$(( $(sed -n 's/^MemTotal: *\([0-9]*\) kB/\1/p' /proc/meminfo) / 1048576 ))
GPU="brak"; VRAM_MIB=0; DRIVER=0; IGPU=""
if command -v nvidia-smi >/dev/null && q="$(nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>/dev/null | head -1)" && [ -n "$q" ]; then
  GPU="$(cut -d, -f1 <<<"$q" | xargs)"; [[ "$GPU" == NVIDIA* ]] || GPU="NVIDIA $GPU"
  VRAM_MIB=$(cut -d, -f2 <<<"$q" | xargs)
  DRIVER=$(cut -d, -f3 <<<"$q" | xargs | cut -d. -f1)
else
  for d in /sys/class/drm/card[0-9]*/device; do
    case "$d" in */card*-*/device) continue ;; esac   # wyjścia monitorów (card1-DP-1), nie karty
    vendor="$(cat "$d/vendor" 2>/dev/null || true)"
    mib=$(( $(cat "$d/mem_info_vram_total" 2>/dev/null || echo 0) / 1048576 ))
    case "$vendor" in
      # grafika w procesorze (APU) ma jako „VRAM” tylko mały wycinek RAM — to nie osobna pamięć
      0x1002) if [ "$mib" -ge 4096 ]; then [ "$mib" -gt "$VRAM_MIB" ] && GPU="AMD" && VRAM_MIB=$mib; else IGPU="AMD"; fi ;;
      0x8086) IGPU="Intel" ;;
      0x10de) [ "$GPU" = brak ] && GPU="NVIDIA (bez nvidia-smi)" ;;   # pamięć poda llama.cpp przy kalibracji
    esac
  done
fi
ok "GPU: $GPU${IGPU:+ + zintegrowana $IGPU}, VRAM $(( VRAM_MIB / 1024 )) GiB, RAM ${RAM_GIB} GiB, CPU $(nproc) wątków"
# minimum (README „Minimalne wymagania”): najmniejszy model 4B + okno 16k zajmuje ~5 GB; komputer z 8 GB RAM
# pokazuje 7 GiB. Mniej = tylko zdalny serwer (--url), bo lokalnie model wypycha system do swapu.
if [ -z "$URL" ] && [ "$RAM_GIB" -lt 7 ] && [ $(( VRAM_MIB / 1024 )) -lt 6 ]; then
  fail "za mało pamięci na lokalny model (RAM ${RAM_GIB} GiB, minimum 8 GB RAM albo 6 GB VRAM) — użyj serwera na innym komputerze: --url http://ADRES:PORT/v1 --model ID"
fi
grep -qw avx2 /proc/cpuinfo 2>/dev/null || warn "procesor bez AVX2 — model na CPU będzie kilkukrotnie wolniejszy"

# wersja llama.cpp: CUDA na NVIDIA ze sterownikiem (najszybsza); przy innej karcie Vulkan, który działa też
# na samym CPU (-dev none) — którą kartę wziąć i czy w ogóle, rozstrzyga pomiar po pobraniu modelu
if [ -z "$BACKEND" ]; then
  if [[ "$GPU" == NVIDIA* ]] && [ "$DRIVER" -ge 580 ]; then BACKEND=cuda-13
  elif [[ "$GPU" == NVIDIA* ]] && [ "$DRIVER" -ge 570 ]; then BACKEND=cuda-12
  elif { [ "$GPU" != brak ] || [ -n "$IGPU" ]; } && ldconfig -p 2>/dev/null | grep 'libvulkan\.so\.1' >/dev/null; then BACKEND=vulkan
  else BACKEND=cpu; fi
fi
[ "$BACKEND" = cpu ] && VRAM_MIB=0
VRAM_GIB=$(( VRAM_MIB / 1024 ))

# Profil modelu. Qwen3.6-35B-A3B to MoE (3B aktywnych): eksperci mieszczą się w RAM, na GPU idzie reszta
# + cache ekspertów, więc działa szybko już przy 8 GB VRAM. W naszych testach zadań opencode:
# 35B 97%, 9B 78% (9B potrafi zmyślić wynik bez wywołania narzędzia), 4B nie nadaje się na model główny.
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
DEV_FLAGS=()   # wybór urządzenia z kalibracji Vulkana (pusto = domyślne llama.cpp)
set_flags() { # FLAGS dla PROFILE przy VRAM_MIB (osobna pamięć karty) + DEV_FLAGS
  VRAM_GIB=$(( VRAM_MIB / 1024 ))
  # próbkowanie wg zaleceń Qwena; limit myślenia, żeby model nie „myślał” bez końca
  FLAGS=(--jinja -fa on -np 1 --cache-ram 2048 --spec-type ngram-mod --top-k 20)
  local thinking=(--temp 0.6 --top-p 0.95) budget_msg="Thinking budget reached, answering now."
  VERIFIED=0
  case "$PROFILE" in
    35b) FLAGS+=("${thinking[@]}" --reasoning-budget 6144 --reasoning-budget-message "$budget_msg")
         if [ "$VRAM_GIB" -ge 22 ]; then
           FLAGS+=(-ngl all -c 131072)                    # całość na GPU
         elif [ "$VRAM_GIB" -ge 7 ]; then
           # zmierzone na RTX 3080 10 GB + 32 GB RAM: ~118 tok/s czat (CUDA; przez Vulkan ~64), prompt 41k bez OOM
           local cache=$(( VRAM_MIB - 5200 )); [ "$cache" -gt 8000 ] && cache=8000
           FLAGS+=(--cpu-moe --moe-cache-mib "$cache" -c 65536)
           [ "$VRAM_GIB" -ge 9 ] && [ "$VRAM_GIB" -le 11 ] && VERIFIED=1
         else
           FLAGS+=(-c 32768)                              # CPU / mała karta: warstwy rozkłada --fit
         fi ;;
    9b)  FLAGS+=("${thinking[@]}" --reasoning-budget 3072 --reasoning-budget-message "$budget_msg" -c 32768) ;;
    4b)  FLAGS+=(-c 16384 --temp 0.7 --top-p 0.8) ;;   # wersja Instruct bez myślenia: inne zalecenia
  esac
  FLAGS+=("${DEV_FLAGS[@]}")
}
set_flags
if [ -z "$URL" ]; then
  echo "  plan: llama.cpp $BACKEND, model $HF_FILE (~$SIZE_GB GB)"
  echo "        flagi: $(quote "${FLAGS[@]}")"
  if [ "$BACKEND" = vulkan ]; then ok "karta (albo samo CPU) zostanie wybrana pomiarem po pobraniu modelu"
  elif [ "$VERIFIED" = 1 ]; then ok "ten zestaw jest sprawdzony (RTX 3080 10 GB + 32 GB RAM)"
  else warn "ten zestaw NIE był jeszcze sprawdzany na takim sprzęcie — rozkład na GPU/RAM dobiera --fit llama.cpp; zgłoś wynik"; fi
  [ "$PROFILE" = 4b ] && warn "model 4B jest słaby do pracy z narzędziami — przy ≥ 14 GB RAM wybierz --profile 9b"
fi
[ "$KEEP" = 1 ] && echo "  plan: obecny serwer $URL (model $MODEL) — bez llama.cpp i modelu; dalej opencode, wtyczki i ~/bin (nadpisane pliki dostają kopię .bak-*)"
[ "$DRY" = 1 ] && { echo "--dry-run: koniec, nic nie pobrano"; exit 0; }

# ── 2. pakiety systemowe ─────────────────────────────────────────────────────────────────────
echo "[bootstrap 2/6] Wymagania"
missing=()
for c in curl git python3 node npm tar; do command -v "$c" >/dev/null || missing+=("$c"); done
if [ ${#missing[@]} -gt 0 ]; then
  pkgs=("${missing[@]/node/nodejs}")
  if command -v pacman >/dev/null; then cmd=(sudo pacman -S --needed --noconfirm "${pkgs[@]}")
  elif command -v apt-get >/dev/null; then cmd=(sudo apt-get install -y "${pkgs[@]}" python3-venv)
  elif command -v dnf >/dev/null; then cmd=(sudo dnf install -y "${pkgs[@]}")
  else fail "brakuje: ${missing[*]} — zainstaluj je menedżerem pakietów i uruchom ponownie"; fi
  yes_no "Brakuje: ${missing[*]}. Uruchomić: ${cmd[*]}?" || fail "bez ${missing[*]} nie da się kontynuować"
  "${cmd[@]}"
fi
python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' || fail "potrzebny Python ≥ 3.10"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || fail "potrzebny Node ≥ 20 (jest $(node --version))"
ok "python3 $(python3 -c 'import platform; print(platform.python_version())'), node $(node --version), git, curl"

# ── 3. llama.cpp + model ─────────────────────────────────────────────────────────────────────
echo "[bootstrap 3/6] Serwer modeli"
if [ -n "$URL" ]; then
  [ "$KEEP" = 1 ] || models_at "$URL" | grep -qxF "$MODEL" || fail "$URL nie ma modelu „$MODEL” (dostępne: $(models_at "$URL" | tr '\n' ' '))"
  ok "własny serwer $URL, model $MODEL"
else
  need_gb=$(( SIZE_GB + 3 )); [ -f "$MODEL_FILE" ] && need_gb=1
  free_gb=$(( $(df -Pk "$(mkdir -p "$DATA" && echo "$DATA")" | awk 'NR==2 {print $4}') / 1048576 ))
  [ "$free_gb" -ge "$need_gb" ] || fail "za mało miejsca w $DATA: wolne $free_gb GB, potrzeba ~$need_gb GB"

  # gotowe wydanie z GitHuba (CUDA w paczce razem z bibliotekami cudart — bez instalacji CUDA)
  case "$BACKEND" in
    cuda-13) suffix="ubuntu-cuda-13.4-x64"; extra="cudart-" ;;
    cuda-12) suffix="ubuntu-cuda-12.8-x64"; extra="cudart-" ;;
    vulkan)  suffix="ubuntu-vulkan-x64"; extra="" ;;
    cpu)     suffix="ubuntu-x64"; extra="" ;;
  esac
  [ "$(uname -m)" = x86_64 ] || fail "gotowe wydania llama.cpp dobieram tylko dla x86_64 — zbuduj llama.cpp sam i podaj --url"
  tag="$LLAMA_TAG"
  if [ "$tag" = latest ]; then
    tag="$(curl -fsS -m 20 "$LLAMA_RELEASES?per_page=20" | python3 -c "
import json, sys
for r in json.load(sys.stdin):
    names = {a['name'] for a in r['assets']}
    if f\"llama-{r['tag_name']}-bin-$suffix.tar.gz\" in names:
        print(r['tag_name']); break")" || fail "nie udało się odczytać wydań llama.cpp z GitHuba"
    warn "llama.cpp $tag — najnowszy build, niesprawdzony z freecode"
  fi
  [ -n "$tag" ] || fail "brak wydania llama.cpp dla $suffix"
  LLAMA_DIR="$DATA/llama.cpp/$tag-$BACKEND"
  if [ ! -x "$LLAMA_DIR/llama-server" ]; then
    yes_no "Pobrać llama.cpp $tag ($BACKEND)$([ -n "$extra" ] && echo ' + biblioteki CUDA, ~600 MB')?" || fail "bez llama.cpp nie ruszymy"
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
  "$LLAMA_DIR/llama-server" --version >/dev/null 2>&1 || fail "$LLAMA_DIR/llama-server nie startuje"
  ok "llama.cpp $tag ($BACKEND) w $LLAMA_DIR"

  if [ ! -f "$MODEL_FILE" ]; then
    yes_no "Pobrać model $HF_FILE z Hugging Face (~$SIZE_GB GB)?" || fail "bez modelu freecode nie ruszy"
    download "$HF/$HF_REPO/resolve/main/$HF_FILE" "$MODEL_FILE" "$(hf_sha256 "$HF/$HF_REPO/resolve/main/$HF_FILE")" || fail "pobieranie modelu przerwane — uruchom ponownie, wznowi od miejsca przerwania"
  fi
  ok "model $MODEL_FILE"

  if [ "$BACKEND" = vulkan ] && [ ${#DEV_FLAGS[@]} -eq 0 ]; then
    # Vulkan widzi naraz wszystkie karty, też zintegrowaną, i domyślnie dzieli model między nie.
    # Słaba grafika w procesorze bywa wolniejsza od samego CPU (Radeon 610M: 35B 8,7 tok/s, CPU 15,5),
    # więc każdy kandydat dostaje krótki llama-bench i wygrywa najszybsze generowanie.
    echo "  kalibracja: która karta (albo samo CPU) generuje najszybciej…"
    bench_log="$DATA/tune-bench.log"; : >"$bench_log"
    moe=(); [ "$PROFILE" = 35b ] && moe=(-ncmoe 99)   # eksperci w RAM, jak --cpu-moe w serwerze
    # pierwszy odczyt z dysku zaniżałby wynik pierwszego kandydata (zmierzone: 2,5 zamiast ~10 tok/s)
    [ "$RAM_GIB" -gt $(( SIZE_GB + 4 )) ] && cat "$MODEL_FILE" >/dev/null
    # Przy braku RAM wynik mierzy czekanie na pamięć, nie kartę (zmierzone: 3080 6,8 tok/s zamiast 29,
    # gdy system wypychał programy do zram). Dlatego dwie próby, lepsza wygrywa, a obok udział czasu
    # spędzonego na czekaniu na pamięć (PSI „full”; brak /proc/pressure = 0).
    psi_full() { sed -n 's/^full .*total=\([0-9]*\)/\1/p' /proc/pressure/memory 2>/dev/null || echo 0; }
    measure() { # measure ARGS… → "tok/s %czekania" (0 = nie wstało, szczegóły w $bench_log)
      local best="0 0" i p0 t0 ts stall
      for i in 1 2; do
        p0=$(psi_full); t0=$(date +%s%N)
        ts=$("$LLAMA_DIR/llama-bench" -m "$MODEL_FILE" -p 0 -n 64 -r 1 -o json "$@" 2>>"$bench_log" |
          python3 -c 'import json,sys; print(round(json.load(sys.stdin)[0]["avg_ts"], 1))' 2>/dev/null) || ts=0
        stall=$(( ( $(psi_full) - ${p0:-0} ) * 100000 / ( $(date +%s%N) - t0 ) ))   # µs / ns → %
        awk -v a="$ts" -v b="${best%% *}" 'BEGIN { exit !(a > b) }' && best="$ts $stall"
        [ "$ts" = 0 ] && break   # nie wstało — druga próba nic nie zmieni
      done
      echo "$best"
    }
    results=("cpu $(measure -dev none -ngl 0) 0 0")   # urządzenie, tok/s, %czekania, MiB, uma
    while read -r dev mib; do
      # uma: 1 = grafika na wspólnej pamięci z CPU; bez --no-host sterownik odrzuca zadania (brak pamięci)
      uma=$(sed -n "s/^ggml_vulkan: ${dev#Vulkan} = .*| uma: \([01]\) |.*/\1/p" "$bench_log" | head -1)
      host=(); [ "${uma:-0}" = 1 ] && host=(--no-host 1)
      results+=("$dev $(measure -dev "$dev" -ngl 99 "${host[@]}" "${moe[@]}") $mib ${uma:-0}")
    done < <("$LLAMA_DIR/llama-server" --list-devices 2>/dev/null |
             sed -n 's/^ *\(Vulkan[0-9]*\): .*(\([0-9]*\) MiB, [0-9]* MiB free)$/\1 \2/p')
    printf '%s\n' "${results[@]}" | awk '{printf "      %-8s %6s tok/s  czekanie na pamięć %s%%%s\n", $1, $2, $3, ($5 == 1 ? "  (zintegrowana)" : "")}'
    read -r dev ts stall mib uma < <(printf '%s\n' "${results[@]}" | sort -k2 -gr | head -1)
    [ "$ts" != 0 ] || fail "żaden wariant nie wstał — log: $bench_log"
    [ "$stall" -lt 10 ] || warn "pomiar zakłócony brakiem RAM ($stall% czasu na czekanie) — zamknij duże programy i uruchom bootstrap ponownie (pobrane pliki zostaną)"
    if [ "$dev" = cpu ]; then DEV_FLAGS=(-dev none); VRAM_MIB=0
    elif [ "$uma" = 1 ]; then
      DEV_FLAGS=(-dev "$dev" -ngl all --no-host); VRAM_MIB=0   # pamięć wspólna: cache ekspertów nic nie da
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
    ok "wybrane: $dev ($ts tok/s w teście) — raport $DATA/tune-report.json"
  fi

  have_systemd=0
  command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1 && have_systemd=1
  # ponowne uruchomienie bootstrapu: najpierw zwolnij port po poprzedniej instalacji
  [ "$have_systemd" = 1 ] && systemctl --user stop "$SOCKET" "$PROXY" "$UNIT" >/dev/null 2>&1 || true
  if [ -z "$PORT" ]; then PORT=8080; while ! port_free "$PORT"; do PORT=$((PORT + 1)); done; fi
  URL="http://127.0.0.1:$PORT/v1"; MODEL="$ALIAS"
  proxyd=""
  for p in /usr/lib/systemd/systemd-socket-proxyd /lib/systemd/systemd-socket-proxyd; do [ -x "$p" ] && proxyd="$p" && break; done
  if [ "$have_systemd" = 1 ] && [ "$IDLE" -gt 0 ] && [ -n "$proxyd" ]; then
    # start na żądanie: gniazdo na PORT budzi model przy pierwszym zapytaniu,
    # proxy wyłącza się po IDLE min bezczynności, a z nim serwer (StopWhenUnneeded) — VRAM i RAM wolne
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
# freecode: lokalny serwer modeli (wygenerowane przez bootstrap.sh; GPU: $GPU, RAM ${RAM_GIB} GiB)
# Startuje na żądanie przez $SOCKET (port $PORT), zatrzymuje się po $IDLE min bezczynności.
[Unit]
Description=llama.cpp dla freecode ($ALIAS)
StopWhenUnneeded=yes

[Service]
ExecStart=$(quote "$LLAMA_DIR/llama-server" "${args[@]}")
# proxy przepuści pierwsze zapytanie dopiero, gdy model jest w pamięci
ExecStartPost=/bin/sh -c 'for i in \$\$(seq 900); do curl -sf -m 2 http://127.0.0.1:$SERVER_PORT/health >/dev/null && exit 0; sleep 1; done; exit 1'
TimeoutStartSec=16min
# wagi w swapie/zram = kilkukrotnie wolniej (zmierzone: 35B spadał ze ~100 do 15–29 tok/s)
MemorySwapMax=0
Restart=on-failure
RestartSec=5
EOF
      cat >"$units/$PROXY" <<EOF
[Unit]
Description=Proxy $PORT -> llama.cpp freecode (wyłącza się po $IDLE min bezczynności)
Requires=$UNIT
After=$UNIT

[Service]
ExecStart=$proxyd --exit-idle-time=${IDLE}min 127.0.0.1:$SERVER_PORT
EOF
      cat >"$units/$SOCKET" <<EOF
[Unit]
Description=Gniazdo $PORT dla freecode (model startuje przy pierwszym zapytaniu)

[Socket]
ListenStream=127.0.0.1:$PORT

[Install]
WantedBy=sockets.target
EOF
      systemctl --user daemon-reload
      systemctl --user enable --now "$SOCKET" >/dev/null 2>&1
      ok "start na żądanie: $SOCKET (model wyłącza się po $IDLE min bezczynności)"
    else
      rm -f "$units/$PROXY" "$units/$SOCKET"
      cat >"$units/$UNIT" <<EOF
# freecode: lokalny serwer modeli (wygenerowane przez bootstrap.sh; GPU: $GPU, RAM ${RAM_GIB} GiB)
# Działa stale (--idle 0 albo brak systemd-socket-proxyd).
[Unit]
Description=llama.cpp dla freecode ($ALIAS)

[Service]
ExecStart=$(quote "$LLAMA_DIR/llama-server" "${args[@]}")
# wagi w swapie/zram = kilkukrotnie wolniej (zmierzone: 35B spadał ze ~100 do 15–29 tok/s)
MemorySwapMax=0
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
      systemctl --user daemon-reload
      systemctl --user enable "$UNIT" >/dev/null 2>&1
      systemctl --user restart "$UNIT"
      ok "usługa $UNIT działa stale"
      [ -n "$proxyd" ] || warn "brak systemd-socket-proxyd — model zajmuje pamięć cały czas"
    fi
    logs="journalctl --user -u $UNIT -n 30 --no-pager"
  else
    nohup "$LLAMA_DIR/llama-server" "${args[@]}" >"$DATA/llama-server.log" 2>&1 &
    warn "brak systemd --user: serwer działa w tle tylko do wylogowania (log $DATA/llama-server.log)"
    logs="tail -30 $DATA/llama-server.log"
  fi
  echo "  ładowanie modelu na :$PORT…"
  for _ in $(seq 300); do curl -sf -m 2 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 2; done
  if ! curl -sf -m 2 "http://127.0.0.1:$PORT/health" >/dev/null; then
    $logs | tail -15 | sed 's/^/      /'
    fail "serwer nie wstał w 10 min — przy braku pamięci spróbuj mniejszego modelu: --profile 9b albo 4b"
  fi
  ok "serwer odpowiada: $URL (model $ALIAS)"
fi

# ── 4. opencode ──────────────────────────────────────────────────────────────────────────────
echo "[bootstrap 4/6] opencode"
if ! command -v opencode >/dev/null; then
  if ! npm i -g @opencode/cli >/dev/null 2>&1; then
    # brak praw do globalnego katalogu npm: instalacja do ~/.npm-global, bez sudo
    npm config set prefix "$HOME/.npm-global"
    export PATH="$HOME/.npm-global/bin:$PATH"
    npm i -g @opencode/cli >/dev/null
    warn "opencode w ~/.npm-global/bin — dopisz ten katalog do PATH w profilu powłoki"
  fi
fi
ok "opencode $(opencode --version 2>&1 | tail -1)"

# ── 5. repo + freecode + wtyczki ─────────────────────────────────────────────────────────────
echo "[bootstrap 5/6] opencode-config (dalej kroki instalatora)"
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$here" ] && [ -f "$here/install.sh" ] && [ -f "$here/freecode/freecode" ]; then
  REPO="$here"
elif [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only -q || fail "$DIR: git pull --ff-only nie przeszedł (lokalne zmiany?) — rozwiąż ręcznie"
  REPO="$DIR"
else
  git clone -q "$REPO_URL" "$DIR"; REPO="$DIR"
fi
ok "repo $REPO ($(git -C "$REPO" log -1 --format='%h %cs' 2>/dev/null || echo 'bez gita'))"

# freecode PRZED install.sh: zapisuje opencode.json z wybranym modelem; install.sh istniejącego pliku nie rusza
FREECODE_YES=1 FREECODE_URL="$URL" FREECODE_MODEL="$MODEL" python3 "$REPO/freecode/freecode" --configure 1 ||
  fail "konfiguracja freecode nie przeszła — popraw ~/.config/opencode/opencode.json wg komunikatów wyżej i uruchom ponownie"

installer=("$REPO/install.sh"); [ "$YES" = 1 ] && installer+=(-y)
"${installer[@]}" </dev/null || fail "install.sh zakończył się błędem"

# etapy 2–4: wzorzec, styl pracy modelu, opis komputera (pyta przez /dev/tty; przy -y domyślne odpowiedzi)
if [ "$YES" = 1 ]; then FREECODE_YES=1 "$BIN/freecode" --configure 234; else "$BIN/freecode" --configure 234; fi ||
  warn "freecode --configure 234 nie przeszedł — uruchom ponownie później"

# ── 6. kontrola ──────────────────────────────────────────────────────────────────────────────
echo "[bootstrap 6/6] Kontrola"
"$BIN/freecode" --check || fail "freecode --check nie przechodzi"
ok "$("$BIN/freecode" --version)"

if [ "$SMOKE" = 1 ]; then
  # próba z narzędziem: losowego tekstu nie da się zgadnąć, więc trafienie = model naprawdę przeczytał plik
  work="$(mktemp -d)"; token="freecode-$RANDOM$RANDOM"; echo "$token" >"$work/probe.txt"
  echo "  próbna rozmowa…"
  if out="$(cd "$work" && timeout 600 "$BIN/freecode" run "Przeczytaj plik probe.txt narzędziem read i odpowiedz tylko jego zawartością." 2>&1)" &&
     grep -qF "$token" <<<"$out"; then
    ok "model odpowiada i wywołuje narzędzia"
  else
    warn "próba nie przeszła — model nie odczytał pliku. Ostatnie linie:"; tail -5 <<<"$out" | sed 's/^/      /'
    warn "częste przyczyny: za mało pamięci (spróbuj --profile 9b), model bez wywołań narzędzi, za małe okno kontekstu"
  fi
  rm -rf "$work"
fi

case ":$PATH:" in *":$BIN:"*) ;; *) warn "~/bin nie jest w PATH — dopisz do profilu powłoki albo uruchamiaj ~/bin/freecode" ;; esac
echo "Gotowe. Start: freecode   (w opencode: „dostrój model” = skill freecode-tune; aktualizacje i naprawy = skill freecode-autoconfig)"
}

main "$@"
