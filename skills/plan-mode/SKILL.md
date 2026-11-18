---
name: plan-mode
description: Rules for read-only mode (Plan, writing a brief) — what may be written and where the brief file is created. Use when running in Plan or when only a brief/task file may be written.
---

# Plan / brief-only mode

- In a read-only mode (Plan, "write only the brief"): no file writes by ANY route — not `cd X && cp`, not `python3 -c`/heredoc `open(...,"w")`, not scratch copies in /tmp or ~/tmp-opencode. A command that slips past the block is still forbidden. Test fixes only in the executing mode, as brief steps.
- Writing a brief/plan file: create it DIRECTLY at its final path with the write tool (e.g. `~/.prompty/NAME.md`). No scratch copy in `~/tmp-opencode/` or elsewhere, no `cp`/`mv` afterwards — in Plan mode only the target path is writable.
- Output file = EXACTLY the name given in the task file. Several task files at once → one task at a time; before write, check that the brief's topic matches the task file you are doing.
