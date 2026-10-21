# Błąd opencode i rozwiązanie (2026-10-07)

OBJAW: Klik: Timeout 5000ms exceeded, element is outside of the viewport
PRZYCZYNA: wybrany ref to duplikat linku w ukrytym, wysuwanym menu (leży poza ekranem)
NAPRAWA: wziąć inny ref z tym samym tekstem albo otworzyć jego href przez browser_navigate
PRZYKŁAD: await tools.playwright.browser_navigate({url: "HREF_LINKU"})
