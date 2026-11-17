# opencode-config

Plugins and scripts for [opencode](https://opencode.ai) 2.x on **local models**. They cut down on repeated tool-call mistakes and give the model background from [MemPalace](https://github.com/MemPalace/mempalace).

Plain code only — no model configs, personal prompts or data.

> 🇵🇱 Wersja polska: [README.pl.md](README.pl.md). Code, messages and agent prompts are in English (models handle it best); the model replies in the user's language.

📝 Blog post on why and how: [English](https://syriusm.github.io/syriusm-blog/wpis-freecode-en.html) · [po polsku](https://syriusm.github.io/syriusm-blog/wpis-freecode.html).

## Contents

| Path | What it does |
|---|---|
| `plugins/tool-input-fix` | Fixes typical input mistakes of local models before the tool runs: a `</code>` leak from the template, `\"` outside strings, Playwright refs, ms→s. Breaks loops of identical failing calls (`STOP` after 2×). On an error it appends a **KNOWN FIX** from the lesson store. |
| `plugins/lesson-draft` | After every turn collects tool errors from the event stream. A repeating pattern is saved as a lesson draft for manual review (`~/tmp-opencode/lessons-draft.md`). |
| `plugins/palace-context` + `bin/palace-context` | Appends up to 3 MemPalace notes for the session directory to the system prompt, only from the wings chosen at install (all by default; similarity threshold 0.57). When embeddings are down it appends a warning instead of silence. |
| `plugins/auto-thinking` | Dynamic thinking budget for the "auto" variant: new instruction → medium, successful tool → low, errors or `LOOP-STOP` → high (replaces `auto_thinking` with `thinking_budget_tokens` in the request). If it does not apply, the server uses its own limit. |
| `plugins/no-call-guard` | Detects a turn where the model showed a command with a "result" but never called a tool (a made-up result). Logs only by default; with `NO_CALL_GUARD=act` it appends a note telling the model to run the command or admit it did not. |
| `plugins/power-cost` | TUI plugin: GPU electricity cost since start. Rate: manual from `POWER_COST_PER_KWH` (+ `POWER_COST_CURRENCY`; the old `POWER_COST_PLN_PER_KWH` works too), otherwise the Eurostat household average (`nrg_pc_204`, 2500–4999 kWh/year, incl. taxes, latest semester) for the country from `POWER_COST_COUNTRY` or `LANG`, in the national currency, cached in `~/.cache/power-cost.json` for 30 days; without network and cache 1.26 zł/kWh; GPU state from `nvidia-smi`. Sidebar section "Power & GPU" (model, watts and peak, load, temperature, fan, VRAM, Wh, cost/h, rate and source), plus a `⚡ cost · W · °C` footer visible with the sidebar hidden. NVIDIA only. |
| `plugins/error-hook` | Logs tool errors to JSONL (`~/mempalace/audit/`). |
| `plugins/danger-guard` | Before a shell command (also from Code Mode) runs, blocks dangerous and outbound commands: `rm -rf` on `~` and `/`, `dd`/`mkfs` on a disk, `curl \| bash`, SSH key access, `git push`, `gh … create`, package publishing and file uploads to a foreign host. The model gives the command for the user to "Run MANUALLY" instead. Also checks the content of a script run from the command (one level). Protects against accidents, not deliberate bypasses. Patterns partly from Goose. Off: `DANGER_GUARD=off`. |
| `plugins/fake-call-scrub` | Removes tool calls written as text (`<shell>…</shell>`, `<tool_call>{…}</tool_call>`) from the chat history so the model does not copy them. For chosen agents forces a real call at the start of a turn (`tool_choice=required`). For Gemma 4 removes text next to `tool_calls`, because it makes the chat template close the turn. Off: `FAKE_CALL_SCRUB=off`. |
| `plugins/site-lint-hook` + `bin/site-lint` | After every write of `.html/.css/.js` runs `site-lint` (static site, offline: classes without a CSS rule, dead links and anchors, `alt`, `label`, unbalanced tags, JSON-LD) and appends the errors to the tool result. Silent in projects with `package.json`. Off: `SITE_LINT_HOOK=off`. |
| `plugins/test-run-hook` | After every write of a `.py` file runs the tests in that directory (`test_*.py` / `*_test.py` with a `__main__` block) and appends the result. Silent in projects with `pyproject.toml`, `setup.py` or `pytest.ini`. Off: `TEST_RUN_HOOK=off`. |
| `plugins/work-mode` | Tells the model whether a human is on the other side: in the TUI it offers options and waits, in `opencode run` it takes the recommended option itself. In auto mode it breaks a stall on an "a or b?" question. Force: `FREECODE_MODE=auto\|step`. |
| `plugins/adversary-guard` | Call reviewer: before a file change or command it asks the same model whether the call fits the task, and can block it. Costs one request per call, so by default it runs only in the training database. `ADVERSARY_GUARD=on` enables it everywhere. |
| `plugins/auto-backup` | Backs up config files before every change (undo: `bin/backup-copy`). |
| `bin/lesson-note` | Lesson store: `SYMPTOM / CAUSE / FIX / EXAMPLE` in files and in a **separate** palace (`~/.mempalace-opencode`), so model lessons never mix with personal memory. Older files with Polish field names are still read. Format: `lessons/EXAMPLE.md`. |
| `bin/agent-rule` | Lets the model add a short rule to the `LEARNED` block in `AGENTS.md` (10-line limit, with a backup). |
| `bin/freecode-tune` | Tunes a llama.cpp server run as a systemd `--user` service: try new flags, measure, then keep or roll back. |
| `bin/crop-image` | Crops an image by percentage coordinates so a vision model can look at a detail. |
| `skills/verify-dont-assume` | Skill for the model: check the real state instead of trusting an exit code, a tool name or a post-compaction summary (backups and deleting them, flags with no effect, paths and IDs from summaries). Every rule comes from a real mishap. Installed by `install.sh`. |
| `freecode/freecode` | opencode on local models only: first-run setup wizard and a config check before every start (see below). |
| `freecode/rebrand` | Copies the opencode sources under the freecode name (`rebrand SOURCE TARGET`; log `TARGET.log.tsv`, summary `TARGET.summary.md`). What must not change (license, domains, repositories, external npm packages, binaries, logo) is logged with file and line. Also lists every network address in the code. |
| `bin/audit-retention` + `systemd/` | Weekly moves audit logs older than 30 days into a tar archive. Deletes files only after a byte-for-byte check. |

## Start from zero (`bootstrap.sh`)

On a clean system one command sets up everything: llama.cpp, a model from Hugging Face, opencode, the plugins and freecode.

```sh
curl -fsSL https://raw.githubusercontent.com/SyriusM/opencode-config/main/bootstrap.sh | bash
./bootstrap.sh --dry-run   # from a repo clone: only show the detected hardware and the plan
```

The script detects the GPU, VRAM, RAM and driver, then picks:

| Hardware | llama.cpp | Model |
|---|---|---|
| NVIDIA, driver ≥ 580 / ≥ 570 | CUDA 13 / CUDA 12 (ready release bundled with the CUDA libraries) | |
| AMD, Intel (with Vulkan) | Vulkan | |
| no GPU | CPU | |
| RAM ≥ 28 GiB or VRAM ≥ 22 GiB | | Qwen3.6-35B-A3B IQ4_NL (~18 GB; MoE: experts in RAM, the rest + an expert cache on the GPU) |
| RAM ≥ 14 GiB or VRAM ≥ 8 GiB | | Qwen3.5-9B Q4_K_XL (~6 GB) |
| less | | Qwen3-4B Instruct (~3 GB, weak with tools) |

**Minimum requirements** (local model; below this bootstrap refuses and suggests `--url` with a server on another computer):

| | Minimum | Better |
|---|---|---|
| System | Linux x86_64 (ready llama.cpp releases), Python ≥ 3.10, Node ≥ 20, git, curl | systemd --user (start on demand) |
| Memory | 8 GB RAM or 6 GB VRAM — 4B model, weak with tools | 16 GB RAM → 9B; 32 GB RAM (or 24 GB VRAM) → 35B |
| CPU | x86_64; works without AVX2, but several times slower | AVX2, ≥ 6 cores |
| GPU | not needed (CPU only) | NVIDIA with driver ≥ 570 (CUDA); AMD/Intel via Vulkan — calibration checks whether it beats the CPU at all |
| Disk | ~6 GB (4B), ~9 GB (9B), ~21 GB (35B) | NVMe (faster model loading) |

The minimum is computed from the model and window size, **not measured on weak hardware**. Weaker machines (less RAM, ARM) are a separate topic: smaller models or a server on the LAN.

**Only the RTX 3080 10 GB + 32 GB RAM setup is verified** (35B, ~118 tok/s chat). On other hardware the script says so plainly and leaves the GPU/RAM layer split to llama.cpp `--fit`. The llama.cpp build is pinned (`LLAMA_TAG` in the script), because nightly releases change defaults.

The model starts **on demand**: the `freecode-llama-proxy.socket` socket listens on the port, the first request wakes `freecode-llama.service`, and after 15 min idle the server stops itself and frees VRAM and RAM. The first request after a pause waits until the model loads. `--idle N` changes the time, `--idle 0` = always on. Disable for good: `systemctl --user disable --now freecode-llama-proxy.socket freecode-llama.service`; enable again: `systemctl --user enable --now freecode-llama-proxy.socket`. Files go to `~/.local/share/freecode/` (`llama.cpp/`, `models/`). At the end the script runs a tool test: the model has to read a file with random text. Options: `--profile 35b|9b|4b`, `--backend cuda-13|cuda-12|vulkan|cpu`, `--llama-tag`, `--port`, `--url … --model …` (your own server), `--idle N`, `--no-smoke`.

**Calibration (Vulkan).** Vulkan sees every card at once, including CPU graphics, and a weak integrated GPU can be slower than the CPU alone (Radeon 610M: 35B 8.7 tok/s, CPU 15.5). So after the model download bootstrap measures each card and the CPU alone with `llama-bench` and takes the fastest. It also measures time spent waiting for memory (PSI), because with too little RAM the result measures swap, not the card. The report goes to `~/.local/share/freecode/tune-report.json`.

**Tuning: `freecode-tune` + the `freecode-tune` skill.** After install you can ask the model in freecode: "tune the model". The model picks an allow-listed flag change (`ctx`, `moe-cache`, `n-cpu-moe`, `spec`, `threads`, `ubatch`, `batch`, `cache-ram`, each within a range), and `~/bin/freecode-tune try KEY=VALUE` restarts the server and measures chat, code rewriting and a long prompt (~60% of the window). The change stays only if the score rises by ≥ 3% (or a bigger context loses ≤ 3%); otherwise it is rolled back. The model proposes, the script decides. Changes live in the `freecode-llama.service.d/tune.conf` drop-in, and `freecode-tune rollback` restores the bootstrap settings. By hand: `freecode-tune status`, `freecode-tune bench`. Your own llama-server services work too: `freecode-tune units`, then `-u NAME` (changes go to `NAME.service.d/tune.conf`). When the service has `--mmproj`, the measurement also sends an image — a change that makes the server fail on an image is rolled back. Note: `tune.conf` holds the whole start line, so editing flags in the unit by hand after tuning has no effect — `freecode-tune status` shows this, and `freecode-tune rebase` moves the tuning onto the new flags.

## Install

Requirements: Linux, Python ≥ 3.10, opencode 2.x (`npm i -g @opencode/cli`), a local model server with an OpenAI-compatible API (llama.cpp, Ollama, vLLM…).

```sh
git clone https://github.com/SyriusM/opencode-config && cd opencode-config
./install.sh          # asks about MemPalace, the embedding port and wings; -y = defaults
./install.sh --check  # self-test of an existing installation
./install.sh --uninstall
```

What the installer does:

1. Looks for MemPalace (`$MEMPALACE_PYTHON`, `~/mempalace/.venv`, then the system `python3`). If missing, offers a venv in `~/.local/share/opencode-config/venv` and an install from PyPI. Asks for the embedding server port for the health check: `0` = built into MemPalace, no server (default), `8080` = llama.cpp, `11434` = Ollama.
2. Looks for a model server on `127.0.0.1:8080` (llama.cpp) and `127.0.0.1:11434` (Ollama). If found and you have no `~/.config/opencode/opencode.json` yet, offers to write one with the first model from the list (with `enabled_providers` and a local `small_model`). An existing file is never touched.
3. Copies the plugins to `~/.config/opencode/plugins/` (opencode loads them from there by itself, no need to list them in `opencode.json`), scripts to `~/bin/`, and saves the settings in `~/.config/opencode-config/config`. Overwritten files get a `.bak-…` backup.
4. Enables the `audit-retention` timer (systemd `--user`, if available) and runs the self-test.

`~/bin` should be in `PATH`, because the model calls `lesson-note` and `agent-rule` through the shell. The installer warns if it is not.

## freecode: opencode on local models only

Without a correct configuration opencode 2.x silently sends the conversation to free cloud models. Verified in a container with 2.0.24:

| Situation | Where the prompt goes |
|---|---|
| no `opencode.json` | cloud (`opencode/fledge-alpha-free`) |
| broken JSON | cloud (`exo-free`), no error message |
| `enabled_providers` without `small_model` | chat local, **session titles to the cloud** |
| `enabled_providers` + local `small_model` | everything local |

On top of that the background service (`opencode serve --service`) keeps the configuration from its start, so fixing the file does not take effect right away.

`freecode` is **a wrapper, not a fork**. You install and update opencode normally (`npm i -g @opencode/cli`), and freecode makes sure at every start that it only runs on local models. `freecode --version` shows both versions, e.g. `freecode 0.1 — a wrapper around opencode 2.0.24, local models only`. After an opencode update change the version in `.github/workflows/test.yml`, and the test shows whether the wrapper still works.

What it does:

- **on first start** it runs the setup wizard. It detects a local server (llama.cpp :8080, Ollama :11434, LM Studio :1234, vLLM :8000) and writes a safe `opencode.json`. For an existing file it offers to add `enabled_providers` and `small_model`, with a backup. A new file also gets 4 agents (general, coder, reasoner, reviewer) with prompts from `agents/` and the context size read from the server. Run again: `freecode --configure`;
- **`freecode --configure`** runs in 4 separate stages, every change asks first:
  1. connection to the local model (`opencode.json`);
  2. conformity with the `agents/` template (model context vs. server, `small_model`, missing agents, missing `AGENTS.md` sections);
  3. the model's work style (a/b/c: options before a task, step narration, freedom to change, language), saved in the `PREFS` block of `AGENTS.md`;
  4. computer description (the `ENV` block).
  `--configure 3` runs only the chosen stage. Bootstrap runs stage 1 before the install and 2–4 after it. The old name `--optimize` still works;
- **`freecode --set narration=b`** changes the work style without questions. The model uses it after a bad rating of its work, but only with your consent. **`freecode --undo`** reverts the last change (history in `~/.local/share/freecode/prefs-history.jsonl`);
- **work mode** (`work-mode` plugin): in `opencode run` / `--auto` nobody will answer, so the model takes the recommended option itself and says which; in the TUI it offers options and waits. Force: `FREECODE_MODE=auto|step`;
- **describes the computer in `AGENTS.md`** (the `ENV` block: system, package manager, GPU and VRAM, RAM, model and context), refreshed daily or by hand with `freecode --env` — the model does not have to ask about the basics. The rest of the file is untouched; `install.sh` never overwrites your own `AGENTS.md` and prompts;
- **at every start** it checks all configuration sources: global, `$OPENCODE_CONFIG`, `$OPENCODE_CONFIG_CONTENT` and project files up to the repository root. It refuses to start if the JSON is broken or any model or provider is not local (localhost, 127.0.0.0/8, ::1, hosts from `FREECODE_HOSTS`). The same goes for other ways session content can leave: `share: "auto"`, `enterprise.url`, an enabled remote MCP server (`type: remote`) and an address overridden in `provider.X.api` or at model level. It also does not pass to opencode commands that go to the network or expose the server (`upgrade`, `auth`, `uninstall`, `plugin add/check/update`, `mcp auth`, `pair --remote`, non-local `--server`, `session import URL`). After a configuration change the background service gets `opencode reload` instead of a restart, so open sessions stay;
- runs opencode with `--standalone`, i.e. its own server with the configuration just checked, plus `OPENCODE_DISABLE_AUTOUPDATE` and `OPENCODE_DISABLE_MODELS_FETCH`.

```sh
freecode                 # TUI
freecode run "question"  # one-shot
freecode --check         # check only
```

Limitation: freecode does not block the network. The `webfetch`/`websearch` tools and MCP servers can still reach the internet; only sending prompts to models is guarded.

## Model: example `opencode.json`

If the installer found no server, or your model is on another port, write `~/.config/opencode/opencode.json` by hand:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "enabled_providers": ["local"],
  "model": "local/qwen3-8b",
  "small_model": "local/qwen3-8b",
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8080/v1" },
      "models": { "qwen3-8b": { "name": "Qwen3 8B (local)" } }
    }
  }
}
```

`enabled_providers` and `small_model` are mandatory, because without them opencode uses the cloud (see freecode). The model name (`qwen3-8b`) must match what the server returns at `/v1/models`. The model must support tool calls. For llama.cpp that means running `llama-server` with `--jinja`.

## `AGENTS.md` (optional)

The plugins work without this file. For the model to save lessons and rules by itself, add to `~/.config/opencode/AGENTS.md`:

```markdown
## Tool errors
Before looking for the cause of a tool error, check `~/bin/lesson-note search "message"`.
When you solve a new error, save a lesson: `~/bin/lesson-note add "SYMPTOM" "CAUSE" "FIX" "EXAMPLE"`.

