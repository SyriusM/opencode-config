// auto-thinking: the session summary (compaction) must go out WITHOUT thinking whatever the variant,
// while normal turns keep the dynamic budget. Marker text inside a tool result is not a compaction.
// Usage: node --experimental-strip-types --no-warnings auto-thinking.test.mjs SRC
const mod = await import(process.argv[2])
let hook
await mod.default.setup({ session: { hook: async (name, fn) => { if (name === "http.request") hook = fn } } })
let fails = 0, n = 0
const check = (cond, msg) => { n++; if (!cond) { fails++; console.log("FAIL " + msg) } }

const MARK = "You MUST use this format for your response (you may omit sections that aren't applicable). Do not include the <template> tags in your response.\n<template>\n## Objective"
const send = async (body, agent = "general") => {
  const ev = { sessionID: "s1", agent, request: new Request("http://127.0.0.1:8085/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }
  await hook(ev)
  return JSON.parse(await ev.request.text())
}
const auto = { model: "bonsai-2-27b", temperature: 0.6, auto_thinking: [2048, 4096, 8192], chat_template_kwargs: { enable_thinking: true } }

// 1. compaction on the "auto" variant (instructions in the last user message)
let b = await send({ ...auto, messages: [{ role: "system", content: "You are opencode." },
  { role: "user", content: "fix the bug" }, { role: "assistant", content: "done" }, { role: "user", content: MARK }] })
check(b.chat_template_kwargs?.enable_thinking === false, "auto compaction: thinking off, got " + JSON.stringify(b.chat_template_kwargs))
check(!("auto_thinking" in b) && !("thinking_budget_tokens" in b), "auto compaction: no budget fields, got " + JSON.stringify(b))
check(b.temperature === 0.6 && b.model === "bonsai-2-27b", "auto compaction: other fields kept")

// 2. compaction on the "high" variant (fixed budget, no auto_thinking) — instructions as content parts in system
b = await send({ model: "bonsai-2-27b", thinking_budget_tokens: 4096, messages: [
  { role: "system", content: [{ type: "text", text: "Summarize.\n" + MARK }] }, { role: "user", content: "go" }] })
check(b.chat_template_kwargs?.enable_thinking === false && !("thinking_budget_tokens" in b), "high compaction: thinking off, got " + JSON.stringify(b))

// 3. a normal new user turn keeps the dynamic budget (medium)
b = await send({ ...auto, messages: [{ role: "user", content: "write a parser" }] })
check(b.thinking_budget_tokens === 4096 && b.chat_template_kwargs?.enable_thinking === true && !("auto_thinking" in b),
  "normal turn: medium budget, got " + JSON.stringify(b))

// 4. the marker read from a file (tool result) is not a compaction
b = await send({ ...auto, messages: [{ role: "user", content: "read the compaction prompt" },
  { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c1", content: "const U5 = `" + MARK + "`" }] })
check(b.thinking_budget_tokens === 2048 && b.chat_template_kwargs?.enable_thinking === true,
  "marker in tool output: normal low budget, got " + JSON.stringify(b))

// 5. a request without any thinking field and without the marker is left untouched
const plain = { model: "x", messages: [{ role: "user", content: "hi" }] }
b = await send(plain)
check(JSON.stringify(b) === JSON.stringify(plain), "plain request untouched, got " + JSON.stringify(b))

// 6. COMPACTION_THINKING=on keeps the old behaviour (dynamic budget for the summary)
process.env.COMPACTION_THINKING = "on"
b = await send({ ...auto, messages: [{ role: "user", content: MARK }] })
check(b.thinking_budget_tokens === 4096 && b.chat_template_kwargs?.enable_thinking === true, "switch on: old behaviour, got " + JSON.stringify(b))
delete process.env.COMPACTION_THINKING

// pure helpers
check(mod.isCompactionRequest({ messages: [{ role: "user", content: MARK }] }) === true, "isCompactionRequest: user")
check(mod.isCompactionRequest({ messages: [{ role: "tool", content: MARK }] }) === false, "isCompactionRequest: tool ignored")
check(mod.isCompactionRequest({}) === false, "isCompactionRequest: no messages")

console.log(fails ? `FAILED: ${fails} of ${n}` : `ALL OK: ${n} checks`)
process.exit(fails ? 1 : 0)
