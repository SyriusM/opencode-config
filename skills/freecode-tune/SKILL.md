---
name: freecode-tune
description: Tune the local model server (llama.cpp as a systemd service, from bootstrap.sh or your own) by measurement — the AI proposes an allow-listed flag change, the script measures, better stays, worse is rolled back. Use when the user says "tune the model", "speed up the model", "calibrate", "freecode-tune", "optimal settings", "bigger context", or after a hardware/RAM change.
---

# freecode-tune: tuning the model server

You choose WHAT to try. The script `~/bin/freecode-tune` measures and decides — its verdict is final; do not judge results yourself and do not edit unit files by hand.

Rules (whole skill):
- Run every `bench` / `try` / `rollback` with the bash tool and `timeout: 1200000` (model start + 3 tests take 1–10 min). One call at a time, nothing in parallel.
- You run on the same server you are tuning. It restarts during a try — that is normal; after it comes back, the first tool reply may be slower.
- ONE change per try (e.g. `try moe-cache=5600`), unless the changes must go together (`n-cpu-moe=off moe-cache=4000`).
- Do NOT lower `ctx` unless the user asks — a smaller window can cut off this conversation.
- Limit: 6 tries per user request. Stop earlier after 3 rollbacks in a row.

## 1. Service and state

```sh
~/bin/freecode-tune units
```
Lists services running llama-server (name, model file). Pick the one the user means (e.g. "35B" → the service with `35B` in the model file name). Unclear or several match → ask, do not guess. From then on EVERY command uses `-u NAME` (verbatim from the list), e.g. `~/bin/freecode-tune -u llama-qwen36 status`. Empty list → STOP: tuning supports only llama.cpp run as a systemd --user service.

Note: tuning a service other than the one you run on may stop you for the duration of a try (services with `Conflicts=` share the GPU). After the try your model starts again on the next request.

```sh
~/bin/freecode-tune -u NAME status
```
- `! the guard moved the tuning changes aside after a failure` → give the user the path; do not restore that file yourself.
- `! unit flags changed by hand after tuning` → first `~/bin/freecode-tune -u NAME rebase` (moves the tuned flags onto the new settings and clears the baseline), then step 2. `bench`/`try` exit with code 5 in this situation — same fix.
- Remember: current flags (`flags:`), allow-list values, the baseline (GOOD), recent tries (do not repeat tries already rolled back with the same other settings) and the bootstrap calibration result.

## 2. Baseline

Line `baseline (GOOD): none` → `~/bin/freecode-tune -u NAME bench`.
- Exit code 3 (`the server is busy` or `another tuning … is running`) → STOP, ask the user for a moment without other sessions or tunings.
- Code 4 (`measurement invalid`) → STOP: the user should close big programs (browser, games), then repeat.
- Otherwise note the `score …` line — it is the reference point.

## 3. What to try (biggest gain first)

Look at the flags from step 1:

| Situation in the flags | Tries |
|---|---|
| `--cpu-moe` + `--moe-cache-mib N` (MoE, experts in RAM, cache on the GPU) | `moe-cache` up by 512 until a rollback (usually out of VRAM); then one try down by 512 if the first one up lost |
| `--cpu-moe` on a GPU with large VRAM (≥ 16 GB) | `n-cpu-moe=` number of layers kept in RAM, e.g. 20, then down by 5 |
| `-dev none` (CPU only) | `threads=` number of physical cores (`lscpu -p=CORE \| grep -v '^#' \| sort -u \| wc -l`), then cores − 1 |
| always | `spec=none` once — checks whether ngram speculation helps on this hardware at all |
| GPU with ≥ 12 GB VRAM or slow prompt (`prompt` < 300 tok/s) | `ubatch=1024`, then `ubatch=2048 batch=2048` |
| the user wants a bigger context | `ctx` up by 16384 (kept if it loses ≤ 3%) |
| `memory wait` > 3% in the baseline | `cache-ram` down (e.g. 1024) — less prompt cache, more RAM for weights |

Do not invent keys outside the `status` allow-list. The script rejects others anyway (`is not on the allow-list`, code 2) — then pick another try, do not work around the block.

## 4. Try

```sh
~/bin/freecode-tune -u NAME try KEY=VALUE
```
Last line:
- `✓ kept: score A → B (+x%)` → new baseline; count the next try from it.
- `↩ rolled back: …` → settings are back at the baseline. The reason is in the line: score too low, `the server did not start` (usually out of memory — do not go further in that direction) or `measurement disturbed` (repeat the same try once; disturbed a second time → STOP, ask to close programs).
- `WARNING: after the rollback the server did not start` → immediately `~/bin/freecode-tune -u NAME rollback` and STOP with the verbatim output.
- Code 2 → an error in your command (range, key); fix it and try once more.

## 5. Report

Briefly, verbatim numbers from the script output, no embellishing. Reply in the user's language.
1. baseline at the start (`score …` from step 2 or `status`),
2. table of tries: change → verdict → score,
3. final settings (`~/bin/freecode-tune -u NAME status`, line `flags:`),
4. what is worth trying next time (tries that did not fit in the limit).

`~/bin/freecode-tune -u NAME rollback` undoes everything (settings from before tuning). Try history: `~/.local/share/freecode/tune-history.jsonl`.
