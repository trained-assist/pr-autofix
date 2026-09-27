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
