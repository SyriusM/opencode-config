# opencode error and fix (2026-10-07) — legacy Polish field names, kept to test that they are still read

OBJAW: ReferenceError: Unknown identifier require / setTimeout / page in execute
PRZYCZYNA: execute is restricted JavaScript, not Node and not a Playwright script
NAPRAWA: plugin: hints require-import, timer, page-playwright (the call does not run, the model gets an example)
PRZYKŁAD: await tools.playwright.browser_wait_for({time: 2}); const s = await tools.playwright.browser_snapshot(); console.log(s)