## Learned rules
The only place where you may add a rule yourself, and only with `~/bin/agent-rule add "what to do + example"`.
<!-- LEARNED:START -->
<!-- LEARNED:END -->
```

Without the `LEARNED` markers `agent-rule` refuses to write. Older names (`WYUCZONE`, `dodaj`, `szukaj`, `--sprawdz`, `FREECODE_HOSTY`) still work.

## Where things go

| Path | Content |
|---|---|
| `~/.mempalace/hook_state/*.log` | plugin logs (first place to look when something does not work) |
| `~/mempalace/audit/errors_YYYYMMDD.jsonl` | tool errors (`error-hook`) |
| `~/tmp-opencode/lessons-draft.md` | lesson drafts (`lesson-draft`, when the same error repeats ≥ 2× in a turn) |
| `~/oc-audyt/kopalnia/`, `~/.mempalace-opencode` | lesson store |
| `~/oc-audyt/auto-kopie/` | config file backups |

Uninstall removes only the installed files. The data in the table, the settings and the venv stay; remove them by hand.

## Tests

Tested in a clean Arch Linux container with opencode 2.0.24: install, self-test, uninstall and a full `opencode run` session against a mock OpenAI server. In that session all plugins load, `error-hook` and `lesson-draft` record the tool errors, and `palace-context` appends a note to the system prompt.

GitHub Actions runs the same test on every push (`.github/workflows/test.yml`: shellcheck, plugin syntax via esbuild, `tests/e2e.sh`). Locally only in a container, because the test installs everything from scratch:

```sh
docker run --rm -v "$PWD":/repo:ro archlinux bash -c 'pacman -Syu --noconfirm --needed nodejs npm python curl diffutils >/dev/null && npm i -g --ignore-scripts=false @opencode/cli@2.0.24 >/dev/null && (cd "$(npm root -g)/@opencode/cli" && node postinstall.mjs) && cp -r /repo /tmp/oc && /tmp/oc/tests/e2e.sh'
```

Plugin behaviour tests (`tool-input-fix`, `no-call-guard` and others) need neither a container nor opencode, only Node 22:

```sh
tests/plugins/run.sh              # plugins from the repo
tests/plugins/run.sh ~/.config/opencode/plugins   # installed plugins
```

Every test runs on a fake home directory in `/tmp`. They cover, among others, 95 fix and hint cases (`tests/plugins/cases.json`, `@HOME@` = home directory), hint text for guessed paths, the loop brake with escalation, STOP on a repeated "No changes to apply", delivering hints for read/edit/write in the call result, and the "read the file first" hint. Hints for `ls`/`cat`/`find`/`cp` recognise absolute paths only as `/home/<user>/…`, so those cases are written as `~/…`. Some test inputs are deliberately Polish: the plugins also understand Polish user messages and Polish-locale shell errors.

## opencode 2.0.24 plugin API (measured, not from docs)

- Module: `export default { id, async setup(ctx) { … } }`. A plugin gets a separate instance per location, but the event stream is shared, so deduplicate by `event.id`.
- `ctx` has `location`, `session`, `tool`, `event`, `mcp`, `storage` among others. **There is no `ctx.client`.**
- Session directory: `ctx.location.directory`. `process.cwd()` is the server's start directory.
- System prompt: `ctx.session.hook("context", async (p) => p.system.push({type: "text", text}))`. Fields of `p`: `sessionID, model, system, messages, options, agent, tools`.
- Tools: `ctx.tool.hook("execute.before" | "execute.after", cb)`. Change the input with `ev.input = …`.
- Events: `ctx.event.subscribe()`. **`session.idle` does not exist.**
  - End of turn is `session.execution.succeeded|failed`.
  - `sessionID` is in `event.data.sessionID`.
  - A tool error is `session.tool.failed` (`data.error.message`, `data.id`).
  - The tool name is in `session.tool.input.started` (`data.name`), not in `session.tool.called`.

## Thanks

This repository is only a thin layer on the work of many people who gave it away for free. None of it would work without them.

- **Linus Torvalds** and the [Linux](https://kernel.org) community, **GNU**, **systemd**, [Arch Linux](https://archlinux.org) and [CachyOS](https://cachyos.org) — the system all of this stands on.
- **Georgi Gerganov** and the contributors of [llama.cpp](https://github.com/ggml-org/llama.cpp) — the server that runs models on an ordinary GPU.
- **Iwan Kawrakow** — author of the k-quants and i-quants quantizations in llama.cpp (the `IQ4_NL` file the 35B model runs on here is his work) and of [ik_llama.cpp](https://github.com/ikawrakow/ik_llama.cpp).
- The **Qwen** team (Alibaba), **Google** (Gemma), **BAAI** (bge-m3) — open models.
- [unsloth](https://unsloth.ai) — model quantizations with the MTP layer kept.
- The creators of [opencode](https://opencode.ai) — the harness these plugins extend.
- [MemPalace](https://github.com/MemPalace/mempalace) — memory for the model.
- [Anthropic](https://anthropic.com) — Claude helped design, write and measure most of this code.
- [SyriusM](https://github.com/SyriusM) — to myself, for making this list possible.

## License

MIT
