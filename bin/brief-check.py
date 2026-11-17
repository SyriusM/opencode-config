#!/usr/bin/env python3
"""Mechanical check of a brief (~/.prompty/*.md style) before it is executed.
The rule words (STOP, "stan końcowy"/"final state", "## Raport"/"## Report", "dosłown"/"verbatim", "nie zmieniaj"/"do not change") are Polish and English keywords are accepted: the repo is written in English.

Usage: brief-check.py BRIEF.md
  OK            -> exit 0 (no problems)
  FAIL ...      -> exit 1 (N problem(s))
  message+2     -> exit 2 (no such file)
"""

import re
import sys

# Code block markers: a line starting with a marker opens a block,
# and only a line starting with the SAME marker closes it.
OPENERS = ("```", "~~~")


def parse(lines):
    """Split file into sections (## ...) and steps (## Krok N).

    Text before the first "## " is kept as a section with an empty heading
    and counts for the text rules (STOP, scope), like any section text.
    Returns:
      sections: [(heading, outside_text_lines, block_count)]
      steps:    [(number, section_index, outside_text_lines, block_count)]
    Lines inside code blocks are not headings and are not text for rules;
    "has a code block" = block_count >= 1 within the step's section.
    """
    sections = []
    steps = []

    def flush(heading, text, block_count):
        if heading is None:
            heading = ""
        idx = len(sections)
        sections.append((heading, text, block_count))
        m = re.match(r"##\s*(?:Krok|Step)\s+(\d+)", heading)
        if m:
            steps.append((int(m.group(1)), idx, text, block_count))

    heading = None
    text = []
    block_count = 0
    in_block = None
    for raw in lines:
        s = raw.rstrip("\n").rstrip("\r")
        if in_block is None:
            opener = next((op for op in OPENERS if s.startswith(op)), None)
            if opener is not None:
                in_block = opener
                block_count += 1
                continue
            if s.startswith("## "):
                flush(heading, text, block_count)
                heading = s
                text = []
                block_count = 0
                continue
            text.append(s)
        else:
            if s.startswith(in_block):
                in_block = None
    flush(heading, text, block_count)
    return sections, steps


def check_step0(sections, steps):
    if not any(num == 0 for num, *_ in steps):
        return ['FAIL step0: no "## Krok 0" (initial state step)']
    return []


def check_expected(sections, steps):
    problems = []
    for num, idx, text, block_count in steps:
        if block_count > 0 and not any(w in " ".join(text).lower() for w in ("oczekiwane", "expected")):
            problems.append(
                f'FAIL expected: Step {num} has a code block but no "Oczekiwane"/"Expected"'
            )
    return problems


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} BRIEF.md", file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError as e:
        print(f"Error: cannot read {path}: {e}", file=sys.stderr)
        sys.exit(2)

    sections, steps = parse(lines)
    problems = []

    # Rule order: step0, expected (ascending N), stop, final, scope, report.
    problems.extend(check_step0(sections, steps))
    problems.extend(check_expected(sections, steps))

    # Rules on text outside code blocks only (already split out above).
    all_text = " ".join(" ".join(text) for _, text, _ in sections)

    if not re.search(r"\bSTOP\b", all_text):
        problems.append("FAIL stop: no STOP condition")

    if not steps:
        problems.append('FAIL final: last step has no "final state" / "stan końcowy"')
    else:
        num, idx, text, _ = steps[-1]
        combined = (sections[idx][0] + " " + " ".join(text)).lower()
        if not any(w in combined for w in ("final state", "stan końcowy")):
            problems.append('FAIL final: last step has no "final state" / "stan końcowy"')

    if not re.search(
        r"\b(nie zmieniaj|nie ruszaj|nie dotykaj|do not change|do not modify|do not touch)\b",
        all_text,
        re.IGNORECASE,
    ):
        problems.append('FAIL scope: no "Nie zmieniaj/ruszaj/dotykaj" / "do not change/do not modify/do not touch" limit')

    report_ok = False
    for heading, text, _ in sections:
        if heading.lower().startswith("## raport") or heading.lower().startswith("## report"):
            if "dosłown" in (heading + " " + " ".join(text)).lower() or "verbatim" in (heading + " " + " ".join(text)).lower():
                report_ok = True
    if not report_ok:
        problems.append(
            'FAIL report: no "## Raport"/"## Report" section asking for "dosłowne"/"verbatim" output'
        )

    if problems:
        for p in problems:
            print(p)
        print(f"{len(problems)} problem(s)")
        sys.exit(1)
    print("OK")
    sys.exit(0)


if __name__ == "__main__":
    main()
