#!/usr/bin/env python3
"""Offline test of freecode: the ENV block in AGENTS.md is rewritten only when facts change;
check() flags every config path that would send session content off the machine.
No opencode, no model server — HOME and config dirs are temporary.
Usage: python3 tests/freecode.test.py [path/to/freecode]"""
import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "freecode", "freecode")
tmp = tempfile.mkdtemp()
os.environ.update(HOME=tmp, XDG_CONFIG_HOME=f"{tmp}/cfg")
os.environ.pop("OPENCODE_CONFIG_DIR", None)
sys.dont_write_bytecode = True
loader = importlib.machinery.SourceFileLoader("freecode", SRC)
spec = importlib.util.spec_from_loader("freecode", loader)
assert spec
fc = importlib.util.module_from_spec(spec)
loader.exec_module(fc)

fails = 0
checks = 0


def ok(cond, name):
    global fails, checks
    checks += 1
    if not cond:
        fails += 1
        print("FAIL", name)


def age(path, seconds):
    t = time.time() - seconds
    os.utime(path, (t, t))


def agents():
    return open(fc.AGENTS_FILE, encoding="utf-8").read()


URL = "http://127.0.0.1:9/v1"
ctx = {"value": None}
fc.server_ctx = lambda url: ctx["value"]          # no network
fc.info = lambda s: None
os.makedirs(fc.OC_DIR)
cfg = os.path.join(fc.OC_DIR, "opencode.json")
with open(cfg, "w") as f:
    json.dump({"model": "local/m1", "provider": {"local": {"options": {"baseURL": URL}}}}, f)
with open(fc.AGENTS_FILE, "w") as f:
    f.write("# Rules\n\nkeep me\n")
work = os.path.join(tmp, "work")
os.makedirs(work)

# first write: block appended, rest of the file untouched
ctx["value"] = 32768
ok(fc.write_env() is True, "first write reports a change")
ok(agents().startswith("# Rules\n\nkeep me\n"), "rest of AGENTS.md untouched")
ok("`m1` at " + URL + ", context 32768 tokens" in agents(), "model line with context")
ok(os.path.isfile(fc.ENV_STAMP), "stamp written")

# a day later, same facts: file not rewritten (mtime unchanged), stamp refreshed
for p in (fc.AGENTS_FILE, fc.ENV_STAMP, cfg):
    age(p, 2 * 86400 + (0 if p != cfg else 3600))
before = os.path.getmtime(fc.AGENTS_FILE)
fc.refresh_env(work)
ok(os.path.getmtime(fc.AGENTS_FILE) == before, "unchanged facts: AGENTS.md mtime kept")
ok(time.time() - os.path.getmtime(fc.ENV_STAMP) < 60, "unchanged facts: stamp refreshed")

# only the date in the header differs: still no rewrite
text = agents()
header = next(l for l in text.splitlines() if l.startswith("## Environment"))
with open(fc.AGENTS_FILE, "w") as f:
    f.write(text.replace(header, "## Environment (auto: `freecode --env`, 2000-01-01)"))
age(fc.AGENTS_FILE, 2 * 86400)
age(fc.ENV_STAMP, 2 * 86400)
before = os.path.getmtime(fc.AGENTS_FILE)
fc.refresh_env(work)
ok(os.path.getmtime(fc.AGENTS_FILE) == before, "stale date alone: no rewrite")
ok("2000-01-01" in agents(), "stale date alone: header kept")

# fresh stamp: no check at all
called = []
real = fc.write_env
fc.write_env = lambda *a, **k: called.append(1)
fc.refresh_env(work)
ok(not called, "fresh stamp: no check")
fc.write_env = real

# server asleep: known context of the same model is kept, no rewrite
ctx["value"] = None
age(fc.ENV_STAMP, 2 * 86400)
before = os.path.getmtime(fc.AGENTS_FILE)
fc.refresh_env(work)
ok(os.path.getmtime(fc.AGENTS_FILE) == before, "server asleep: no rewrite")
ok("context 32768 tokens" in agents(), "server asleep: context kept")

# context really changed: rewritten
ctx["value"] = 65536
age(fc.ENV_STAMP, 2 * 86400)
fc.refresh_env(work)
ok("context 65536 tokens" in agents() and "32768" not in agents(), "context change: rewritten")
ok("2000-01-01" not in agents(), "rewrite refreshes the date")

# config changed (other model) with server asleep: rewritten, old context not carried over
ctx["value"] = None
with open(cfg, "w") as f:
    json.dump({"model": "local/m2", "provider": {"local": {"options": {"baseURL": URL}}}}, f)
