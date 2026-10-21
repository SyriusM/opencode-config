# Błąd opencode i rozwiązanie (2026-10-07)

OBJAW: ReferenceError: Unknown identifier require / setTimeout / page w execute
PRZYCZYNA: execute to ograniczony JavaScript, nie Node i nie skrypt Playwrighta
NAPRAWA: wtyczka: wskazówki require-import, timer, page-playwright (wywołanie nie wykonuje się, model dostaje przykład)
PRZYKŁAD: await tools.playwright.browser_wait_for({time: 2}); const s = await tools.playwright.browser_snapshot(); console.log(s)
