#!/usr/bin/env python3
"""R1 foreign-checkout probe — a Git checkout that is NOT ours at the delivery target must survive.

pr-autofix#70 (blocker R1 of the it.6 cross-review): the collision preflight at every delivery
point only checks that `$RUNNER_TEMP/pr-autofix/.git` EXISTS — any directory with a `.git` there
is declared "our previous tool checkout" and the materialize step `rm -rf`s it. A foreign Git
checkout (origin of another project, uncommitted work inside) is therefore silently destroyed.

This probe executes the SHIPPED, UNMODIFIED `run:`-blocks (preflight + materialize) read from the
live workflow files of all four delivery points against a synthetic consumer with:

  * foreign case — a Git checkout owned by SOMEBODY ELSE at the delivery target: foreign origin,
    a committed (tracked) file, an uncommitted (untracked) file and a symlink. The contract
    (S1/S4: "a foreign directory is a refusal BEFORE any write", plus the ban on destructive
    checkout handling) requires it to survive byte-identical, whether the fixed preflight refuses
    loudly or the delivery proves a uniquely its own target.
  * empty case  — no target at all: the tool must still install at the pinned SHA (the fix must
    not turn every install into a refusal).

Fully offline: the tool repository is a local bare mirror reached through `url.<mirror>.insteadOf`,
GIT_ALLOW_PROTOCOL=file refuses any network transport, no tokens, no live profiles. Fixtures live
under `.devbaseline-sandbox/` (gitignored), never in the shared /tmp.

usage: python3 scripts/sandbox/r1-foreign-checkout-probe.py [--code <repo>] [--out <json>] [--keep]
exit 0 = contract holds (foreign checkout survived, tool installs);
     1 = defect reproduced (foreign checkout destroyed / install broken);
     2 = harness error
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

import yaml

CODEPOINTS = [
    ".github/workflows/devbaseline-callable.yml",
    ".github/workflows/autofix-callable.yml",
    ".github/workflows/ci-fix-cleanup.yml",
    "templates/batch-fix-prs.yml",
]
PREFLIGHT = "Delivery target is outside the consumer tree"
MATERIALIZE = "Materialize the pinned tool tree"
TOOL_REPO = "trained-assist/pr-autofix"
FOREIGN_ORIGIN = "https://example.invalid/another-project.git"

KEEP = "--keep" in sys.argv


def flag(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def die(msg):
    print(f"::error::{msg}")
    sys.exit(2)


def parse_args():
    here = pathlib.Path(__file__).resolve().parent
    code = flag("--code")
    code = pathlib.Path(code).resolve() if code else here.parent.parent
    out = flag("--out")
    out = pathlib.Path(out) if out else None
    return here, code, out


HERE, CODE, OUT = parse_args()

for f in CODEPOINTS:
    if not (CODE / f).is_file():
        die(f"no {f} in {CODE} — pass --code <pr-autofix checkout>")
try:
    SHA = subprocess.check_output(["git", "-C", str(CODE), "rev-parse", "HEAD"], text=True).strip()
except Exception:
    die(f"{CODE} is not a git checkout — cannot establish the pinned tool identity")

SANDBOX = pathlib.Path(os.environ.get("DEVBASELINE_SANDBOX_TMP") or CODE / ".devbaseline-sandbox")
SANDBOX.mkdir(parents=True, exist_ok=True)
if OUT is None:
    OUT = SANDBOX / "foreign-checkout-results.json"
ROOT = pathlib.Path(tempfile.mkdtemp(prefix="foreign-checkout-", dir=SANDBOX))


def git(args, cwd=None, check=True):
    return subprocess.run(["git"] + args, cwd=str(cwd) if cwd else None, check=check,
                          capture_output=True, text=True)


# Local bare mirror of the tool, rebuilt every run so it always carries the --code HEAD;
# allowAnySHA1InWant mirrors what GitHub itself permits (pinned-SHA fetches).
MIRROR = ROOT / "tool.git"
git(["clone", "--bare", "--quiet", str(CODE), str(MIRROR)])
git(["-C", str(MIRROR), "config", "uploadpack.allowAnySHA1InWant", "true"])


def fingerprint(path: pathlib.Path):
    """Content fingerprint of a directory: files by sha256, symlinks by destination,
    directories recursed, `.git` included — an identity change must be visible."""
    if not path.exists() and not path.is_symlink():
        return {"__absent__": True}
    out = {}

    def walk(p, rel):
        if p.is_symlink():
            out[rel] = "L -> " + os.readlink(p)
        elif p.is_dir():
            out[rel + "/"] = "D"
            for e in sorted(p.iterdir(), key=lambda x: x.name):
                walk(e, rel + "/" + e.name if rel else e.name)
        elif p.is_file():
            out[rel] = "F " + hashlib.sha256(p.read_bytes()).hexdigest()

    walk(path, "")
    return out


def foreign_identity(target):
    """HEAD + origin url of the target checkout, when it still is one."""
    if not (target / ".git").exists():
        return None
    head = git(["rev-parse", "HEAD"], target, check=False)
    origin = git(["config", "--get", "remote.origin.url"], target, check=False)
    return {"head": head.stdout.strip() if head.returncode == 0 else None,
            "origin": origin.stdout.strip() if origin.returncode == 0 else None}


def make_case(prefix, foreign):
    case = pathlib.Path(tempfile.mkdtemp(prefix=prefix, dir=ROOT))
    ws, rt = case / "ws", case / "rt"
    ws.mkdir()
    rt.mkdir()
    target = rt / "pr-autofix"
    if foreign:
        git(["init", "-q", str(target)])
        git(["-C", str(target), "remote", "add", "origin", FOREIGN_ORIGIN])
        (target / "foreign-tracked.txt").write_text("committed in a repo that is not ours\n")
        git(["-C", str(target), "add", "-A"])
        git(["-C", str(target), "-c", "user.email=p@example.invalid", "-c", "user.name=p",
             "commit", "-q", "-m", "foreign"])
        (target / "uncommitted-user-work.txt").write_text("must survive; unrelated git repository\n")
        (target / "link-to-work").symlink_to(ws)
    return case, ws, rt, target


def run_block(code, wf, step_name, case, ws, rt):
    jobs = yaml.safe_load((code / wf).read_text())["jobs"]
    steps = [s for j in jobs.values() for s in j.get("steps", [])]
    step = next(s for s in steps if s.get("name") == step_name)
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(case),
        "GITHUB_WORKSPACE": str(ws),
        "RUNNER_TEMP": str(rt),
        "TOOL_REPOSITORY": TOOL_REPO,
        "TOOL_SHA": SHA,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "url." + str(MIRROR) + ".insteadOf",
        "GIT_CONFIG_VALUE_0": "https://github.com/" + TOOL_REPO + ".git",
        "GIT_ALLOW_PROTOCOL": "file",
        "GIT_TERMINAL_PROMPT": "0",
    }
    return subprocess.run(["bash", "-e", "-c", step["run"]], cwd=str(ws), env=env,
                          capture_output=True, text=True)


def scenario(wf, foreign):
    case, ws, rt, target = make_case("r1-foreign-" if foreign else "r1-empty-", foreign)
    fp_before = fingerprint(target)
    ident_before = foreign_identity(target) if foreign else None
    ws_before = fingerprint(ws)

    pre = run_block(CODE, wf, PREFLIGHT, case, ws, rt)
    pre_exit = pre.returncode
    mat_exit = None
    output = (pre.stdout + pre.stderr)[-1500:]
    if pre_exit == 0:
        mat = run_block(CODE, wf, MATERIALIZE, case, ws, rt)
        mat_exit = mat.returncode
        output = (pre.stdout + pre.stderr + mat.stdout + mat.stderr)[-1500:]

    fp_after = fingerprint(target)
    ident_after = foreign_identity(target) if foreign else None
    ws_after = fingerprint(ws)

    if foreign:
        survived = fp_after == fp_before and ident_after == ident_before
        ok = survived and ws_after == ws_before
        detail = ("checkout byte-identical" if survived
                  else ("target vanished (rm -rf)" if fp_after.get("__absent__")
                        else "target contents changed"))
        destroyed = [k for k in fp_before if fp_after.get(k) != fp_before[k]]
        added = [k for k in fp_after if k not in fp_before]
        evidence = {"identity_before": ident_before, "identity_after": ident_after,
                    # the owner's files first: they are the sentinel, .git internals only
                    # confirm the substitution; added paths count = the tool tree that replaced it
                    "destroyed_paths": sorted(destroyed,
                                              key=lambda k: (k.startswith(".git"), k))[:24],
                    "destroyed_count": len(destroyed),
                    "added_paths_count": len(added)}
    else:
        installed = (mat_exit == 0 and (target / ".git").exists()
                     and git(["rev-parse", "HEAD"], target, check=False).stdout.strip() == SHA)
        ok = pre_exit == 0 and installed and ws_after == ws_before
        detail = "tool installed at the pinned SHA" if installed else f"not installed (preflight {pre_exit}, delivery {mat_exit})"
        evidence = {"head_after": git(["rev-parse", "HEAD"], target, check=False).stdout.strip()
                    if (target / ".git").exists() else None}

    installed_field = None if foreign else installed

    if not KEEP:
        shutil.rmtree(case, ignore_errors=True)
    return {"workflow": wf, "variant": "foreign" if foreign else "empty",
            "preflight_exit": pre_exit, "delivery_exit": mat_exit,
            "survived": survived if foreign else None,
            "installed": installed_field,
            "ok": ok, "detail": detail, "evidence": evidence, "output": output}


results = []
print(f"code: {CODE}\nsha: {SHA}\ntransport: local bare mirror via url.insteadOf; GIT_ALLOW_PROTOCOL=file (no network)")
for foreign in (True, False):
    for wf in CODEPOINTS:
        r = scenario(wf, foreign)
        results.append(r)
        print(f"{'ok  ' if r['ok'] else 'FAIL'} {wf} [{r['variant']}] "
              f"preflight={r['preflight_exit']} delivery={r['delivery_exit']} — {r['detail']}")

foreign_cases = [r for r in results if r["variant"] == "foreign"]
empty_cases = [r for r in results if r["variant"] == "empty"]
foreign_all_survived = all(r["ok"] for r in foreign_cases)
empty_all_installed = all(r["ok"] for r in empty_cases)
verdict = ("clean — a foreign checkout at the delivery target survives byte-identical in all four "
           "points and the tool still installs into an empty target"
           if foreign_all_survived and empty_all_installed else
           "DEFECT — " + "; ".join(
               [f"foreign checkout destroyed at {sum(1 for r in foreign_cases if not r['ok'])}/4 delivery points"
                if not foreign_all_survived else "",
                f"install broken at {sum(1 for r in empty_cases if not r['ok'])}/4 delivery points"
                if not empty_all_installed else ""]).strip("; "))

report = {"probe": "r1-foreign-checkout-probe", "code": str(CODE), "tool_sha": SHA,
          "transport": "local bare mirror via url.insteadOf; GIT_ALLOW_PROTOCOL=file (no network)",
          "cases": results, "foreign_all_survived": foreign_all_survived,
          "empty_all_installed": empty_all_installed, "verdict": verdict}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(report, indent=2) + "\n")
print(f"\nverdict: {verdict}\nresults: {OUT}")
if not KEEP:
    shutil.rmtree(ROOT, ignore_errors=True)
sys.exit(0 if foreign_all_survived and empty_all_installed else 1)
