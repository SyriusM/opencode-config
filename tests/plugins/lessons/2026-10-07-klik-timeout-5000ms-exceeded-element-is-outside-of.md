# opencode error and fix (2026-10-07)

SYMPTOM: Click: Timeout 5000ms exceeded, element is outside of the viewport
CAUSE: the chosen ref is a duplicate link in a hidden slide-out menu (it lies off screen)
FIX: take another ref with the same text or open its href via browser_navigate
EXAMPLE: await tools.playwright.browser_navigate({url: "LINK_HREF"})
