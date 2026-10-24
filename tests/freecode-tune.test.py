#!/usr/bin/env python3
"""Offline test of freecode-tune: unit parsing, whitelist, flag changes, drop-in round trip.
No systemd, no server — config and data dirs are temporary.
Usage: python3 tests/freecode-tune.test.py [path/to/freecode-tune]"""
import importlib.machinery
import importlib.util
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "bin", "freecode-tune")
tmp = tempfile.mkdtemp()
os.environ.update(XDG_CONFIG_HOME=f"{tmp}/cfg", XDG_DATA_HOME=f"{tmp}/data")
sys.dont_write_bytecode = True
loader = importlib.machinery.SourceFileLoader("freecode_tune", SRC)
spec = importlib.util.spec_from_loader("freecode_tune", loader)
assert spec
tune = importlib.util.module_from_spec(spec)
loader.exec_module(tune)

fails = 0
checks = 0


def ok(cond, name):
    global fails, checks
    checks += 1
    if not cond:
        fails += 1
        print("FAIL", name)


def rejected(fn):
    try:
        fn()
    except SystemExit as e:
        return e.code == 2
    return False


# unit as bootstrap.sh writes it (quote(): arguments with spaces in double quotes)
os.makedirs(tune.UNITS)
with open(os.path.join(tune.UNITS, tune.UNIT), "w") as f:
    f.write('[Service]\nExecStart=/opt/llama/llama-server -m /m/model.gguf --host 127.0.0.1 --port 8081 '
            '--alias qwen --jinja -fa on -np 1 --cache-ram 2048 --spec-type ngram-mod --top-k 20 --temp 0.6 '
            '--reasoning-budget 6144 --reasoning-budget-message "Thinking budget reached, answering now." '
            '--cpu-moe --moe-cache-mib 4800 -c 65536 -dev Vulkan1\n'
            "ExecStartPost=/bin/sh -c 'for i in $$(seq 9); do sleep 1; done'\nMemorySwapMax=0\n")

base = tune.base_args()
ok(base[0] == "/opt/llama/llama-server" and '"Thinking budget reached, answering now."' in base, "quoted argument kept whole, verbatim")
ok(tune.server_port(base) == 8081, "server port")
prog, opts = tune.to_options(base)
ok(tune.from_options(prog, opts) == base, "options round trip")
vals = tune.knob_values(opts)
ok(vals["ctx"] == "65536" and vals["moe-cache"] == "4800" and vals["spec"] == "ngram-mod", f"knob values {vals}")
ok(vals["n-cpu-moe"].startswith("off"), "--cpu-moe shown as n-cpu-moe off")

# whitelist and ranges
ok(rejected(lambda: tune.parse_change("mlock=1")), "unknown key rejected")
ok(rejected(lambda: tune.parse_change("ctx=8192")), "ctx below range rejected")
ok(rejected(lambda: tune.parse_change("ctx=50000")), "ctx not multiple of 1024 rejected")
ok(rejected(lambda: tune.parse_change("moe-cache=-5")), "negative rejected")
ok(rejected(lambda: tune.parse_change("spec=draft-mtp")), "spec outside list rejected")
ok(rejected(lambda: tune.parse_change("ctx")), "missing = rejected")
ok(tune.parse_change("threads=4") == ("threads", "4"), "threads parsed")

# changes
new = tune.apply_changes(opts, [tune.parse_change("moe-cache=5600"), tune.parse_change("ctx=49152")])
ok(tune.get(new, ["--moe-cache-mib"]) == "5600" and tune.get(new, ["-c"]) == "49152", "values replaced in place")
ok(len(new) == len(opts), "no duplicate flags")
new = tune.apply_changes(opts, [tune.parse_change("ubatch=1024")])
ok(tune.get(new, ["-ub"]) == "1024" and len(new) == len(opts) + 1, "missing flag appended")
ok(rejected(lambda: tune.apply_changes(new, [tune.parse_change("batch=512")])), "batch < ubatch rejected")
ncm = tune.apply_changes(opts, [tune.parse_change("n-cpu-moe=30")])
ok(tune.get(ncm, ["-ncmoe"]) == "30" and not tune.get(ncm, ["--cpu-moe"]) and not tune.get(ncm, ["--moe-cache-mib"]),
   "n-cpu-moe replaces --cpu-moe and its cache")
ok(rejected(lambda: tune.apply_changes(ncm, [tune.parse_change("moe-cache=3000")])), "moe-cache without --cpu-moe rejected")
back = tune.apply_changes(ncm, [tune.parse_change("n-cpu-moe=off")])
ok(tune.get(back, ["--cpu-moe"]) and not tune.get(back, ["-ncmoe"]), "n-cpu-moe=off restores --cpu-moe")
tdev = tune.apply_changes(opts, [tune.parse_change("threads=6")])
ok(tune.get(tdev, ["-dev"]) == "Vulkan1", "device flag untouched")

