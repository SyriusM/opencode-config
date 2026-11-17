#!/usr/bin/env python3
"""Mechanical check of a brief (~/.prompty/*.md style) before it is executed.
The rule words (STOP, "stan końcowy", "## Raport", "dosłowne", "nie zmieniaj") are Polish on purpose: the briefs are written in Polish.

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
            return
        idx = len(sections)
        sections.append((heading, text, block_count))
        m = re.match(r"##\s*Krok\s+(\d+)", heading)
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
                if heading is not None:
                    block_count += 1
                continue
            if s.startswith("## "):
                flush(heading, text, block_count)
                heading = s
                text = []
                block_count = 0
                continue
            if heading is not None:
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
        if block_count > 0 and "oczekiwane" not in " ".join(text).lower():
            problems.append(
                f'FAIL expected: Krok {num} has a code block but no "Oczekiwane"'
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

    if not re.search(r"\bSTOP\b", all_text.upper()):
        problems.append("FAIL stop: no STOP condition")

    if not steps:
        problems.append('FAIL final: last step has no "stan końcowy"')
    else:
        num, idx, text, _ = steps[-1]
        combined = (sections[idx][0] + " " + " ".join(text)).lower()
        if "stan końcowy" not in combined:
            problems.append('FAIL final: last step has no "stan końcowy"')

    if not re.search(
        r"\b(nie zmieniaj|nie ruszaj|nie dotykaj)\b",
        all_text,
        re.IGNORECASE,
    ):
        problems.append('FAIL scope: no "Nie zmieniaj/ruszaj/dotykaj" limit')

    report_ok = False
    for heading, text, _ in sections:
        if heading.startswith("## Raport"):
            if "dosłown" in (heading + " " + " ".join(text)).lower():
                report_ok = True
    if not report_ok:
        problems.append(
            'FAIL report: no "## Raport" section asking for "dosłowne" output'
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
