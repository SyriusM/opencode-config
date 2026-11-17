# opencode error and fix (2026-10-07)

SYMPTOM: ConnectionRefused Unable to connect on a model request, socket llama-qwen36-proxy in state failed (trigger-limit-hit)
CAUSE: two models evicted each other from VRAM (Conflicts=), the service did not start and the socket fell into an activation loop
FIX: systemctl --user reset-failed llama-qwen36-proxy.socket llama-qwen36.service; systemctl --user start llama-qwen36-proxy.socket; do not start a second model during a session
EXAMPLE: systemctl --user is-active llama-qwen36-proxy.socket
