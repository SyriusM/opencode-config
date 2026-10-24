# opencode-config

Wtyczki i skrypty dla [opencode](https://opencode.ai) 2.x na **lokalnych modelach**. Pomagają ograniczyć powtarzanie tych samych błędów narzędzi i dają modelowi tło z [MemPalace](https://github.com/MemPalace/mempalace).

To czysty kod, bez konfiguracji modeli, promptów i danych.

## Zawartość

| Ścieżka | Co robi |
|---|---|
| `plugins/tool-input-fix` | Poprawia typowe błędy wejścia lokalnych modeli, zanim narzędzie ruszy: wyciek `</code>` z szablonu, `\"` poza stringami, ref-y Playwrighta, ms→s. Przerywa pętle identycznych nieudanych wywołań (`STOP` po 2×). Przy błędzie dokleja **ZNANE ROZWIĄZANIE** z kopalni wniosków. |
| `plugins/lesson-draft` | Po każdej turze zbiera błędy narzędzi ze strumienia zdarzeń. Powtarzający się wzorzec zapisuje jako szkic lekcji do ręcznego przeglądu (`~/tmp-opencode/lessons-draft.md`). |
| `plugins/palace-context` + `bin/palace-context` | Dokleja do promptu systemowego do 3 notatek z MemPalace dla katalogu sesji, tylko ze skrzydeł wybranych przy instalacji (domyślnie wszystkich; próg podobieństwa 0,57). Gdy embeddingi nie działają, dokleja ostrzeżenie zamiast pustki. |
| `plugins/auto-thinking` | Dynamiczny limit myślenia dla wariantu „auto”: nowe polecenie → medium, udane narzędzie → low, błędy albo `LOOP-STOP` → high (podmienia `auto_thinking` na `thinking_budget_tokens` w zapytaniu). Gdy nie zadziała, serwer stosuje własny limit. |
| `plugins/no-call-guard` | Wykrywa turę, w której model pokazał komendę z „wynikiem”, ale nie wywołał narzędzia (zmyślony wynik). Domyślnie tylko loguje; z `NO_CALL_GUARD=act` dopisuje notkę, która każe uruchomić komendę albo przyznać, że jej nie uruchamiał. |
| `plugins/power-cost` | Wtyczka TUI: koszt prądu GPU od startu. Stawka: ręczna z `POWER_COST_PER_KWH` (+ `POWER_COST_CURRENCY`; stara `POWER_COST_PLN_PER_KWH` też działa), inaczej średnia dla gospodarstw domowych z Eurostatu (`nrg_pc_204`, 2500–4999 kWh/rok, z podatkami, ostatnie półrocze) dla kraju z `POWER_COST_COUNTRY` albo `LANG`, w walucie kraju, cache `~/.cache/power-cost.json` na 30 dni; bez sieci i cache 1,26 zł/kWh i stan karty z `nvidia-smi`. W pasku bocznym sekcja „Prąd i GPU” (model, waty i szczyt, obciążenie, temperatura, wentylator, VRAM, Wh, koszt/h, stawka i źródło), na dole skrót `⚡ koszt · W · °C`, widoczny też przy schowanym pasku. Tylko NVIDIA. |
| `plugins/error-hook` | Zapisuje błędy narzędzi do JSONL (`~/mempalace/audit/`). |
| `plugins/auto-backup` | Przed każdą zmianą plików konfiguracji robi kopię zapasową (cofanie: `bin/backup-copy`). |
| `bin/lesson-note` | Kopalnia wniosków: `OBJAW / PRZYCZYNA / NAPRAWA / PRZYKŁAD` w plikach i w **osobnym** palace (`~/.mempalace-opencode`). Wnioski modeli nie mieszają się z pamięcią osobistą. Format: `lessons/EXAMPLE.md`. |
| `bin/agent-rule` | Pozwala modelowi dopisać krótką regułę do bloku `LEARNED` w `AGENTS.md` (limit 10 linii, z kopią). |
| `freecode/freecode` | opencode tylko na lokalnych modelach: konfigurator przy pierwszym starcie, kontrola konfiguracji przed każdym startem (opis niżej). |
| `freecode/rebrand` | Kopia źródeł opencode z nazwą freecode (`rebrand SOURCE TARGET`; log `TARGET.log.tsv`, podsumowanie `TARGET.summary.md`). Czego nie można zmienić (licencja, domeny, repozytoria, zewnętrzne paczki npm, pliki binarne, logo), zapisuje do logu z plikiem i linią. Dodatkowo spisuje wszystkie adresy sieciowe w kodzie. |
| `bin/audit-retention` + `systemd/` | Co tydzień przenosi audyt starszy niż 30 dni do archiwum tar. Pliki kasuje dopiero po weryfikacji bajt w bajt. |

## Start od zera (`bootstrap.sh`)

Na czystym systemie jedna komenda stawia wszystko: llama.cpp, model z Hugging Face, opencode, wtyczki i freecode.

```sh
curl -fsSL https://raw.githubusercontent.com/SyriusM/opencode-config/main/bootstrap.sh | bash
./bootstrap.sh --dry-run   # z klonu repo: tylko pokaże wykryty sprzęt i plan
```

Skrypt rozpoznaje GPU, VRAM, RAM i sterownik, a potem dobiera:

| Sprzęt | llama.cpp | Model |
|---|---|---|
| NVIDIA, sterownik ≥ 580 / ≥ 570 | CUDA 13 / CUDA 12 (gotowe wydanie razem z bibliotekami CUDA) | |
| AMD, Intel (z Vulkanem) | Vulkan | |
| bez GPU | CPU | |
| RAM ≥ 28 GiB albo VRAM ≥ 22 GiB | | Qwen3.6-35B-A3B IQ4_NL (~18 GB; MoE: eksperci w RAM, reszta + cache ekspertów na GPU) |
| RAM ≥ 14 GiB albo VRAM ≥ 8 GiB | | Qwen3.5-9B Q4_K_XL (~6 GB) |
| mniej | | Qwen3-4B Instruct (~3 GB, słaby do narzędzi) |

**Minimalne wymagania** (lokalny model; poniżej tego bootstrap odmawia i proponuje `--url` z serwerem na innym komputerze):

| | Minimum | Lepiej |
|---|---|---|
| System | Linux x86_64 (gotowe wydania llama.cpp), Python ≥ 3.10, Node ≥ 20, git, curl | systemd --user (start na żądanie) |
| Pamięć | 8 GB RAM albo 6 GB VRAM — model 4B, słaby do pracy z narzędziami | 16 GB RAM → 9B; 32 GB RAM (albo 24 GB VRAM) → 35B |
| Procesor | x86_64; bez AVX2 działa, ale kilkukrotnie wolniej | AVX2, ≥ 6 rdzeni |
| Karta | niepotrzebna (samo CPU) | NVIDIA ze sterownikiem ≥ 570 (CUDA); AMD/Intel przez Vulkan — kalibracja sprawdza, czy w ogóle szybsza od CPU |
| Dysk | ~6 GB (4B), ~9 GB (9B), ~21 GB (35B) | NVMe (szybsze wczytywanie modelu) |

Minimum jest wyliczone z rozmiaru modelu i okna, **nie zmierzone na słabym sprzęcie**. Słabsze komputery (mniej RAM, ARM) to osobny temat: mniejsze modele albo serwer w LAN.

**Sprawdzony jest tylko zestaw RTX 3080 10 GB + 32 GB RAM** (35B, ~118 tok/s w czacie). Przy innym sprzęcie skrypt mówi to wprost, a rozkład warstw między GPU i RAM zostawia `--fit` llama.cpp. Build llama.cpp jest przypięty (`LLAMA_TAG` w skrypcie), bo nocne wydania zmieniają ustawienia domyślne.

Model startuje **na żądanie**: gniazdo `freecode-llama-proxy.socket` nasłuchuje na porcie, pierwsze zapytanie budzi `freecode-llama.service`, a po 15 min bezczynności serwer sam się wyłącza i zwalnia VRAM oraz RAM (ten sam układ co gniazda-proxy w naszym stacku). Pierwsze zapytanie po przerwie czeka, aż model się wczyta. `--idle N` zmienia czas, `--idle 0` = serwer działa stale. Wyłączenie na stałe: `systemctl --user disable --now freecode-llama-proxy.socket freecode-llama.service`; włączenie z powrotem: `systemctl --user enable --now freecode-llama-proxy.socket`. Pliki trafiają do `~/.local/share/freecode/` (`llama.cpp/`, `models/`). Na koniec skrypt robi próbę z narzędziem: model ma odczytać plik z losowym tekstem. Opcje: `--profile 35b|9b|4b`, `--backend cuda-13|cuda-12|vulkan|cpu`, `--llama-tag`, `--port`, `--url … --model …` (własny serwer), `--idle N`, `--no-smoke`.

**Kalibracja (Vulkan).** Vulkan widzi naraz każdą kartę, także grafikę w procesorze, a słaba zintegrowana bywa wolniejsza od samego CPU (Radeon 610M: 35B 8,7 tok/s, CPU 15,5). Dlatego po pobraniu modelu bootstrap mierzy `llama-bench` każdą kartę i samo CPU i bierze najszybsze. Do tego mierzy czas czekania na pamięć (PSI), bo przy braku RAM wynik mierzy swap, a nie kartę. Raport trafia do `~/.local/share/freecode/tune-report.json`.

**Strojenie: `freecode-tune` + skill `freecode-tune`.** Po instalacji można poprosić model w freecode: „dostrój model”. Model wybiera zmianę flagi z białej listy (`ctx`, `moe-cache`, `n-cpu-moe`, `spec`, `threads`, `ubatch`, `batch`, `cache-ram`, każda w zakresie), a `~/bin/freecode-tune try KLUCZ=WARTOŚĆ` restartuje serwer i mierzy czat, przepisywanie kodu i długi prompt (~60% okna). Zmiana zostaje tylko wtedy, gdy wynik rośnie o ≥ 3% (albo większy kontekst traci ≤ 3%), a inaczej wraca. Model proponuje, skrypt rozstrzyga. Zmiany siedzą w drop-inie `freecode-llama.service.d/tune.conf`, a `freecode-tune rollback` przywraca ustawienia z bootstrapu. Ręcznie: `freecode-tune status`, `freecode-tune bench`. Własne usługi z llama-server też: `freecode-tune units`, potem `-u NAZWA` (zmiany idą do `NAZWA.service.d/tune.conf`). Gdy usługa ma `--mmproj`, pomiar wysyła też obrazek — zmiana, po której serwer pada na obrazku, wraca. Uwaga: `tune.conf` ma całą linię startu, więc ręczna zmiana flag w unicie po strojeniu nie zadziała — `freecode-tune status` to pokaże, a `freecode-tune rebase` przeniesie strojenie na nowe flagi.

## Instalacja

Wymagania: Linux, Python ≥ 3.10, opencode 2.x (`npm i -g @opencode/cli`), lokalny serwer modeli z API zgodnym z OpenAI (llama.cpp, Ollama, vLLM…).

```sh
git clone https://github.com/SyriusM/opencode-config && cd opencode-config
./install.sh          # pyta o MemPalace, port embeddingów i skrzydła; -y = wartości domyślne
./install.sh --check  # autotest istniejącej instalacji
./install.sh --uninstall
```

Co robi instalator:

1. Szuka MemPalace (`$MEMPALACE_PYTHON`, `~/mempalace/.venv`, potem systemowy `python3`). Jeśli go nie ma, proponuje venv w `~/.local/share/opencode-config/venv` i instalację z PyPI. Pyta o port serwera embeddingów do kontroli zdrowia: `0` = wbudowane w MemPalace, bez serwera (domyślnie), `8080` = llama.cpp, `11434` = Ollama.
2. Szuka serwera modeli na `127.0.0.1:8080` (llama.cpp) i `127.0.0.1:11434` (Ollama). Jeśli znajdzie, a nie masz jeszcze `~/.config/opencode/opencode.json`, proponuje jego zapis z pierwszym modelem z listy (z `enabled_providers` i lokalnym `small_model`). Istniejącego pliku nie rusza.
3. Kopiuje wtyczki do `~/.config/opencode/plugins/` (opencode wczytuje je stamtąd sam, nie trzeba ich wpisywać do `opencode.json`), skrypty do `~/bin/`, a ustawienia zapisuje w `~/.config/opencode-config/config`. Nadpisywane pliki dostają kopię `.bak-…`.
4. Włącza timer `audit-retention` (systemd `--user`, jeśli jest) i uruchamia autotest.

`~/bin` powinien być w `PATH`, bo model wywołuje `lesson-note` i `agent-rule` przez powłokę. Instalator ostrzega, jeśli nie jest.

## freecode: opencode tylko na lokalnych modelach

opencode 2.x bez poprawnej konfiguracji po cichu wysyła rozmowę do darmowych modeli w chmurze. Sprawdzone w kontenerze z 2.0.24:

| Sytuacja | Dokąd idzie prompt |
|---|---|
| brak `opencode.json` | chmura (`opencode/fledge-alpha-free`) |
| uszkodzony JSON | chmura (`exo-free`), bez komunikatu o błędzie |
| `enabled_providers` bez `small_model` | rozmowa lokalnie, **tytuły sesji do chmury** |
| `enabled_providers` + lokalny `small_model` | wszystko lokalnie |

Do tego usługa w tle (`opencode serve --service`) trzyma konfigurację z chwili swojego startu, więc poprawka pliku nie działa od razu.

`freecode` to **nakładka, nie fork**. opencode instalujesz i aktualizujesz normalnie (`npm i -g @opencode/cli`), a freecode przy każdym starcie pilnuje, żeby działał tylko na lokalnych modelach. `freecode --version` pokazuje obie wersje, np. `freecode 0.1 — nakładka na opencode 2.0.24, tylko lokalne modele`. Po aktualizacji opencode zmień wersję w `.github/workflows/test.yml`, a test pokaże, czy nakładka dalej działa.

Co robi:

- **przy pierwszym starcie** odpala konfigurator. Ten wykrywa lokalny serwer (llama.cpp :8080, Ollama :11434, LM Studio :1234, vLLM :8000) i zapisuje bezpieczny `opencode.json`. Do istniejącego pliku proponuje dopisać `enabled_providers` i `small_model`, z kopią zapasową. Ponowne uruchomienie: `freecode --configure`;
- **przy każdym starcie** sprawdza wszystkie źródła konfiguracji: globalne, `$OPENCODE_CONFIG`, `$OPENCODE_CONFIG_CONTENT` i pliki projektu aż do korzenia repozytorium. Odmawia startu, jeśli JSON jest uszkodzony albo którykolwiek model czy dostawca nie jest lokalny (localhost, 127.0.0.0/8, ::1, hosty z `FREECODE_HOSTS`);
- uruchamia opencode z `--standalone`, czyli z własnym serwerem z właśnie sprawdzoną konfiguracją, oraz z `OPENCODE_DISABLE_AUTOUPDATE` i `OPENCODE_DISABLE_MODELS_FETCH`.

```sh
freecode                 # TUI
freecode run "pytanie"   # jednorazowo
freecode --check         # tylko kontrola
```

Ograniczenie: freecode nie blokuje sieci. Narzędzia `webfetch`/`websearch` i serwery MCP nadal mogą łączyć się z internetem, a pilnowana jest tylko wysyłka promptów do modeli.

## Model: przykładowy `opencode.json`

Gdy instalator nie wykrył serwera albo masz model na innym porcie, zapisz `~/.config/opencode/opencode.json` ręcznie:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "enabled_providers": ["local"],
  "model": "local/qwen3-8b",
  "small_model": "local/qwen3-8b",
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8080/v1" },
      "models": { "qwen3-8b": { "name": "Qwen3 8B (lokalnie)" } }
    }
  }
}
```

`enabled_providers` i `small_model` są obowiązkowe, bo bez nich opencode korzysta z chmury (patrz freecode). Nazwa modelu (`qwen3-8b`) musi się zgadzać z tym, co serwer zwraca pod `/v1/models`. Model musi umieć wywoływać narzędzia. Dla llama.cpp oznacza to uruchomienie `llama-server` z `--jinja`.

## `AGENTS.md` (opcjonalnie)

Wtyczki działają bez tego pliku. Żeby model sam zapisywał wnioski i reguły, dopisz do `~/.config/opencode/AGENTS.md`:

```markdown
## Błędy narzędzi
Zanim zaczniesz szukać przyczyny błędu narzędzia, sprawdź `~/bin/lesson-note search "komunikat"`.
Gdy rozwiążesz nowy błąd, zapisz wniosek: `~/bin/lesson-note add "OBJAW" "PRZYCZYNA" "NAPRAWA" "PRZYKŁAD"`.

