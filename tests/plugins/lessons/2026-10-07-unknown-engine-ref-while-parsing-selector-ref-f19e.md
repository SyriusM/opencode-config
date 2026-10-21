# Błąd opencode i rozwiązanie (2026-10-07)

OBJAW: Unknown engine ref while parsing selector ref=f19e2 albo button[ref=f4e13] does not match any elements
PRZYCZYNA: model podaje ref w formie selektora CSS
NAPRAWA: wtyczka tool-input-fix (fixMcp, target-ref) wyciąga sam identyfikator
PRZYKŁAD: await tools.playwright.browser_click({target: "f19e2"})
