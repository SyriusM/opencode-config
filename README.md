# opencode-config

Wtyczki i skrypty dla [opencode](https://opencode.ai) 2.x na **lokalnych modelach**. Pomagają ograniczyć powtarzanie tych samych błędów narzędzi i dają modelowi tło z [MemPalace](https://github.com/milla-jovovich/mempalace).

To czysty kod, bez konfiguracji modeli, promptów i danych.

## Zawartość

| Ścieżka | Co robi |
|---|---|
| `plugins/tool-input-fix` | Poprawia typowe błędy wejścia lokalnych modeli, zanim narzędzie ruszy: wyciek `</code>` z szablonu, `\"` poza stringami, ref-y Playwrighta, ms→s. Przerywa pętle identycznych nieudanych wywołań (`STOP` po 2×). Przy błędzie dokleja **ZNANE ROZWIĄZANIE** z kopalni wniosków. |
| `plugins/lesson-draft` | Po każdej turze zbiera błędy narzędzi ze strumienia zdarzeń. Powtarzający się wzorzec zapisuje jako szkic lekcji do ręcznego przeglądu (`~/tmp-opencode/lessons-draft.md`). |
| `plugins/palace-kontekst` + `bin/palace-kontekst` | Dokleja do promptu systemowego do 3 notatek z MemPalace dla katalogu sesji, tylko ze skrzydeł technicznych (próg podobieństwa 0,57). Gdy embeddingi nie działają, dokleja ostrzeżenie zamiast pustki. |
| `plugins/error-hook` | Zapisuje błędy narzędzi do JSONL (`~/mempalace/audit/`). |
| `plugins/auto-kopie` | Przed każdą zmianą plików konfiguracji robi kopię zapasową (cofanie: `bin/oc-kopie`). |
| `bin/oc-wniosek` | Kopalnia wniosków: `OBJAW / PRZYCZYNA / NAPRAWA / PRZYKŁAD` w plikach i w **osobnym** palace (`~/.mempalace-opencode`). Wnioski modeli nie mieszają się z pamięcią osobistą. Format: `kopalnia/PRZYKLAD.md`. |
| `bin/oc-regula` | Pozwala modelowi dopisać krótką regułę do bloku `WYUCZONE` w `AGENTS.md` (limit 10 linii, z kopią). |
| `bin/audyt-retencja` + `systemd/` | Co tydzień przenosi audyt starszy niż 30 dni do archiwum tar. Pliki kasuje dopiero po weryfikacji bajt w bajt. |

Ścieżki zakładają `~/bin`, `~/.config/opencode/plugins/<nazwa>/index.ts` i MemPalace w `~/mempalace` (venv) z embeddingami bge-m3 na `127.0.0.1:8089`.

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
