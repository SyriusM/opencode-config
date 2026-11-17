# opencode error and fix (2026-10-07)

SYMPTOM: Unknown engine ref while parsing selector ref=f19e2 or button[ref=f4e13] does not match any elements
CAUSE: the model gives the ref as a CSS selector
FIX: tool-input-fix plugin (fixMcp, target-ref) extracts the bare identifier
EXAMPLE: await tools.playwright.browser_click({target: "f19e2"})
