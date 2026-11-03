---
name: verify-dont-assume
description: Check real state before claiming success, instead of trusting exit codes, tool names, memory or summaries. Use when copying, moving or backing up files; deleting a backup; adding a config flag or service option; a measurement shows "no difference"; planning work around an unfamiliar tool; reusing a path, ID or name from a summary or after context compaction; or reporting a result to the user.
---

# Verify, don't assume

Each rule below comes from a real failure in local-model coding sessions. In each one, the assumption looked reasonable and turned out wrong. Follow the checks even when the step seems to have succeeded.

## 1. Exit code 0 does not mean the file is where you wanted it

**What happened:** an agent was asked to back up a source file before editing it. Over three attempts it wrote two wrong paths, one with a missing letter and one with a lost subdirectory. One copy "succeeded" in the wrong directory, and another produced a file with a truncated name. Every successful `cp` returned 0.

**Cause found later:** the model's repetition sampler (DRY in llama.cpp) penalized literal copying from context. Copying a long path succeeded 0 of 8 times on one model and 0 of 6 on another with the sampler on, and 8 of 8 and 6 of 6 with it off. Shell limits were not involved.

**Do this:**
- After every `cp`, `mv` or redirect to a file, run `ls -la <full-target-path>` and check both the name and the size.
- Compare the path you intended with the path you got, character by character if it is long.
- If long arguments keep coming out mangled, write a script to a file and run it. If the failures repeat, check the sampler settings.

## 2. A backup you can't find is not a backup

During a failed fix, you will look for the backup next to the original. Keep it there and name it `<file>.bak-<what-it-precedes>-<date>`.

## 3. Prove a backup is unneeded before deleting it

**What happened:** two backups sat in a project. The neatly placed one was months old. The only valid restore point for that day's fix sat in the repo root and looked like clutter. It was nearly deleted.

**Rule:** content and date decide which backup matters, not location.

```bash
# Does this copy really hold the state BEFORE the change?
grep -c '<pattern-from-old-version>' file.bak-...   # >0 = restore point
grep -c '<pattern-from-old-version>' file           # 0  = current file is already changed

# Delete only an exact duplicate, with the check and the delete in one command
cmp -s file.bak-... file && rm file.bak-...
```

## 4. "No difference" has a cause, so read the startup log

**What happened:** `--cache-reuse` was added to llama-server. Measurements were identical with and without it (`prompt_n` 2752, `cache_n` 1966 both times). This was dismissed as noise and the flag stayed. The startup log explained it:

```
W srv load_model: cache_reuse is not supported by multimodal, it will be disabled
```

The flag had never been active.

**Do this:**
- Treat an exactly unchanged result as a signal to investigate, not as noise.
- After adding a flag, search the startup log for `not supported`, `will be disabled`, `ignored` and `deprecated`.
- Do not keep a flag "because it can't hurt". Keep it only if it has a measured effect.

## 5. A tool may not do what its name suggests

**What happened:** a long run of a memory tool's `compress` command over 8776 entries was planned, on the assumption it would replace their content. Reading the code showed that it wrote copies to a separate collection nothing ever read. The run would have changed no search result.

**Before planning work around an unfamiliar tool,** find who reads what it writes:

```bash
grep -rn "<collection-or-resource-name>" <package-dir>/
```

If a resource is written but never read, the tool does not affect anything you can observe.

## 6. After compaction, verify every path, ID and name at the source

**What happened:** after context compaction, one session's summaries spelled the same project directory four different ways, and one invented a station name. A long numeric ID repeated in the same summaries turned out to be correct. Right and wrong values cannot be told apart by looking at them.

**Cause:** compaction paraphrases the history, and exact strings are what paraphrase damages.

**Do this:**
- Before treating a value from a summary as fact, confirm it with `ls` or `grep`, or by running the real request.
- If one value appears in several spellings, check the file on disk, not another summary.
- Keep paths and IDs in a file such as `SPEC.md`, and read that file instead of recalling them.

## Reporting results

Separate what you measured from what you assumed. If you did not check something, say "not checked" rather than "should work". An empty result or an error means no data, not success.
