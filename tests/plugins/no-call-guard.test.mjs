// Content/behaviour test for no-call-guard: fake event stream + fake ctx.session.synthetic.
// Usage: NO_CALL_GUARD=act HOME=$(mktemp -d) node --experimental-strip-types --no-warnings no-call-guard.test.mjs SRC
const src = process.argv[2]
const mod = await import(src)
const { shouldFire } = mod
let fails = 0
const ok = (cond, name) => { if (!cond) { fails++; console.log("FAIL", name) } }
const FAKE = "```bash\ncat data.txt\n```\n\n```\nThis is a test data file\n```"
ok(shouldFire("Wykonaj jedną komendę:\ncat x\n\nWklej jej wyjście DOSŁOWNIE", FAKE, 0), "fabricated output fires")
ok(!shouldFire("Wykonaj komendę cat x", FAKE, 1), "tool called -> no fire")
ok(!shouldFire("Jak sprawdzić zajętość dysku?", "```bash\ndf -h\n```\n\n```\nFilesystem ...\n```", 0), "how-to question -> no fire")
ok(shouldFire("Wykonaj komendę:\ncat /tmp/d.txt", "```bash\ncat /tmp/d.txt\n```", 0), "echoed command without output -> fire (r1)")
ok(shouldFire("Wykonaj jedną komendę:\ncat /tmp/d.txt\nWklej wyjście", "```\ncat /tmp/d.txt\n```\n\n```\nfake\n```", 0), "untagged block + fake output -> fire (r7)")
ok(!shouldFire("Wykonaj test", "```bash\npytest -q\n```", 0), "command not from prompt, no output -> no fire")
ok(!shouldFire("Jak wykonać cat /tmp/d.txt?", "```bash\ncat /tmp/d.txt\n```", 0), "how-to echo -> no fire")
ok(!shouldFire("Napisz funkcję w pythonie", "```python\ndef f(): pass\n```\n```\nout\n```", 0), "no action verb, no shell -> no fire")
ok(!shouldFire("Wykonaj test", "Gotowe, wszystko działa.", 0), "plain text -> no fire")
ok(shouldFire("Sprawdź, co jest w pliku d.txt", FAKE, 0), "polish word end (sprawdź) matches")
ok(!shouldFire("Jak usunąć katalog? Uruchom nic", "```bash\nrm -rf x\n```\n```\n(nic)\n```", 0), "how-to with rm -> no fire")
ok(!shouldFire("Napisz runner.py", FAKE, 0), "run inside word -> no fire")