fc.refresh_env(work)
ok("`m2` at " + URL in agents() and "context" not in agents().split("`m2`")[1].split("\n")[0],
   "model change: rewritten without stale context")
ok(agents().count(fc.ENV_START) == 1 and agents().count(fc.ENV_END) == 1, "single ENV block")
ok(agents().startswith("# Rules\n\nkeep me\n"), "rest of AGENTS.md still untouched")

# no AGENTS.md: nothing created
os.remove(fc.AGENTS_FILE)
fc.refresh_env(work)
ok(not os.path.exists(fc.AGENTS_FILE), "no AGENTS.md: not created")

# ── check(): everything that could send session content off the machine ──────────────────────
os.environ["OPENCODE_DISABLE_PROJECT_CONFIG"] = "1"
os.environ.pop("FREECODE_HOSTS", None)
os.environ.pop("FREECODE_HOSTY", None)
BASE = {"model": "local/m1", "small_model": "local/m1", "enabled_providers": ["local"],
        "provider": {"local": {"options": {"baseURL": URL}, "models": {"m1": {}}}}}


def problems(extra=None, provider=None):
    c = json.loads(json.dumps(BASE))
    c.update(extra or {})
    c["provider"]["local"].update(provider or {})
    with open(cfg, "w") as f:
        json.dump(c, f)
    return fc.check(work)[0]


def flagged(needle, **kw):
    return any(needle in p for p in problems(**kw))


ok(problems() == [], "clean local config passes")
ok(problems({"share": "disabled"}) == [] and problems({"share": "manual"}) == [], "share disabled/manual passes")
ok(flagged("share", extra={"share": "auto"}), "share auto flagged")
ok(flagged("share", extra={"autoshare": True}), "legacy autoshare flagged")
ok(flagged("enterprise.url", extra={"enterprise": {"url": "https://corp.example.com"}}), "enterprise url flagged")
ok(problems({"enterprise": {"url": "http://127.0.0.1:4000"}}) == [], "local enterprise url passes")
remote = {"type": "remote", "url": "https://mcp.example.com/sse"}
ok(flagged("MCP `x`", extra={"mcp": {"x": remote}}), "remote MCP flagged")
ok(problems({"mcp": {"x": dict(remote, enabled=False)}}) == [], "disabled remote MCP passes")
ok(problems({"mcp": {"x": {"type": "remote", "url": "http://localhost:3000/mcp"}}}) == [], "remote MCP on localhost passes")
ok(problems({"mcp": {"x": {"type": "local", "command": ["npx", "y"]}}}) == [], "local MCP passes")
ok(flagged("provider.local.api", provider={"api": "https://api.example.com/v1"}), "provider api flagged")
ok(flagged("models.m1.provider.api",
           provider={"models": {"m1": {"provider": {"api": "https://api.example.com/v1"}}}}), "model provider.api flagged")
ok(flagged("models.m1.options.baseURL",
           provider={"models": {"m1": {"options": {"baseURL": "https://api.example.com/v1"}}}}), "model baseURL flagged")
ok(problems(provider={"api": "http://127.0.0.1:8080/v1"}) == [], "local provider api passes")
os.environ["FREECODE_HOSTS"] = "mcp.example.com"
ok(problems({"mcp": {"x": remote}}) == [], "FREECODE_HOSTS allows a remote MCP host")
os.environ.pop("FREECODE_HOSTS")
ok(len(problems({"share": "auto", "enterprise": {"url": "https://corp.example.com"}, "mcp": {"x": remote}},
                provider={"models": {"m1": {"provider": {"api": "https://api.example.com/v1"}}}})) == 4,
   "all four leaks reported together")

# MCP entries merge across files: a project file must not hide a remote server from the global one
os.environ.pop("OPENCODE_DISABLE_PROJECT_CONFIG")
problems({"mcp": {"x": remote}})
with open(os.path.join(work, "opencode.json"), "w") as f:
    json.dump({"mcp": {"y": {"type": "local", "command": ["true"]}}}, f)
ok(any("MCP `x`" in p for p in fc.check(work)[0]), "project mcp does not hide global remote MCP")
with open(os.path.join(work, "opencode.json"), "w") as f:
    json.dump({"mcp": {"x": {"enabled": False}}}, f)
ok(fc.check(work)[0] == [], "project file can disable the remote MCP")

print(f"freecode: {checks} checks " + ("OK" if not fails else f"— {fails} FAILED"))
sys.exit(1 if fails else 0)
