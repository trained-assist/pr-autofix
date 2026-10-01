# pr-autofix

Automated CI failure fixer for GitHub PRs. When CI fails on a pull request, this pipeline:

1. **Diagnoses** the root cause using the CI log
2. **Patches** the code with cheap/free LLMs via the [trained-assist-llm-ladder](https://github.com/trained-assist/trained-assist-llm-ladder) worker (model `free-ladder`: OpenCode Go → OpenRouter `:free`), fed a structurally compressed diff
3. **Creates** a new `fix/ci-*` branch + PR that auto-merges when CI passes
4. **Closes** the original broken PR once the fix is merged

No code ever leaves GitHub Actions — your tokens stay in your repo secrets.

## Quick setup (3 steps)

### 1. Get secrets

**LLM_LADDER_TOKEN** — bearer token for the trained-assist-llm-ladder worker (`https://llm-ladder.trainedassist.store`). All model calls go there; the rung order, provider keys, per-model health and failover live in the worker, so pr-autofix carries no model ladder of its own. Repo variable `AUTOFIX_LADDER` picks another ladder name (default `free-ladder`). (`OPENROUTER_API_KEY` / `OPENCODE_GO_API_KEY` are ignored since v1.6.0.)

**AUTOFIX_PAT** — GitHub Fine-Grained Personal Access Token:
- Go to: Settings → Developer settings → Personal access tokens → Fine-grained tokens
- Repository access: select your repo
- Permissions: `Contents: Read and write`, `Pull requests: Read and write`

Add both to your repo: **Settings → Secrets and variables → Actions → New repository secret**

### 2. Add autofix job to your CI workflow

```yaml
# In your .github/workflows/ci.yml, add this job:

autofix:
  needs: [ci]                          # ← your CI jobs that must finish first
  if: |
    always() &&
    github.event_name == 'pull_request' &&
    !github.event.pull_request.draft &&
    needs.ci.result == 'failure' &&
    !startsWith(github.head_ref, 'fix/ci-')
  permissions:
    contents: write
    pull-requests: write
  uses: trained-assist/pr-autofix/.github/workflows/autofix-callable.yml@v1
  with:
    pr_number: ${{ github.event.pull_request.number }}
    original_branch: ${{ github.head_ref }}
    run_id: ${{ github.run_id }}
  secrets:
    llm_ladder_token: ${{ secrets.LLM_LADDER_TOKEN }}
    gh_token: ${{ secrets.AUTOFIX_PAT || github.token }}
```

### 3. Add cleanup workflow (optional but recommended)

Copy [`templates/ci-fix-cleanup.yml`](templates/ci-fix-cleanup.yml) into your `.github/workflows/`. It automatically closes the original broken PR when the fix PR is merged.

## How it works

**Trust model in one line:** nobody is trusted except CI. The model's words are never read as
facts — what changed is taken from `git`, whether it works is decided by the fix PR's CI, and a
deterministic gate makes sure a fix cannot weaken what CI checks.

### The path of one run

```
CI fails on PR #N
  └─ autofix job (this reusable workflow), checks out the PR head
       1. Stage 0 — is the PR purpose clear? (else stop, comment)
       2. Pre-stages (deterministic) — branch behind / missing permissions / known conflicts
            └─ applied? → skip to 5
       3. Stage 1 — diagnose from the CI log + diff (LLM, one call)
       4. Fix — one of:
            • AUTOFIX_AGENT=1 → coding agent (opencode) edits files, runs the failing tests, iterates
            • default         → Stage 2 (read file excerpts) + Stage 3 (search/replace edits)
       5. What changed = `git add -A && git diff --cached`   ← from git, not from the model
       6. Diff gate (deterministic) — reject → no PR, comment, `fail:diff_rejected`
       7. autofix commits it, pushes a NEW branch fix/ci-<branch>-<ts>, opens a PR, enables auto-merge,
          closes PR #N ("superseded by …")
  └─ the fix PR's own CI runs the full suite → green: auto-merged; red: autofix runs again on it
     (fix/ci-* branches are excluded from the retry loop by the caller's `if:`)
```

The original branch is never pushed to. Every AI call (stages 0–3 and the agent) goes to the
[llm-ladder worker](https://github.com/trained-assist/trained-assist-llm-ladder) with
`LLM_LADDER_TOKEN`; the ladder name is the repo variable `AUTOFIX_LADDER` (default `free-ladder`).

### Pre-stages (deterministic, instant)
- A: Branch out of date → `git merge origin/main` + AI conflict resolution if needed
- B: Missing workflow permissions → patch the YAML automatically
- C: Cloudflare DO migration conflict → diagnose and report (can't auto-fix)

### Fix step, default: single-shot stages
- Stage 1: Diagnose root cause + identify files to examine
- Stage 2: Read line-numbered excerpts of those files (around PR-changed and log-cited lines; small files whole). If the model says `MISSING_CONTEXT: <file>`, it gets the full file and retries once
- Stage 3: Return exact search/replace edits (`{file, old_str, new_str}`), validated and applied atomically — no hunk arithmetic for the model to get wrong; one retry with the mismatch errors. A unified diff answer still works (git apply → `--recount` → `patch --fuzz=3`)
- Then `npm test` runs locally; a failure reverts the patch (`fail:ai_tests_fail`)

### Fix step, `AUTOFIX_AGENT=1`: coding agent
After Stage 1, [opencode](https://opencode.ai) replaces Stages 2–3. It gets the diagnosis, the
compressed log and diff, and works in the checked-out PR: reads files, edits them, runs the
failing tests, repeats (`AUTOFIX_AGENT_TIMEOUT_MIN`, default 20).

- **Model access = the same endpoint + key.** opencode is given a config with one
  OpenAI-compatible provider: `baseURL = <llm-ladder worker>/v1`, `apiKey = {env:LLM_LADDER_TOKEN}`
  (read from env, never written to a file), model = the ladder name. No extra secret.
- **The agent only edits files.** It does not commit, push or open anything — autofix does that
  afterwards (step 5–7 above):
  - the GitHub write token is not in the agent's env, and the credentials `actions/checkout`
    persisted in the repo git config are hidden for the agent's run (restored after), so a
    `git push` from the agent has no credentials;
  - its `HOME` is a scratch dir, so it cannot change the git config autofix uses afterwards;
  - commits it makes anyway are folded back into the working tree; `.github/workflows/`
    edits are dropped; autofix commits/pushes with hooks disabled.
- No local full `npm test` in this mode (it mostly flagged unrelated failures, see #21): the
  agent runs the failing tests itself, the fix PR's CI runs everything.

### Diff gate (every AI/agent fix, before the commit)
Rejects the fix — no PR is created — when the diff:
- disables or focuses a test (`.skip` / `.only` / `.todo`, `xit`, `{ skip: true }`, pytest skip/xfail, `t.Skip`, `@Disabled`),
- removes assertions from a test file, or deletes a test file,
- touches `.github/workflows/`,
- changes a lock file while the CI log is not about dependencies,
- is too big (`AUTOFIX_GATE_MAX_FILES`, default 15; `AUTOFIX_GATE_MAX_LINES`, default 400).

Pre-stage merges are exempt (their diff is `main`'s, not an AI fix).

### Input compression (every LLM stage)
The PR diff is parsed into hunks and shrunk PR-Agent style — asymmetric context (3 lines before / 1 after), deletion-only hunks and lock/generated/binary files dropped (listed by name), then zero context + collapsed removals, additions cut last, all within a ~4k-token budget. Files cited in the CI log go first. The CI log itself is compressed too (timestamps/ANSI/`##[group]` bodies/runner preamble/post-job cleanup stripped, error lines ±3 kept first, ~2.5k-token budget); deterministic pre-stage checks still see the raw log. Stage 3 sees the same line-numbered file excerpts as stage 2. Models are told the input is compressed and must say what's missing instead of guessing.

### Stats
Every run writes `ci-fixer-stats.json` (uploaded as the `ci-fixer-stats` artifact) and a step
summary: category, reason, token usage/cost per model. Categories are listed at the top of
`scripts/autofix.mjs` — e.g. `success:agent`, `success:ai`, `success:pre_a_merge`,
`fail:diff_rejected`, `fail:agent_no_change`, `fail:ai_model_error`. An agent error/timeout falls back to Stages 2–3 (stats field `agent_fallback`).

Each record also carries the **receipt** (AC-44): `rule_id` + `gate_violations` (which rule fired, on
which path), `tool` (name, version, commit — the version is the workflow ref the caller pinned),
`attempt_count`, `patch_refs`, `included_paths` / `omitted_paths`, `budget`, `retention`, and
`credentials` as **names**. Every one of those keys is optional, so records written before this
contract stay valid and old consumers keep working. `rule_id` always comes from the fixed
dictionary in `scripts/autofix.mjs` — a new rule is a new release tag, never a new ad-hoc string.

### Repo variables

| Variable | Default | Effect |
|---|---|---|
| `AUTOFIX_LADDER` | `free-ladder` | llm-ladder ladder for every model call (stages and agent) |
| `AUTOFIX_AGENT` | off | `1` = coding agent does the fix step |
| `AUTOFIX_AGENT_TIMEOUT_MIN` | `20` | agent time limit |
| `AUTOFIX_GATE_MAX_FILES` / `AUTOFIX_GATE_MAX_LINES` | `15` / `400` | diff gate size limits |

## Batch fixing existing broken PRs

Copy [`templates/batch-fix-prs.yml`](templates/batch-fix-prs.yml) into your `.github/workflows/`, then:

```bash
gh workflow run batch-fix-prs.yml --field pr_numbers="42,41,39"
```

## What it can and can't fix

**Can fix:**
- TypeScript/ESLint errors introduced by the PR
- Missing permissions in workflow YAML
- Branch out of date with main (merge conflicts)
- Simple test failures caused by the PR's own changes

**Cannot fix:**
- Flaky tests unrelated to the PR
- Infrastructure/network failures
- Complex architectural conflicts (reported to humans)
- Cloudflare Durable Object migration issues

## Security

- Your `LLM_LADDER_TOKEN` and `AUTOFIX_PAT` never leave GitHub Actions
- The fixer only reads the CI log, your source files, and git history
- It never pushes code to `main` or the original branch — a change it authors (conflict resolution,
  AI patch) always goes to a new `fix/ci-*` branch/PR
- A branch that is only behind `main` and merges cleanly is **not** re-created as a new PR: the fixer
  calls GitHub's update-branch on the original PR (pinned with `expected_head_sha`), so CI re-runs on
  the same PR. Needs `AUTOFIX_PAT` — a push made with `GITHUB_TOKEN` does not trigger a new CI run
- PRs marked `draft` are skipped
- `fix/ci-*` branches are never re-fixed (prevents infinite loops)

---

## Development baseline (inventory, profiles, adapter)

`scripts/devbaseline.mjs` gives every participating repository the same four answers: **how is it
checked, how is it fixed, how is it verified, and what does the log say.** The point is not a
prettier report — it is that merge stops failing for the reason "this repo has no CI or staging",
and that a log can prove how its result was assembled.

```sh
node scripts/devbaseline.mjs validate --all-profiles          # do the shipped profiles hold the contract?
node scripts/devbaseline.mjs validate --repo <dir>            # which profile does this repo get, and why?
node scripts/devbaseline.mjs verify   --repo <dir> --log f.json   # check → fix → verify again
node scripts/devbaseline.mjs context  --manifest <f>         # fresh | stale | missing
node scripts/devbaseline.mjs inventory --out <dir>           # the coverage table + construction tasks
node scripts/devbaseline.mjs check-docs --dir <dir>          # links resolve, JSON parses, H1 present
node scripts/devbaseline.mjs gate     --repo <dir>          # verify + the declared staging.command
node scripts/devbaseline.mjs payload-manifest --check       # is the payload we ship what we declared?
node scripts/devbaseline.mjs payload-verify                 # is this tree the declared payload?
```

**`gate` is the only thing a merge gate should call.** `verify`'s exit codes stay what they always
were (they are a contract), but the question "does this block the merge?" has exactly one owner:
`gate`, where **only exit 0 is green**. `needs_human` (2) — the profile has no fixer, or `fix.cap`
is spent — is a real gap that nobody is closing automatically, so it blocks and keeps its own
`outcome`/`reason_code` in the log record. A `staging.command` declared by the repository is
actually executed, and its non-zero exit blocks even when `verify` is green.

**The payload is declared, not listed.** `payload.manifest.json` records every file the CLI needs,
with its hash; the loader lays the tree out by that manifest, checks it in BOTH directions (missing
*and* undeclared) and then **runs** the payload. Adding a module without regenerating the manifest
fails the gate instead of shipping a CLI that cannot start — the failure mode this replaces, where
a flat download plus `node --check` produced a green check and a broken tool.

Exit codes are the contract: `validate` 0/3 · `verify` 0 pass-or-no_change, 1 controlled failure,
2 needs_human, 3 invalid config · `context` 0 fresh, 2 stale, 3 missing · `inventory` 0, or 4 with
`--strict` when a repository is unreadable · `check-docs` 0/1.

### Profiles, and why the adapter is optional

`profiles/*.json` are the single source of truth, shipped here: `docs`, `node`, `python`, `mixed`,
`minimal`. A repository does **not** have to carry a config file — the profile is derived from the
file tree (presence of `package.json`, `pyproject.toml`/`setup.py`, or markdown, first match wins).
`.devbaseline.json` exists only to pin what cannot be derived: the check command, the staging
command, the autofix ref, the credential **names**. The coverage table records `adapter:
derived | file` so a reader always knows which of the two a row was.

A docs-only repository gets `check.build: null` and no application build — its check is Markdown,
schema and context, not a compiler. The `minimal` profile's check is an explicit no-op marked
`missing`, so a repository with no entrypoint shows up as a gap instead of a green tick.

There is deliberately no `extends` in profiles. Five self-contained files cost less than a
resolution order, and a profile-resolution order is exactly the class of bug a coverage table
cannot explain when it goes wrong.

### Credentials

Names only, never values. A credential-shaped string in an adapter, a coverage row or a log record
is a **schema violation**, not a warning — `scripts/lib/devbaseline/secrets.mjs` refuses to write
one, and the inventory refuses to emit a table containing one.

### One command instead of fifteen workflows

```yaml
devbaseline:
  uses: trained-assist/pr-autofix/.github/workflows/devbaseline-callable.yml@v1
  with:
    mode: ci          # or: staging-gate
```

`mode=ci` answers "does this repository still pass its own check?"; `mode=staging-gate` also writes
the repository's inventory row and construction tasks into the step summary. The workflow needs no
token, writes nothing back into the caller, and takes its code from the ref you pinned it at.

### pr-autofix's own staging gate

The required check name is **`staging-gate`** and it is part of this repository's contract:
`software-engineering-playbooks` must require that exact name as a merge condition. Renaming it is
a breaking cross-repository change, so fix the consumer instead.

`ci.yml` runs three jobs: `selftest` (the existing contract test) and `staging-gate`, whose body is
`node scripts/sandbox/z01-devbaseline.mjs` — the same scenario rehearsal used during development.
pr-autofix has no production service, so **staging here is a rehearsal of the battle path on
fixtures, not a cloud check**, and it is never described as one: `node --check` on every script,
every profile against its contract, an end-to-end `verify` (expected controlled failure), and a
check that every `*-callable.yml` really declares `on: workflow_call` — the last one is the
regression guard for the cleanup installer that used to point at a non-callable file. It also
rehearses the delivery boundary and the gate through the consumer's path
(`consumer-boundary.mjs`, `repro-r3-gate.mjs`, `repro-r5-resolver.mjs`, `repro-r4-cleanup.mjs`) and
asserts the payload manifest is current.

`repository-context` runs with `if: always()` — the report about the repository's state has to
appear *after* a failed check, which is exactly when it is worth reading. It consumes the
**delivered** payload (`payload-verify`) rather than the checkout, so it cannot be green while the
artifact handed to consumers is broken, and it asserts that a manifest from a foreign commit reads
`stale`, never `fresh`.

### Rehearsing the whole scenario locally

```sh
node scripts/sandbox/z01-devbaseline.mjs           # one command, deterministic pass/fail
node scripts/sandbox/z01-devbaseline.mjs --keep    # keep the fixtures for inspection
```

Level **S3** — fixtures, mocked externals, fully offline (proxies point at a dead port and `PATH`
is stripped to `node` and `git`, so "the inventory does not reach the network" and "construction
tasks do not file an issue" are properties of the run rather than claims in a comment). Artifacts
land in `.devbaseline-sandbox/` (git-ignored); override with `DEVBASELINE_SANDBOX_TMP`. S5
(one procedure setup → run → evidence → teardown) and S8 (coverage drift) are owned by other
repositories and are reported as `skip` with their owner, never as a green tick.
