# opencode-config

Wtyczki i skrypty dla [opencode](https://opencode.ai) 2.x na **lokalnych modelach**. Pomagają ograniczyć powtarzanie tych samych błędów narzędzi i dają modelowi tło z [MemPalace](https://github.com/MemPalace/mempalace).

To czysty kod, bez konfiguracji modeli, promptów i danych.

## Zawartość

| Ścieżka | Co robi |
|---|---|
| `plugins/tool-input-fix` | Poprawia typowe błędy wejścia lokalnych modeli, zanim narzędzie ruszy: wyciek `</code>` z szablonu, `\"` poza stringami, ref-y Playwrighta, ms→s. Przerywa pętle identycznych nieudanych wywołań (`STOP` po 2×). Przy błędzie dokleja **ZNANE ROZWIĄZANIE** z kopalni wniosków. |
| `plugins/lesson-draft` | Po każdej turze zbiera błędy narzędzi ze strumienia zdarzeń. Powtarzający się wzorzec zapisuje jako szkic lekcji do ręcznego przeglądu (`~/tmp-opencode/lessons-draft.md`). |
| `plugins/palace-kontekst` + `bin/palace-kontekst` | Dokleja do promptu systemowego do 3 notatek z MemPalace dla katalogu sesji, tylko ze skrzydeł wybranych przy instalacji (domyślnie wszystkich; próg podobieństwa 0,57). Gdy embeddingi nie działają, dokleja ostrzeżenie zamiast pustki. |
| `plugins/error-hook` | Zapisuje błędy narzędzi do JSONL (`~/mempalace/audit/`). |
| `plugins/auto-kopie` | Przed każdą zmianą plików konfiguracji robi kopię zapasową (cofanie: `bin/oc-kopie`). |
| `bin/oc-wniosek` | Kopalnia wniosków: `OBJAW / PRZYCZYNA / NAPRAWA / PRZYKŁAD` w plikach i w **osobnym** palace (`~/.mempalace-opencode`). Wnioski modeli nie mieszają się z pamięcią osobistą. Format: `kopalnia/PRZYKLAD.md`. |
| `bin/oc-regula` | Pozwala modelowi dopisać krótką regułę do bloku `WYUCZONE` w `AGENTS.md` (limit 10 linii, z kopią). |
| `freecode/freecode` | opencode tylko na lokalnych modelach: konfigurator przy pierwszym starcie, kontrola konfiguracji przed każdym startem (opis niżej). |
| `bin/audyt-retencja` + `systemd/` | Co tydzień przenosi audyt starszy niż 30 dni do archiwum tar. Pliki kasuje dopiero po weryfikacji bajt w bajt. |

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
4. Włącza timer `audyt-retencja` (systemd `--user`, jeśli jest) i uruchamia autotest.

`~/bin` powinien być w `PATH`, bo model wywołuje `oc-wniosek` i `oc-regula` przez powłokę. Instalator ostrzega, jeśli nie jest.

## freecode: opencode tylko na lokalnych modelach

opencode 2.x bez poprawnej konfiguracji po cichu wysyła rozmowę do darmowych modeli w chmurze. Sprawdzone w kontenerze z 2.0.24:

| Sytuacja | Dokąd idzie prompt |
|---|---|
| brak `opencode.json` | chmura (`opencode/fledge-alpha-free`) |
| uszkodzony JSON | chmura (`exo-free`), bez komunikatu o błędzie |
| `enabled_providers` bez `small_model` | rozmowa lokalnie, **tytuły sesji do chmury** |
| `enabled_providers` + lokalny `small_model` | wszystko lokalnie |

Do tego usługa w tle (`opencode serve --service`) trzyma konfigurację z chwili swojego startu, więc poprawka pliku nie działa od razu.

`freecode` to nakładka na niezmieniony opencode:

- **przy pierwszym starcie** odpala konfigurator. Ten wykrywa lokalny serwer (llama.cpp :8080, Ollama :11434, LM Studio :1234, vLLM :8000) i zapisuje bezpieczny `opencode.json`. Do istniejącego pliku proponuje dopisać `enabled_providers` i `small_model`, z kopią zapasową. Ponowne uruchomienie: `freecode --konfiguruj`;
- **przy każdym starcie** sprawdza wszystkie źródła konfiguracji: globalne, `$OPENCODE_CONFIG`, `$OPENCODE_CONFIG_CONTENT` i pliki projektu aż do korzenia repozytorium. Odmawia startu, jeśli JSON jest uszkodzony albo którykolwiek model czy dostawca nie jest lokalny (localhost, 127.0.0.0/8, ::1, hosty z `FREECODE_HOSTY`);
- uruchamia opencode z `--standalone`, czyli z własnym serwerem z właśnie sprawdzoną konfiguracją, oraz z `OPENCODE_DISABLE_AUTOUPDATE` i `OPENCODE_DISABLE_MODELS_FETCH`.

```sh
freecode                 # TUI
freecode run "pytanie"   # jednorazowo
freecode --sprawdz       # tylko kontrola
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
Zanim zaczniesz szukać przyczyny błędu narzędzia, sprawdź `~/bin/oc-wniosek szukaj "komunikat"`.
Gdy rozwiążesz nowy błąd, zapisz wniosek: `~/bin/oc-wniosek dodaj "OBJAW" "PRZYCZYNA" "NAPRAWA" "PRZYKŁAD"`.

## Reguły wyuczone
Jedyne miejsce, w którym możesz sam dopisać regułę, i tylko poleceniem `~/bin/oc-regula dodaj "co robić + przykład"`.
<!-- WYUCZONE:START -->
<!-- WYUCZONE:END -->
```

Bez znaczników `WYUCZONE` polecenie `oc-regula` odmawia zapisu.

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

Przetestowane w czystym kontenerze Arch Linux z opencode 2.0.24: instalacja, autotest, deinstalacja oraz pełna sesja `opencode run` na atrapie serwera OpenAI. W tej sesji wszystkie wtyczki się ładują, `error-hook` i `lesson-draft` zapisują błędy narzędzia, a `palace-kontekst` dokleja notatkę do promptu systemowego.

Ten sam test uruchamia GitHub Actions przy każdym pushu (`.github/workflows/test.yml`: shellcheck, składnia wtyczek przez esbuild, `tests/e2e.sh`). Lokalnie tylko w kontenerze, bo test instaluje wszystko od zera:

```sh
docker run --rm -v "$PWD":/repo:ro archlinux bash -c 'pacman -Syu --noconfirm --needed nodejs npm python curl diffutils >/dev/null && npm i -g --ignore-scripts=false @opencode/cli@2.0.24 >/dev/null && (cd "$(npm root -g)/@opencode/cli" && node postinstall.mjs) && cp -r /repo /tmp/oc && /tmp/oc/tests/e2e.sh'
```

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

## Licencja

MIT
