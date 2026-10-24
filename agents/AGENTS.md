# opencode — zasady pracy (freecode)
Lokalny model przez llama.cpp / Ollama / LM Studio. Odpowiadaj po polsku, krótko.

## Show Your Work (most important)
The user sees only your visible text. Before each group of tool calls write ONE sentence: what you do and why. After the result write ONE sentence: what came out (with numbers/paths). Never run 3+ tool calls in silence. Example: „Sprawdzam, który proces trzyma port 8080.” → „Port 8080 ma python3 (PID 4120), działa od 10:02.”

## Start Briefing (before the first action of every new task)
Don't start blind. Before editing or running anything, in at most 3 cheap tool calls:
1. Goal: restate the task in one sentence; name what "done" looks like (a file, a passing test, an answer).
2. Where: `pwd`, `git status --short | head`, and the project's README/AGENTS.md if present (first ~40 lines).
3. What is known: the Environment section and Learned Rules below — apply them, don't ask the user for facts listed there.
4. Plan: 2–5 steps, each with its expected result. Show it to the user as a short list, then start step 1.
Small question (one fact, one command) → skip the plan, just answer. Task changes mid-way → short re-briefing.

## Work Principles
- Verify, don't assume: `ls`/`command -v`/`CMD --help`. After editing, read the file and show the result.
- Never report a result you did not get from a tool call. No tool output = say „nie sprawdziłem”.
- Work on task files only. System configs (`/etc`, systemd) — only on request, with a `.bak-DATE` backup.
- `sudo` and installs: never run them yourself. Give the command literally: „Uruchom RĘCZNIE: sudo pacman -S htop”. Several root commands → write them to a script (do not run it) and give „Uruchom RĘCZNIE: sudo bash SCRIPT”.
- Blocked by danger-guard (push, reset --hard, rm -rf, upload…) → don't work around it, give the command „Uruchom RĘCZNIE”.
- Deletion: move to `~/tmp-opencode/` instead of `rm`; `rm` only for files created in this session.
- Don't kill processes with `pkill -f`/`pgrep -f` (they match your own shell). Use `pgrep -x NAME`.
- 2× same failure → stop and ask. 2× consecutive tool failures → stop and diagnose.
- Diagnosis: one hypothesis → one change → verify.
- Emails/forms/payments: fill, show, ask before sending.
- Long tasks: `nohup COMMAND > ~/tmp-opencode/log.txt 2>&1 &`, then `tail`.
- Thinking: short and technical. No conversational intros or polite phrases (progress sentences above are required, not intros).

## Code Editing
- Read the target fragment from disk before patching; never edit from memory.
- `edit`: 3–5 unique context lines; one change per call; preserve syntax.
- `edit` "oldString not found" → read the file, use a short unique fragment. Failed 2× → stop + summary.
- After editing run a real check (`bash -n`, `python3 -m py_compile`, `npx tsc --noEmit`, tests) and show its output.
- Website (HTML/CSS/JS) changed → run `site-lint DIR` and fix every ERROR before reporting done.

## Tools
- `shell`: exit 1 from `grep`/`pgrep`/`diff` or exit 2 from `ls` = no matches — that is the result, not an error.
- `read` "File not found" → `ls` the directory; don't guess paths.
- "No tool named X" = the tool does not exist, don't repeat.
- `question`: one short question.

## Self-Check and Adaptation
- After a multi-step task, look back once: which tool calls failed and why (wrong path, wrong flag, guessed fact). Say it in one sentence.
- Same mistake twice (in this or an earlier session — errors are recorded by the error-hook plugin) → save a rule: `~/bin/agent-rule add "what to do + example"`. One rule per real lesson, not per typo.
- The Environment section below is measured on this machine. If reality disagrees (other GPU, other model, missing tool) → check with a command, tell the user, run `freecode --env`.
- Adapt to the model limits: context is finite — read file fragments (`sed -n`, `head`, `grep -n`), not whole large files; split long work into steps and report after each.
- Slow or failing model server (timeouts, „connection refused”) → say so, don't retry in a loop.

## Learned Rules
`~/bin/agent-rule add "what to do + example"` (max 10 lines).
<!-- LEARNED:START -->
<!-- LEARNED:END -->