## Reguły wyuczone
Jedyne miejsce, w którym możesz sam dopisać regułę, i tylko poleceniem `~/bin/agent-rule add "co robić + przykład"`.
<!-- LEARNED:START -->
<!-- LEARNED:END -->
```

Bez znaczników `LEARNED` polecenie `agent-rule` odmawia zapisu. Starsze nazwy (`WYUCZONE`, `dodaj`, `szukaj`, `--sprawdz`, `FREECODE_HOSTY`) nadal działają.

## Gdzie co ląduje

| Ścieżka | Zawartość |
|---|---|
| `~/.mempalace/hook_state/*.log` | logi wtyczek (pierwsze miejsce do sprawdzenia, gdy coś nie działa) |
| `~/mempalace/audit/errors_RRRRMMDD.jsonl` | błędy narzędzi (`error-hook`) |
| `~/tmp-opencode/lessons-draft.md` | szkice lekcji (`lesson-draft`, gdy ten sam błąd powtórzy się ≥ 2× w turze) |
| `~/oc-audyt/kopalnia/`, `~/.mempalace-opencode` | kopalnia wniosków |
| `~/oc-audyt/auto-kopie/` | kopie plików konfiguracji |

Deinstalacja usuwa tylko zainstalowane pliki. Dane z tabeli, ustawienia i venv zostają, usuń je ręcznie.

## Testy

Przetestowane w czystym kontenerze Arch Linux z opencode 2.0.24: instalacja, autotest, deinstalacja oraz pełna sesja `opencode run` na atrapie serwera OpenAI. W tej sesji wszystkie wtyczki się ładują, `error-hook` i `lesson-draft` zapisują błędy narzędzia, a `palace-context` dokleja notatkę do promptu systemowego.

Ten sam test uruchamia GitHub Actions przy każdym pushu (`.github/workflows/test.yml`: shellcheck, składnia wtyczek przez esbuild, `tests/e2e.sh`). Lokalnie tylko w kontenerze, bo test instaluje wszystko od zera:

```sh
docker run --rm -v "$PWD":/repo:ro archlinux bash -c 'pacman -Syu --noconfirm --needed nodejs npm python curl diffutils >/dev/null && npm i -g --ignore-scripts=false @opencode/cli@2.0.24 >/dev/null && (cd "$(npm root -g)/@opencode/cli" && node postinstall.mjs) && cp -r /repo /tmp/oc && /tmp/oc/tests/e2e.sh'
```

Testy zachowania wtyczek (`tool-input-fix`, `no-call-guard`) nie potrzebują kontenera ani opencode, tylko Node 22:

```sh
tests/plugins/run.sh              # wtyczki z repo
tests/plugins/run.sh ~/.config/opencode/plugins   # wtyczki zainstalowane
```

Każdy test działa na sztucznym katalogu domowym w `/tmp`. Sprawdzają m.in. 92 przypadki poprawek i wskazówek (`tests/plugins/cases.json`, `@HOME@` = katalog domowy), treść wskazówek o zgadywanych ścieżkach, hamulec pętli z eskalacją, STOP przy powtarzanym „No changes to apply”, dostarczanie wskazówek dla read/edit/write w wyniku wywołania i wskazówkę „najpierw wczytaj plik”. Wskazówki dla `ls`/`cat`/`find`/`cp` rozpoznają ścieżki bezwzględne tylko w postaci `/home/<user>/…`, dlatego te przypadki są zapisane jako `~/…`.

## API wtyczek opencode 2.0.24 (zmierzone, nie z dokumentacji)

- Moduł: `export default { id, async setup(ctx) { … } }`. Wtyczka dostaje osobną instancję dla każdej lokalizacji, a strumień zdarzeń jest wspólny, więc trzeba deduplikować po `event.id`.
- `ctx` ma m.in. `location`, `session`, `tool`, `event`, `mcp`, `storage`. **Nie ma `ctx.client`.**
- Katalog sesji: `ctx.location.directory`. `process.cwd()` to katalog startu serwera.
- Prompt systemowy: `ctx.session.hook("context", async (p) => p.system.push({type: "text", text}))`. Pola `p`: `sessionID, model, system, messages, options, agent, tools`.
- Narzędzia: `ctx.tool.hook("execute.before" | "execute.after", cb)`. Wejście zmienia się przez `ev.input = …`.
- Zdarzenia: `ctx.event.subscribe()`. **`session.idle` nie istnieje.**
  - Koniec tury to `session.execution.succeeded|failed`.
  - `sessionID` jest w `event.data.sessionID`.
  - Błąd narzędzia to `session.tool.failed` (`data.error.message`, `data.id`).
  - Nazwa narzędzia jest w `session.tool.input.started` (`data.name`), a nie w `session.tool.called`.

## Podziękowania

To repozytorium to tylko cienka warstwa na pracy wielu ludzi, którzy oddali ją za darmo. Bez nich nic z tego by nie działało.

- **Linus Torvalds** i społeczność [Linuksa](https://kernel.org), **GNU**, **systemd**, [Arch Linux](https://archlinux.org) i [CachyOS](https://cachyos.org) — system, na którym to wszystko stoi.
- **Georgi Gerganov** i współtwórcy [llama.cpp](https://github.com/ggml-org/llama.cpp) — serwer, który uruchamia modele na zwykłej karcie.
- **Iwan Kawrakow** — autor kwantyzacji k-quants i i-quants w llama.cpp (plik `IQ4_NL`, na którym chodzi tu model 35B, to jego praca) oraz [ik_llama.cpp](https://github.com/ikawrakow/ik_llama.cpp).
- Zespół **Qwen** (Alibaba), **Google** (Gemma), **BAAI** (bge-m3) — otwarte modele.
- [unsloth](https://unsloth.ai) — kwantyzacje modeli z zachowaną warstwą MTP.
- Twórcy [opencode](https://opencode.ai) — harness, który te wtyczki rozszerzają.
- [MemPalace](https://github.com/MemPalace/mempalace) — pamięć dla modelu.
- [Anthropic](https://anthropic.com) — Claude pomagał projektować, pisać i mierzyć większość tego kodu.
- [SyriusM](https://github.com/SyriusM) — sobie, za to, że ta lista mogła powstać.

## Licencja

MIT