# drop-in round trip
args = tune.from_options(prog, tune.apply_changes(opts, [tune.parse_change("ctx=32768")]))
tune.write_dropin(args)
text = open(tune.DROPIN).read()
ok("ExecStart=\nExecStart=" in text, "drop-in clears ExecStart first")
ok(tune.current_args() == args, "drop-in read back identically")
ok(tune.base_args() == base, "base unit untouched")

# hand-made unit (our stack): ExecStart overridden in another drop-in, %h, $$, escaped regex, continuation
tune.select_unit("llama-test")
d = os.path.join(tune.UNITS, "llama-test.service.d")
os.makedirs(d)
open(os.path.join(tune.UNITS, "llama-test.service"), "w").write(
    "[Service]\nExecStart=%h/llama/llama-server -m %h/m/old.gguf --port 9000 -c 262144\n")
own = ('%h/llama/llama-server -m %h/m/gemma.gguf --port 8096 -otd token_embd\\\\.weight=CUDA0 '
       '--alias "Gemma 4" -c 65536 --cpu-moe --moe-cache-mib 4600')
open(os.path.join(d, "rtx3080.conf"), "w").write(f"[Service]\nExecStart=\nExecStart={own}\n")
open(os.path.join(d, "limity.conf"), "w").write("[Service]\nMemorySwapMax=0\n")
ok(tune.SOCKET == "llama-test-proxy.socket" and tune.STATE.endswith("tune-state-llama-test.json"), "names derived from unit")
b2 = tune.base_args()
ok(" ".join(b2) == own, f"later drop-in wins, tokens verbatim: {' '.join(b2)}")
ok(tune.server_port(b2) == 8096, "port from drop-in")
p2, o2 = tune.to_options(b2)
t2 = tune.from_options(p2, tune.apply_changes(o2, [tune.parse_change("moe-cache=5000")]))
tune.write_dropin(t2)
ok(tune.current_args() == t2 and "token_embd\\\\.weight=CUDA0" in open(tune.DROPIN).read(), "escapes survive the round trip")
ok(tune.base_args() == b2, "tune.conf ignored by base")

# manual edit of the base after tuning: tune.conf would mask it → detected, rebase carries tuned knobs over
tune.systemctl = lambda *a, **k: None
ok(tune.recorded_base() == b2 and tune.drifted() is None, "tune.conf records its base")
own_new = own.replace("-c 65536", "-c 49152") + " --temp 0.6"
open(os.path.join(d, "rtx3080.conf"), "w").write(f"[Service]\nExecStart=\nExecStart={own_new}\n")
ok(tune.drifted() == b2, "manual base change detected")
try:
    tune.ensure_no_drift(); ok(False, "bench/try refuse on drift")
except SystemExit as e:
    ok(e.code == 5, "bench/try refuse on drift")
tune.cmd_rebase()
r = " ".join(tune.current_args())
ok("-c 49152" in r and "--temp 0.6" in r and "--moe-cache-mib 5000" in r and tune.drifted() is None, f"rebase: {r}")
p3, o3 = tune.to_options(tune.current_args())
tune.set_args(tune.from_options(p3, tune.apply_changes(o3, [tune.parse_change("n-cpu-moe=20")])))
open(os.path.join(d, "rtx3080.conf"), "w").write(f"[Service]\nExecStart=\nExecStart={own}\n")
tune.cmd_rebase()
r = " ".join(tune.current_args())
ok("-c 65536" in r and "-ncmoe 20" in r and "--cpu-moe" not in r and "--moe-cache-mib" not in r, f"rebase MoE mode: {r}")
open(os.path.join(d, "s-cont.conf"), "w").write("[Service]\nExecStart=\nExecStart=%h/llama/llama-server \\\n  --port 7000\n")
ok(tune.server_port(tune.base_args()) == 7000, "line continuation joined")
open(os.path.join(d, "zz.conf"), "w").write("[Service]\nExecStart=\nExecStart=%h/llama/llama-server --port 1\n")
try:
    tune.base_args(); ok(False, "drop-in after tune.conf with ExecStart refused")
except SystemExit as e:
    ok(e.code == 1, "drop-in after tune.conf with ExecStart refused")

# measurement formatting, verdict thresholds
m = {"chat": 60.0, "code": 140.0, "prompt": 800.0, "prompt_tokens": 39000, "mem_stall_pct": 0.5, "score": 189.0}
ok("czat 60.0" in tune.fmt(m) and "39000" in tune.fmt(m), "format")
ok(tune.fmt({"error": "chat: timeout"}).startswith("BŁĄD"), "format error")

print(f"{fails} FAIL" if fails else f"freecode-tune: {checks} checks OK")
sys.exit(1 if fails else 0)
