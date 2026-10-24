---
name: freecode-tune
description: Strojenie lokalnego serwera modeli (llama.cpp jako usługa systemd, z bootstrap.sh albo własna) pomiarem — AI proponuje zmianę flagi z białej listy, skrypt mierzy, lepsze zostaje, gorsze wraca. Użyj, gdy użytkownik mówi „dostrój model”, „przyspiesz model”, „kalibracja”, „freecode-tune”, „optymalne ustawienia”, „większy kontekst”, albo po zmianie sprzętu/RAM.
---

# freecode-tune: strojenie serwera modeli

Ty wybierasz, CO sprawdzić. Mierzy i decyduje skrypt `~/bin/freecode-tune` — jego werdykt jest ostateczny, nie oceniaj wyników sam i nie zmieniaj plików unitów ręcznie.

Zasady (cały skill):
- Każde wywołanie `bench` / `try` / `rollback` uruchamiaj narzędziem bash z `timeout: 1200000` (start modelu + 3 testy trwają 1–10 min). Jedno wywołanie na raz, nic równolegle.
- Działasz na tym samym serwerze, który stroisz. Podczas próby serwer się restartuje — to normalne; po powrocie narzędzia pierwsza odpowiedź może być wolniejsza.
- JEDNA zmiana na próbę (np. `try moe-cache=5600`), chyba że zmiany muszą iść razem (`n-cpu-moe=off moe-cache=4000`).
- NIE zmniejszaj `ctx`, chyba że użytkownik o to prosi — mniejsze okno może uciąć tę rozmowę.
- Limit: 6 prób na jedno polecenie użytkownika. Koniec wcześniej po 3 cofnięciach z rzędu.

## 1. Usługa i stan

```sh
~/bin/freecode-tune units
```
Lista usług z llama-server (nazwa, plik modelu). Wybierz tę, o którą chodzi użytkownikowi (np. „35B” → usługa z `35B` w nazwie pliku modelu). Niejasne albo kilka pasuje → zapytaj, nie zgaduj. Dalej KAŻDE polecenie z `-u NAZWA` (dosłownie z listy), np. `~/bin/freecode-tune -u llama-qwen36 status`. Pusta lista → STOP: strojenie obsługuje tylko llama.cpp uruchamiany jako usługa systemd --user.

Uwaga: strojenie innej usługi niż ta, na której działasz, może Cię zatrzymać na czas próby (usługi z `Conflicts=` dzielą kartę). Po próbie Twój model wstaje sam przy następnym zapytaniu.

```sh
~/bin/freecode-tune -u NAZWA status
```
- `! strażnik odsunął zmiany strojenia po awarii` → przekaż użytkownikowi ścieżkę; nie przywracaj tego pliku sam.
- `! flagi w unicie zmienione ręcznie po strojeniu` → najpierw `~/bin/freecode-tune -u NAZWA rebase` (przenosi strojone flagi na nowe ustawienia i czyści bazę), potem krok 2. `bench`/`try` przy takiej zmianie kończą się kodem 5 — wtedy to samo.
- Zapamiętaj: flagi teraz, wartości z białej listy, bazę (GOOD), ostatnie próby (nie powtarzaj prób już cofniętych przy tych samych pozostałych ustawieniach) i wynik kalibracji bootstrapu.

## 2. Baza

Linia `baza (GOOD): brak` → `~/bin/freecode-tune -u NAZWA bench`.
- Kod wyjścia 3 (`serwer właśnie liczy` albo `trwa inne strojenie`) → STOP, poproś użytkownika o chwilę bez innych sesji i strojeń.
- Kod 4 (`pomiar nieważny`) → STOP: użytkownik ma zamknąć duże programy (przeglądarka, gry), potem powtórz.
- Inaczej zapisz linię `wynik …` — to punkt odniesienia.

## 3. Co sprawdzać (kolejność od największego zysku)

Patrz na flagi z kroku 1:

| Sytuacja we flagach | Próby |
|---|---|
| `--cpu-moe` + `--moe-cache-mib N` (MoE, eksperci w RAM, cache na karcie) | `moe-cache` w górę o 512 aż do cofnięcia (zwykle brak VRAM); potem jedna próba w dół o 512, jeśli pierwsza w górę przegrała |
| `--cpu-moe` na karcie z dużym VRAM (≥ 16 GB) | `n-cpu-moe=` liczba warstw do RAM, np. 20, potem w dół o 5 |
| `-dev none` (samo CPU) | `threads=` liczba rdzeni fizycznych (`lscpu -p=CORE \| grep -v '^#' \| sort -u \| wc -l`), potem rdzenie − 1 |
| zawsze | `spec=none` raz — sprawdza, czy spekulacja ngram w ogóle pomaga na tym sprzęcie |
| karta z ≥ 12 GB VRAM albo wolny prompt (`prompt` < 300 tok/s) | `ubatch=1024`, potem `ubatch=2048 batch=2048` |
| użytkownik chce większy kontekst | `ctx` w górę o 16384 (zostaje, jeśli traci ≤ 3%) |
| `czekanie na pamięć` > 3% w bazie | `cache-ram` w dół (np. 1024) — mniej cache promptów, więcej RAM dla wag |

Nie wymyślaj kluczy spoza tabeli `status`. Skrypt i tak odrzuci inne (`nie jest na białej liście`, kod 2) — wtedy wybierz inną próbę, nie obchodź blokady.

## 4. Próba

```sh
~/bin/freecode-tune -u NAZWA try KLUCZ=WARTOŚĆ
```
Ostatnia linia:
- `✓ zostaje: wynik A → B (+x%)` → nowa baza; następną próbę licz od niej.
- `↩ cofnięte: …` → ustawienia wróciły do bazy. Przyczyna w linii: wynik za słaby, `serwer nie wstał` (zwykle brak pamięci — nie idź dalej w tę stronę) albo `pomiar zakłócony` (powtórz tę samą próbę raz; drugi raz zakłócony → STOP, poproś o zamknięcie programów).
- `UWAGA: po cofnięciu serwer nie wstał` → natychmiast `~/bin/freecode-tune -u NAZWA rollback` i STOP z dosłownym wyjściem.
- Kod 2 → błąd w Twoim poleceniu (zakres, klucz); popraw i spróbuj raz jeszcze.

## 5. Raport

Krótko, dosłowne liczby z wyjścia skryptu, bez upiększania:
1. baza na starcie (`wynik …` z kroku 2 albo `status`),
2. tabela prób: zmiana → werdykt → wynik,
3. ustawienia końcowe (`~/bin/freecode-tune -u NAZWA status`, linia `flagi:`),
4. co jeszcze warto sprawdzić następnym razem (próby, na które zabrakło limitu).

Wszystko cofa `~/bin/freecode-tune -u NAZWA rollback` (ustawienia sprzed strojenia). Historia prób: `~/.local/share/freecode/tune-history.jsonl`.