ok(shouldFire("Usuń plik /x/old/cache.tmp, a potem napisz, co usunąłeś.", '<shell command="rm /x/old/cache.tmp" />\n\nUsunąłem plik.', 0), "gemma <shell/> text call fires")
ok(shouldFire("W katalogu /x zmień nazwę get_usr. Na koniec wklej dosłownie wyjście testu.", "```javascript\nconst r = await tools.shell({ command: \"ls\" });\n```\n\nALL OK", 0), "gemma tools.shell text call fires")
ok(!shouldFire("Usuń plik x", '<shell command="rm x" />', 1), "text call but real tool called -> no fire")
ok(!shouldFire("Jak usunąć plik?", '<shell command="rm x" />', 0), "how-to with text call -> no fire")
ok(!shouldFire("Opisz obiekt", "Użyj metody mytools.shell() albo config.tools.read()", 0), "dotted method names -> no fire")
ok(shouldFire("Zmień nazwę funkcji w pliku a.py", "```bash\nsed -i s/a/b/ a.py\n```\n```\nOK\n```", 0), "zmień counts as action")
ok(mod.noteFor("Wykonaj jedną komendę: cat x").includes("Nie pytaj o zgodę"), "action prompt -> NOTE_DO")
ok(!mod.noteFor("Jak sprawdzić dysk? wykonaj").includes("Nie pytaj o zgodę"), "how-to -> soft note")
ok(!mod.noteFor("Opisz obiekt").includes("Nie pytaj o zgodę"), "no action -> soft note")
ok(!shouldFire("Zainstaluj w systemie program figlet, a potem sprawdź: figlet test", "Uruchom RĘCZNIE: sudo pacman -S figlet\n\n```bash\nfiglet test\n```", 0), "sudo hand-off -> no fire")
ok(shouldFire("Usuń plik x", 'Uruchom ręcznie: <shell command="rm x" />', 0), "hand-off text but fake call -> fire")
ok(mod.noteFor("Usuń plik x").includes("NIC nie podmieniaj"), "strong note forbids substitution")
// event stream simulation
const queue = []; let wake
const push = (type, data, id) => { queue.push({ id: id ?? `evt_${Math.random()}`, type, data }); wake?.() }
const sent = []
const ACT = process.env.NO_CALL_GUARD === "act"
const want = (n) => (ACT ? n : 0)
const ctx = {
  event: { subscribe: ({ signal }) => ({ async *[Symbol.asyncIterator]() {
    while (!signal.aborted) { if (queue.length) yield queue.shift(); else await new Promise((r) => (wake = r)) }
  } }) },
  session: { synthetic: async (o) => { sent.push(o) } },
}
const stop = await mod.default.setup(ctx)
const tick = () => new Promise((r) => setTimeout(r, 20))
const S = "ses_A"
push("session.inbox.enqueued", { sessionID: S, inboxID: "i1", item: { type: "user", payload: { text: "Wykonaj jedną komendę: cat d.txt. Wklej jej wyjście." } } })
push("session.execution.started", { sessionID: S })
push("session.text.ended", { sessionID: S, text: FAKE })
push("session.execution.succeeded", { sessionID: S })
await tick()
ok(sent.length === want(1), `synthetic sent once (got ${sent.length})`)
ok(!ACT || sent[0]?.sessionID === S && /nie wywołałeś żadnego narzędzia/.test(sent[0]?.text ?? ""), "note text + session")
ok(!ACT || /Nie pytaj o zgodę/.test(sent[0]?.text ?? ""), "explicit action prompt -> strong note (how-to stays soft, see noteFor tests)")
// resumed turn fabricates again -> must not fire twice (no loop)
push("session.inbox.enqueued", { sessionID: S, inboxID: "i2", item: { type: "synthetic", payload: { text: "x" } } })
push("session.execution.started", { sessionID: S })
push("session.text.ended", { sessionID: S, text: FAKE })
push("session.execution.succeeded", { sessionID: S })
await tick()
ok(sent.length === want(1), `no second note for same prompt (got ${sent.length})`)
// duplicate event id is ignored
const S2 = "ses_B"
push("session.inbox.enqueued", { sessionID: S2, inboxID: "j1", item: { type: "user", payload: { text: "Uruchom ls i wklej wynik" } } })
push("session.execution.started", { sessionID: S2 })
push("session.tool.called", { sessionID: S2, name: "bash" })
push("session.text.ended", { sessionID: S2, text: FAKE })
push("session.execution.succeeded", { sessionID: S2 })
await tick()
ok(sent.length === want(1), `real tool call -> no note (got ${sent.length})`)
// new user prompt re-arms
push("session.inbox.enqueued", { sessionID: S, inboxID: "i3", item: { type: "user", payload: { text: "Uruchom ls i wklej wynik" } } })
push("session.execution.started", { sessionID: S })
push("session.text.ended", { sessionID: S, text: FAKE })
push("session.execution.succeeded", { sessionID: S, }, "dup1")
push("session.execution.succeeded", { sessionID: S, }, "dup1")
await tick()
ok(sent.length === want(2), `new prompt re-arms, dup event ignored (got ${sent.length})`)
ok(!ACT || sent.every((o) => o.delivery === "queue"), "succeeded-only path uses queue")
// step.ended with finish=tool-calls must not fire; finish=stop fires as steer, succeeded after it does not double
const S3 = "ses_C"
push("session.inbox.enqueued", { sessionID: S3, inboxID: "k1", item: { type: "user", payload: { text: "Wykonaj cat d.txt i wklej wyjście" } } })
push("session.execution.started", { sessionID: S3 })
push("session.text.ended", { sessionID: S3, text: FAKE })
push("session.step.ended", { sessionID: S3, finish: "tool-calls" })
await tick()
ok(sent.length === want(2), `step.ended tool-calls -> no note (got ${sent.length})`)
push("session.step.ended", { sessionID: S3, finish: "stop" })
push("session.execution.succeeded", { sessionID: S3 })
await tick()
ok(sent.length === want(3), `step.ended stop -> one note, no double with succeeded (got ${sent.length})`)
ok(!ACT || sent[2]?.delivery === "steer", `step.ended path uses steer (got ${sent[2]?.delivery})`)
stop(); wake?.()
const { readFileSync } = await import("node:fs")
const logTxt = readFileSync(`${process.env.HOME}/.mempalace/hook_state/no_call_guard.log`, "utf8")
ok((logTxt.match(/\] HIT /g) ?? []).length === 3, "exactly 3 HIT lines in log")
console.log(fails ? `${fails} FAIL` : "ALL OK")
process.exit(fails ? 1 : 0)
