---
name: freecode-autoconfig
description: Install, update and configure freecode (opencode on local models only) together with the opencode-config plugins — fetch the repo, run the installer without questions, write a safe opencode.json, verify. Use when the user says "install freecode", "configure freecode", "update freecode / opencode-config", "set opencode to a local model", "freecode --check fails".
---

# freecode: install and configure

Do the steps IN ORDER. After every command read the output and compare it with "expected". If the result differs and the step does not say what to do — STOP: paste the verbatim output to the user and ask. Do not guess and do not report a step you did not run. Reply in the user's language.

Prohibitions (whole skill):
- Do NOT run `freecode` or `opencode` without arguments (that is the TUI — it hangs the tool) and do NOT restart `opencode serve` — it may be the server you are running on.
- Do NOT use `sudo` without the user's consent. Do NOT delete `opencode.json` or providers from it — only freecode adds missing fields (and makes its own backup).
- Use full paths `~/bin/freecode`, because `~/bin` may not be in PATH.

A clean system without opencode and without a model cannot run this skill. There the user runs `bootstrap.sh` from the repo (it installs llama.cpp, a model, opencode and freecode without AI). This skill is for updates and repairs.

A server set up by bootstrap starts on demand: the `freecode-llama-proxy.socket` socket wakes `freecode-llama.service` on the first request, and after 15 min idle the server stops itself. "inactive" for `freecode-llama.service` is therefore normal, not a failure. State: `systemctl --user status freecode-llama-proxy.socket freecode-llama --no-pager`, logs `journalctl --user -u freecode-llama -n 30 --no-pager`. The first request after a pause may wait up to a few minutes (model loading). Do not restart services without consent — it may be the model you run on.

## 1. Current state

```sh
~/bin/freecode --version; ~/bin/freecode --check; echo "EXIT=$?"
```
- `EXIT=0` → freecode is installed and the configuration is local. If the user asked only for configuration — go to step 6 (report). If for an update — step 3.
- `No such file or directory` / `not found` → no freecode, go to step 2.
- `EXIT=1` with a list of problems → remember the list, go to step 2.

## 2. Requirements

```sh
python3 --version; node --version; git --version; curl --version | head -1; command -v opencode || echo "NO opencode"
```
Expected: Python ≥ 3.10, Node ≥ 20, git, curl. Any of python3/node/git/curl missing → STOP, tell the user what is missing (installing system packages needs sudo — their decision).

No opencode:
```sh
npm i -g @opencode/cli && opencode --version
```
`EACCES` error → do not use sudo. Suggest to the user: `npm config set prefix ~/.npm-global` and adding `~/.npm-global/bin` to PATH, then repeat.

Model server (check all ports in one command):
```sh
for p in 8080 11434 1234 8000; do printf ':%s ' $p; curl -s -m 3 http://127.0.0.1:$p/v1/models | head -c 300; echo; done
```
Expected: at least one port returns JSON with `"data"` and a model `"id"`. Remember the port and the model id.
- No port answers, but you know which port you yourself run on (e.g. from `~/.config/opencode/opencode.json`, field `baseURL`) → use that address in step 4 as `FREECODE_URL`.
- Nothing answers → STOP: freecode needs a local server (llama.cpp, Ollama, LM Studio, vLLM). Do not start a model download (gigabytes) without consent.

## 3. Repository

```sh
ls -d ~/opencode-config ~/Projekty/opencode-config 2>/dev/null
```
- Directory exists → update: `git -C DIR pull --ff-only` (DIR = the path from `ls`, verbatim). Error `Not possible to fast-forward` or local changes → STOP, do not `reset`/`stash`, ask.
- Missing → `git clone https://github.com/SyriusM/opencode-config ~/opencode-config`

Check: `ls DIR/install.sh DIR/freecode/freecode` — both files must exist.

## 4. Install (no questions)

```sh
cd DIR && ./install.sh -y 2>&1 | tail -40
```
Note: without MemPalace the installer creates a venv and downloads `mempalace` from PyPI (a few hundred MB, a few minutes). That is normal.
Expected in the output: `6. Done` and `Autotest: OK`. `Autotest: N error(s)` → paste the `✗` lines to the user and STOP.
Copy lines with `!` (warnings, e.g. `~/bin is not in PATH`) into the report; do not fix the shell profile yourself.

## 5. freecode configuration

Server on a standard port (8080, 11434, 1234, 8000):
```sh
FREECODE_YES=1 ~/bin/freecode --configure; echo "EXIT=$?"
```
Server on another port (address from step 2, model id verbatim from `/v1/models`):
```sh
FREECODE_YES=1 FREECODE_URL=http://127.0.0.1:PORT/v1 FREECODE_MODEL=MODEL_ID ~/bin/freecode --configure; echo "EXIT=$?"
```
What happens:
- no `~/.config/opencode/opencode.json` → freecode writes a new file with `enabled_providers`, `small_model` and one local model;
- the file exists → freecode adds only the missing `enabled_providers` / `small_model` (with a `.bak-…` backup); it removes nothing.

Expected: `EXIT=0`. `EXIT=1` with `! …` lines (e.g. "provider X is not local") → STOP. Paste the lines to the user. Removing a cloud provider or adding a LAN host (`FREECODE_HOSTS`) is their decision.

## 6. Check and report

```sh
~/bin/freecode --check; echo "EXIT=$?"; ~/bin/freecode --version
```
Expected: `EXIT=0` and the line `freecode … — a wrapper around opencode …`.

Report for the user (short, verbatim results, no embellishing):
1. what was there at the start (step 1),
2. what was installed/updated (steps 3–4: commit `git -C DIR log -1 --oneline`, `Autotest: …`),
3. which model and address were written (step 5),
4. the `--check` result from step 6,
5. `!` warnings for the user to handle.

At the end write: "Run `freecode` in your terminal — the plugins load at start." Do not run it yourself.
