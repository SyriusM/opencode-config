---
name: freecode-autoconfig
description: Instalacja, aktualizacja i konfiguracja freecode (opencode tylko na lokalnych modelach) razem z wtyczkami opencode-config — pobranie repo, instalator bez pytań, zapis bezpiecznego opencode.json, kontrola. Użyj, gdy użytkownik mówi „zainstaluj freecode”, „skonfiguruj freecode”, „zaktualizuj freecode / opencode-config”, „ustaw opencode na lokalny model”, „freecode --check nie przechodzi”.
---

# freecode: instalacja i konfiguracja

Wykonuj kroki PO KOLEI. Po każdej komendzie przeczytaj wyjście i porównaj z „oczekiwane”. Gdy wynik jest inny niż oczekiwany i krok nie mówi, co zrobić — STOP: wklej użytkownikowi dosłowne wyjście i zapytaj. Nie zgaduj i nie raportuj kroku, którego nie wykonałeś.

Zakazy (dotyczą całego skilla):
- NIE uruchamiaj `freecode` ani `opencode` bez argumentów (to TUI — zawiesi narzędzie) i NIE restartuj `opencode serve` — to może być serwer, na którym właśnie działasz.
- NIE używaj `sudo` bez zgody użytkownika. NIE kasuj `opencode.json` ani dostawców z niego — tylko freecode dopisuje brakujące pola (sam robi kopię).
- Pisz pełne ścieżki `~/bin/freecode`, bo `~/bin` może nie być w PATH.

Czysty system bez opencode i bez modelu: tego skilla nie da się uruchomić. Tam użytkownik wykonuje `bootstrap.sh` z repo (instaluje llama.cpp, model, opencode i freecode bez AI). Ten skill służy do aktualizacji i napraw.

Serwer postawiony przez bootstrap startuje na żądanie: gniazdo `freecode-llama-proxy.socket` budzi `freecode-llama.service` przy pierwszym zapytaniu, po 15 min bezczynności serwer sam się wyłącza. „inactive” przy `freecode-llama.service` to więc stan normalny, nie awaria. Stan: `systemctl --user status freecode-llama-proxy.socket freecode-llama --no-pager`, logi `journalctl --user -u freecode-llama -n 30 --no-pager`. Pierwsze zapytanie po przerwie może czekać do kilku minut (wczytywanie modelu). Nie restartuj usług bez zgody — to może być model, na którym działasz.

## 1. Stan obecny

```sh
~/bin/freecode --version; ~/bin/freecode --check; echo "EXIT=$?"
```
- `EXIT=0` → freecode jest zainstalowany i konfiguracja jest lokalna. Jeśli użytkownik prosił tylko o konfigurację — przejdź do kroku 6 (raport). Jeśli o aktualizację — krok 3.
- `No such file or directory` / `nie znaleziono` → brak freecode, idź do kroku 2.
- `EXIT=1` z listą problemów → zapamiętaj listę, idź do kroku 2.

## 2. Wymagania

```sh
python3 --version; node --version; git --version; curl --version | head -1; command -v opencode || echo "BRAK opencode"
```
Oczekiwane: Python ≥ 3.10, Node ≥ 20, git, curl. Brak któregoś z python3/node/git/curl → STOP, podaj użytkownikowi, czego brakuje (instalacja pakietów systemowych wymaga sudo — to jego decyzja).

Brak opencode:
```sh
npm i -g @opencode/cli && opencode --version
```
Błąd `EACCES` → nie używaj sudo. Zaproponuj użytkownikowi: `npm config set prefix ~/.npm-global` i dopisanie `~/.npm-global/bin` do PATH, potem powtórz.

Serwer modeli (sprawdź wszystkie porty jedną komendą):
```sh
for p in 8080 11434 1234 8000; do printf ':%s ' $p; curl -s -m 3 http://127.0.0.1:$p/v1/models | head -c 300; echo; done
```
Oczekiwane: przynajmniej jeden port zwraca JSON z `"data"` i `"id"` modelu. Zapamiętaj port i id modelu.
- Żaden port nie odpowiada, ale wiesz, na jakim porcie działasz ty sam (np. z `~/.config/opencode/opencode.json`, pole `baseURL`) → użyj tego adresu w kroku 4 jako `FREECODE_URL`.
- Nic nie odpowiada → STOP: freecode potrzebuje lokalnego serwera (llama.cpp, Ollama, LM Studio, vLLM). Pobierania modelu (gigabajty) nie zaczynaj bez zgody.

## 3. Repozytorium

```sh
ls -d ~/opencode-config ~/Projekty/opencode-config 2>/dev/null
```
- Jest katalog → aktualizacja: `git -C KATALOG pull --ff-only` (KATALOG = ścieżka z `ls`, dosłownie). Błąd `Not possible to fast-forward` albo lokalne zmiany → STOP, nie rób `reset`/`stash`, zapytaj.
- Brak → `git clone https://github.com/SyriusM/opencode-config ~/opencode-config`

Sprawdź: `ls KATALOG/install.sh KATALOG/freecode/freecode` — oba pliki muszą istnieć.

## 4. Instalacja (bez pytań)

```sh
cd KATALOG && ./install.sh -y 2>&1 | tail -40
```
Uwaga: bez MemPalace instalator sam tworzy venv i pobiera `mempalace` z PyPI (kilkaset MB, kilka minut). To normalne.
Oczekiwane w wyjściu: `6. Gotowe` i `Autotest: OK`. `Autotest: N błędów` → wklej użytkownikowi linie z `✗` i STOP.
Linie z `!` (ostrzeżenia, np. `~/bin nie jest w PATH`) przepisz do raportu, nie naprawiaj profilu powłoki sam.

## 5. Konfiguracja freecode

Serwer na standardowym porcie (8080, 11434, 1234, 8000):
```sh
FREECODE_YES=1 ~/bin/freecode --configure; echo "EXIT=$?"
```
Serwer na innym porcie (adres z kroku 2, id modelu dosłownie z `/v1/models`):
```sh
FREECODE_YES=1 FREECODE_URL=http://127.0.0.1:PORT/v1 FREECODE_MODEL=ID_MODELU ~/bin/freecode --configure; echo "EXIT=$?"
```
Co się dzieje:
- brak `~/.config/opencode/opencode.json` → freecode zapisuje nowy plik z `enabled_providers`, `small_model` i jednym modelem lokalnym;
- plik jest → freecode dopisuje tylko brakujące `enabled_providers` / `small_model` (z kopią `.bak-…`); niczego nie usuwa.

Oczekiwane: `EXIT=0`. `EXIT=1` z liniami `! …` (np. „dostawca X nie jest lokalny”) → STOP. Wklej linie użytkownikowi. Usunięcie dostawcy chmurowego albo dopisanie hosta LAN (`FREECODE_HOSTS`) to jego decyzja.

## 6. Kontrola i raport

```sh
~/bin/freecode --check; echo "EXIT=$?"; ~/bin/freecode --version
```
Oczekiwane: `EXIT=0` i linia `freecode … — nakładka na opencode …`.

Raport dla użytkownika (krótko, dosłowne wyniki, bez upiększania):
1. co było na starcie (krok 1),
2. co zainstalowano/zaktualizowano (krok 3–4: commit `git -C KATALOG log -1 --oneline`, `Autotest: …`),
3. jaki model i adres wpisano (krok 5),
4. wynik `--check` z kroku 6,
5. ostrzeżenia `!` do zrobienia przez użytkownika.

Na koniec napisz: „Uruchom w terminalu `freecode` — wtyczki wczytają się przy starcie.” Nie uruchamiaj go sam.
