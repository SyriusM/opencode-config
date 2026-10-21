# Błąd opencode i rozwiązanie (2026-10-07)

OBJAW: ConnectionRefused Unable to connect przy zapytaniu do modelu, socket llama-qwen36-proxy w stanie failed (trigger-limit-hit)
PRZYCZYNA: dwa modele wyrzucały się z VRAM (Conflicts=), usługa nie wstawała i socket wpadł w pętlę aktywacji
NAPRAWA: systemctl --user reset-failed llama-qwen36-proxy.socket llama-qwen36.service; systemctl --user start llama-qwen36-proxy.socket; nie uruchamiać drugiego modelu w trakcie sesji
PRZYKŁAD: systemctl --user is-active llama-qwen36-proxy.socket
