# Błąd opencode i rozwiązanie (przykład)

OBJAW: Unknown tool 'webfetch.webfetch'
PRZYCZYNA: wbudowane narzędzia woła się bezpośrednio, nie przez execute
NAPRAWA: webfetch wywołuj jako osobne narzędzie, execute tylko dla tools.* serwerów MCP
PRZYKŁAD: webfetch({url: "https://example.com"})
